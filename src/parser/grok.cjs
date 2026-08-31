'use strict';

// ATTRIBUT — Grok Build session parser (allowlist extractor).
//
// HARD CONSTRAINT: this module reads ONLY the allowlisted files in a Grok
// session directory and returns ONLY the contract `grokPayload`. It NEVER
// opens chat_history.jsonl, system_prompt.txt, or prompt_context.json. For
// updates.jsonl it JSONL-walks and copies ONLY numeric fields under
// params.update.usage (last usage object wins; cumulative). Message bodies,
// tool args, prompts, and lastAssistantMessage are dropped unread.
//
// Allowlisted files:
//   summary.json  info.id, info.cwd, generated_title, current_model_id,
//                 created_at, updated_at/last_active_at, reasoning_effort,
//                 agent_name, num_messages
//   signals.json  occupancy + counters (never billed as tokens_in)
//   events.jsonl  tool_started/tool_completed names only; turn_started/turn_ended
//   updates.jsonl params.update.usage numeric fields only
//
// Token disjoint contract (Grok: cachedRead ⊆ inputTokens, reasoning ⊆ output):
//   tokens_in             = inputTokens − cachedReadTokens
//   cache_read_tokens     = cachedReadTokens
//   cache_creation_tokens = cacheCreationTokens
//   tokens_out            = outputTokens   (keep whole; reasoning is a slice)
//   grok.reasoning_output_tokens = reasoningTokens
//   grok.effort                  = summary.reasoning_effort
//   grok.cost_usd_ticks          = costUsdTicks (pass-through)
//   grok.context_*               = signals occupancy, never priced
//
// title is the one authorized content-derived field (generated_title, cap 200).
// Line metrics stay NULL — no classified-diff source.
//
// Subagents: Grok writes each worker to `<session>/subagents/<childId>/` as
// {meta.json, output.json} AND, separately, as a COMPLETE top-level session dir
// of its own. Only meta.json is allowlisted, and from it only the numeric /
// label fields below — `prompt` is CONTENT and is never copied. output.json is
// CONTENT end-to-end and is NEVER opened.
//   meta.json  child_session_id, child_cwd, subagent_type, description, status,
//              started_at, completed_at, duration_ms, tool_calls, turns,
//              effective_model_id

const fs = require('fs');
const path = require('path');
const os = require('os');

const { cap, expandHome } = require('./claude_code.cjs');

const CAP_TITLE = 200;
const CAP_PATH = 256;
const CAP_REPO = 2000;
const CAP_LABEL = 128;

const ALLOWED_FILES = new Set(['summary.json', 'signals.json', 'events.jsonl', 'updates.jsonl']);

// The ONLY file the parser may open inside `<session>/subagents/<childId>/`.
// Its sibling output.json is the worker's verbatim answer — never opened.
const SUBAGENT_DIR = 'subagents';
const SUBAGENT_META = 'meta.json';

const USAGE_INT_KEYS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedReadTokens',
  'cacheCreationTokens',
  'reasoningTokens',
  'modelCalls',
  'apiDurationMs',
  'costUsdTicks',
  'numTurns',
];

const NULL_STRUCT = {
  lines_code_added: null,
  lines_comment_added: null,
  lines_blank_added: null,
  lines_code_removed: null,
  lines_comment_removed: null,
  lines_blank_removed: null,
  added_char_n: null,
  added_char_sum: null,
  added_char_sumsq: null,
};

function intOrNull(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.trunc(v));
}

function intOrZero(v) {
  const n = intOrNull(v);
  return n == null ? 0 : n;
}

function toIso(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

// Copy ONLY the billed numeric usage fields. Nested modelUsage keeps numbers
// per model id internally; the payload never emits it.
function pickUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const out = {};
  let any = false;
  for (const k of USAGE_INT_KEYS) {
    const n = intOrNull(usage[k]);
    if (n != null) {
      out[k] = n;
      any = true;
    }
  }
  const mu = usage.modelUsage;
  if (mu && typeof mu === 'object') {
    const picked = {};
    for (const [modelId, rec] of Object.entries(mu)) {
      if (!rec || typeof rec !== 'object') continue;
      const inner = {};
      let innerAny = false;
      for (const k of USAGE_INT_KEYS) {
        const n = intOrNull(rec[k]);
        if (n != null) {
          inner[k] = n;
          innerAny = true;
        }
      }
      if (innerAny) picked[modelId] = inner;
    }
    if (Object.keys(picked).length) {
      out.modelUsage = picked;
      any = true;
    }
  }
  return any ? out : null;
}

function disjointTokens(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      tokens_in: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      tokens_out: null,
      reasoning_output_tokens: null,
      cost_usd_ticks: null,
    };
  }
  const input = intOrZero(usage.inputTokens);
  const cached = intOrZero(usage.cachedReadTokens);
  return {
    tokens_in: Math.max(0, input - cached),
    cache_read_tokens: cached,
    cache_creation_tokens: intOrZero(usage.cacheCreationTokens),
    tokens_out: intOrZero(usage.outputTokens),
    reasoning_output_tokens: intOrZero(usage.reasoningTokens),
    cost_usd_ticks: intOrNull(usage.costUsdTicks),
  };
}

function sessionFile(dir, name) {
  if (!ALLOWED_FILES.has(name)) {
    throw new Error(`Grok parser refused non-allowlisted file: ${name}`);
  }
  return path.join(dir, name);
}

function readJsonFile(abs, { required } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if (!required && err && err.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw);
}

function pickSummary(raw) {
  const info = raw && raw.info && typeof raw.info === 'object' ? raw.info : {};
  return {
    id: typeof info.id === 'string' && info.id ? info.id : null,
    cwd: typeof info.cwd === 'string' && info.cwd ? info.cwd : null,
    generated_title: typeof raw.generated_title === 'string' ? raw.generated_title : null,
    current_model_id: typeof raw.current_model_id === 'string' ? raw.current_model_id : null,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    last_active_at: raw.last_active_at,
    reasoning_effort: typeof raw.reasoning_effort === 'string' ? raw.reasoning_effort : null,
    num_messages: intOrNull(raw.num_messages),
  };
}

function pickSignals(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const toolsUsed = Array.isArray(raw.toolsUsed)
    ? raw.toolsUsed.filter((n) => typeof n === 'string' && n)
    : [];
  return {
    contextTokensUsed: intOrNull(raw.contextTokensUsed),
    contextWindowTokens: intOrNull(raw.contextWindowTokens),
    toolCallCount: intOrNull(raw.toolCallCount),
    toolsUsed,
    primaryModelId: typeof raw.primaryModelId === 'string' ? raw.primaryModelId : null,
    sessionDurationSeconds: intOrNull(raw.sessionDurationSeconds),
    turnCount: intOrNull(raw.turnCount),
  };
}

function eventType(o) {
  if (!o || typeof o !== 'object') return null;
  if (typeof o.type === 'string') return o.type;
  if (typeof o.event === 'string') return o.event;
  if (o.params && typeof o.params.event === 'string') return o.params.event;
  return null;
}

function eventToolName(o) {
  if (!o || typeof o !== 'object') return null;
  if (typeof o.tool_name === 'string' && o.tool_name) return o.tool_name;
  if (o.params && typeof o.params.tool_name === 'string' && o.params.tool_name) {
    return o.params.tool_name;
  }
  return null;
}

function scanEvents(abs) {
  const toolUseCounts = new Map();
  let turnStarted = 0;
  let turnEnded = 0;
  let sawStarted = false;
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { toolUseCounts, turnStarted: 0, turnEnded: 0 };
    }
    throw err;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const type = eventType(o);
    if (type === 'turn_started') {
      turnStarted += 1;
      continue;
    }
    if (type === 'turn_ended') {
      turnEnded += 1;
      continue;
    }
    if (type === 'tool_started') {
      sawStarted = true;
      const name = cap(eventToolName(o), CAP_LABEL);
      if (name) toolUseCounts.set(name, (toolUseCounts.get(name) || 0) + 1);
      continue;
    }
    if (type === 'tool_completed' && !sawStarted) {
      const name = cap(eventToolName(o), CAP_LABEL);
      if (name) toolUseCounts.set(name, (toolUseCounts.get(name) || 0) + 1);
    }
  }
  return { toolUseCounts, turnStarted, turnEnded };
}

function scanUsageJsonl(abs) {
  let last = null;
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const usage = o && o.params && o.params.update && o.params.update.usage;
    const picked = pickUsage(usage);
    if (picked) last = picked;
  }
  return last;
}

function sessionsRoot() {
  if (process.env.GROK_SESSIONS_DIR) return expandHome(process.env.GROK_SESSIONS_DIR);
  const home = process.env.GROK_HOME
    ? expandHome(process.env.GROK_HOME)
    : path.join(os.homedir(), '.grok');
  return path.join(home, 'sessions');
}

function walkSessionDir(root, sessionId) {
  const matches = [];
  let groups;
  try {
    groups = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return matches;
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const candidate = path.join(root, g.name, sessionId);
    try {
      if (fs.statSync(candidate).isDirectory()) matches.push(candidate);
    } catch {
      /* missing */
    }
  }
  return matches;
}

function resolveSessionDir({ sessionId, cwd, sessionDir } = {}) {
  if (sessionDir) {
    const abs = expandHome(sessionDir);
    if (fs.existsSync(abs)) return abs;
  }
  if (!sessionId) {
    throw new Error('Cannot resolve a Grok session: no sessionDir and no sessionId.');
  }
  const root = sessionsRoot();
  if (cwd) {
    const candidate = path.join(root, encodeURIComponent(cwd), sessionId);
    if (fs.existsSync(candidate)) return candidate;
  }
  const matches = walkSessionDir(root, sessionId);
  if (matches.length === 0) {
    throw new Error(`No Grok session found for sessionId=${sessionId} under ${root}`);
  }
  const stated = matches.map((p) => {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      /* vanished */
    }
    return { path: p, mtimeMs };
  });
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stated[0].path;
}

// Copy ONLY the allowlisted meta.json fields. `prompt` (the worker's full task
// text) and every unknown key are dropped unread — nothing outside this list can
// reach a payload.
function pickSubagentMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v) => (typeof v === 'string' && v ? v : null);
  return {
    child_session_id: str(raw.child_session_id),
    child_cwd: str(raw.child_cwd),
    subagent_type: str(raw.subagent_type),
    description: str(raw.description),
    status: str(raw.status),
    started_at: raw.started_at,
    completed_at: raw.completed_at,
    duration_ms: intOrNull(raw.duration_ms),
    tool_calls: intOrNull(raw.tool_calls),
    turns: intOrNull(raw.turns),
    effective_model_id: str(raw.effective_model_id),
  };
}

// Read + allowlist `<parentSessionDir>/subagents/<childId>/meta.json`. Returns
// [{ dirName, meta }] in directory order; [] when there is no subagents dir.
// A single unreadable/garbage meta is skipped, never fatal.
function readSubagentMetas(parentSessionDir) {
  const subRoot = path.join(parentSessionDir, SUBAGENT_DIR);
  let entries;
  try {
    entries = fs.readdirSync(subRoot, { withFileTypes: true });
  } catch {
    return []; // no subagents dir for this session
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(subRoot, e.name, SUBAGENT_META), 'utf8'));
    } catch {
      continue; // missing/garbage meta.json — skip this worker
    }
    const meta = pickSubagentMeta(raw);
    if (meta) out.push({ dirName: e.name, meta });
  }
  return out;
}

// Build the parent's nested subagents[] from the on-disk worker records (the
// file plane). Grok writes each worker TWICE: as
// `<parent>/subagents/<childId>/{meta.json,output.json}` AND as a complete
// top-level session dir at `<sessionsRoot>/<encodeURIComponent(child_cwd)>/<childId>/`
// (the group dir name is the URL-encoded cwd, same encoding resolveSessionDir uses).
//
// meta.json carries the labels + timings; the child's own session dir carries the
// tokens, so we parse it with the SAME parseGrokSession with subagent discovery
// DISABLED to bound recursion to exactly one level (mirrors
// claude_code.buildClaudeSubagents). When that dir is missing or unparseable the
// worker is still emitted from meta.json alone with null token fields — never
// dropped. Numbers + content-safe labels only; `prompt` and output.json never
// touched. Returns [] on any failure; never throws (mirrors both precedents).
function buildGrokSubagents(parentSessionDir, sessionId) {
  try {
    if (!parentSessionDir) return [];
    const root = sessionsRoot();
    const out = [];
    for (const { dirName, meta } of readSubagentMetas(parentSessionDir)) {
      const childId = meta.child_session_id || dirName;
      // Guard the degenerate self-reference: a meta pointing back at its own
      // parent would otherwise re-parse the parent dir as its own worker.
      if (sessionId && childId === sessionId) continue;

      let child = null;
      if (meta.child_cwd && childId) {
        const childDir = path.join(root, encodeURIComponent(meta.child_cwd), childId);
        try {
          child = parseGrokSession(childDir, { sessionId: childId, withSubagents: false });
        } catch {
          child = null; // child dir missing/unparseable — meta.json alone below
        }
      }
      const cg = (child && child.grok) || {};

      out.push({
        agent_type: cap(meta.subagent_type, CAP_LABEL),
        // Owner's decision: the human-readable task label is the worker's role.
        role: cap(meta.description, CAP_LABEL),
        // meta.effective_model_id is the parent's record of the model this worker
        // actually resolved to; the child's own summary is the fallback.
        model: cap(meta.effective_model_id || (child && child.model), CAP_LABEL),
        status: cap(meta.status, CAP_LABEL),
        tool_uses: (child && child.tool_uses) || [],
        tool_use_count:
          child && child.num_tool_calls != null ? child.num_tool_calls : meta.tool_calls,
        // Token fields come ONLY from the child's own session dir. Absent it they
        // stay null (unknown), never 0 — 0 would read as "ran and spent nothing".
        input_tokens: child ? child.tokens_in : null,
        output_tokens: child ? child.tokens_out : null,
        cache_read_tokens: child ? cg.cache_read_tokens : null,
        cache_creation_tokens: child ? cg.cache_creation_tokens : null,
        // Timings are authoritative in meta.json (the parent observed the spawn);
        // fall back to the child's own window when meta omits them.
        started_at: toIso(meta.started_at) || (child ? child.started_at : null),
        ended_at: toIso(meta.completed_at) || (child ? child.ended_at : null),
        duration_ms: meta.duration_ms != null ? meta.duration_ms : child ? child.duration_ms : null,
        // Grok has no classified-diff source, so line metrics stay NULL here too.
        ...NULL_STRUCT,
        commit_shas: child && Array.isArray(child.commitSHA) ? child.commitSHA : [],
        branch: child ? child.branch : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// subagent suppression set
// ---------------------------------------------------------------------------

// Every child_session_id under `<sessionsRoot>/*/*/subagents/*/meta.json`.
// Because Grok writes each worker as a full top-level session dir too, callers
// that enumerate sessions (backfill) or dispatch a hook (collector) MUST skip
// these ids or every worker surfaces as an independent sibling session.
//
// Cached per resolved sessionsRoot for the life of the process: the walk happens
// once, and a test that repoints GROK_SESSIONS_DIR gets its own entry rather than
// a stale one.
const _childIdCache = new Map(); // sessionsRoot -> Set<childId>

function subagentChildIds() {
  const root = sessionsRoot();
  const hit = _childIdCache.get(root);
  if (hit) return hit;
  const ids = new Set();
  try {
    for (const g of fs.readdirSync(root, { withFileTypes: true })) {
      if (!g.isDirectory()) continue;
      const groupDir = path.join(root, g.name);
      let sessions;
      try {
        sessions = fs.readdirSync(groupDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of sessions) {
        if (!s.isDirectory()) continue;
        for (const { dirName, meta } of readSubagentMetas(path.join(groupDir, s.name))) {
          ids.add(meta.child_session_id || dirName);
        }
      }
    }
  } catch {
    /* no sessions root — empty set, suppress nothing */
  }
  _childIdCache.set(root, ids);
  return ids;
}

// True when `sessionId` is some other session's subagent child. Cheap after the
// first call (see the cache above).
function isSubagentSession(sessionId) {
  if (!sessionId) return false;
  return subagentChildIds().has(sessionId);
}

// Test hook: drop the memoized walk (a suite that mutates a staged sessions root
// between assertions needs the next call to re-scan).
function _resetSubagentCache() {
  _childIdCache.clear();
}

function parseGrokSession(sessionDir, extra = {}) {
  if (!sessionDir) {
    throw new Error('Grok session dir is required.');
  }
  const abs = expandHome(sessionDir);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`Grok session dir not found: ${abs}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`Grok session path is not a directory: ${abs}`);
  }

  const summaryRaw = readJsonFile(sessionFile(abs, 'summary.json'), { required: true });
  const summary = pickSummary(summaryRaw);
  const sessionId = extra.sessionId || summary.id;
  if (!sessionId) {
    throw new Error(`Grok session is missing info.id: ${abs}`);
  }

  const signals = pickSignals(readJsonFile(sessionFile(abs, 'signals.json')));
  const events = scanEvents(sessionFile(abs, 'events.jsonl'));
  const lastUsage = scanUsageJsonl(sessionFile(abs, 'updates.jsonl'));
  const tokens = disjointTokens(lastUsage);

  const tool_uses = [...events.toolUseCounts.entries()].map(([name, count]) => ({ name, count }));
  let num_tool_calls = tool_uses.reduce((a, t) => a + t.count, 0);
  if (num_tool_calls === 0 && signals && signals.toolCallCount != null) {
    num_tool_calls = signals.toolCallCount;
  }
  const hasToolSignal = tool_uses.length > 0 || (signals && signals.toolCallCount != null);

  let num_turns = null;
  if (events.turnStarted > 0) num_turns = events.turnStarted;
  else if (signals && signals.turnCount != null) num_turns = signals.turnCount;
  else if (lastUsage && lastUsage.numTurns != null) num_turns = lastUsage.numTurns;
  else if (summary.num_messages != null) num_turns = summary.num_messages;

  const started_at = toIso(summary.created_at);
  const ended_at = toIso(summary.last_active_at) || toIso(summary.updated_at);
  let duration_ms = null;
  if (started_at && ended_at) {
    const delta = Date.parse(ended_at) - Date.parse(started_at);
    if (Number.isFinite(delta) && delta >= 0) duration_ms = delta;
  } else if (signals && signals.sessionDurationSeconds != null) {
    duration_ms = signals.sessionDurationSeconds * 1000;
  }

  const model = summary.current_model_id || (signals && signals.primaryModelId) || null;
  const version =
    extra.version != null ? extra.version : extra.cli_version != null ? extra.cli_version : null;

  return {
    sessionId,
    device_uuid: extra.device_uuid != null ? extra.device_uuid : null,
    title: cap(summary.generated_title, CAP_TITLE) || null,
    model: cap(model, CAP_LABEL),
    tokens_in: tokens.tokens_in,
    tokens_out: tokens.tokens_out,
    started_at,
    ended_at,
    duration_ms,
    repo: cap(extra.repo || summary.cwd, CAP_REPO),
    branch: cap(extra.branch != null ? extra.branch : null, CAP_PATH),
    commitSHA: [],
    num_turns,
    num_tool_calls: hasToolSignal ? num_tool_calls : null,
    tool_uses,
    ...NULL_STRUCT,
    grok: {
      cache_read_tokens: tokens.cache_read_tokens,
      cache_creation_tokens: tokens.cache_creation_tokens,
      reasoning_output_tokens: tokens.reasoning_output_tokens,
      effort: cap(summary.reasoning_effort, CAP_LABEL),
      version: cap(version, CAP_LABEL),
      reason: cap(extra.reason != null ? extra.reason : null, CAP_LABEL),
      remoteSessionId: cap(extra.remoteSessionId != null ? extra.remoteSessionId : null, CAP_LABEL),
      context_tokens: signals ? signals.contextTokensUsed : null,
      context_token_limit: signals ? signals.contextWindowTokens : null,
      cost_usd_ticks: tokens.cost_usd_ticks,
      // Discovery is opt-OUT: buildGrokSubagents re-enters this parser for each
      // child with withSubagents:false, which bounds recursion to one level.
      subagents: extra.withSubagents === false ? [] : buildGrokSubagents(abs, sessionId),
    },
  };
}

module.exports = {
  parseGrokSession,
  resolveSessionDir,
  sessionsRoot,
  disjointTokens,
  expandHome,
  buildGrokSubagents,
  subagentChildIds,
  isSubagentSession,
  _resetSubagentCache,
};
