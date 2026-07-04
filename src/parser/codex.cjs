'use strict';

// ATTRIBUT — Codex CLI rollout parser (allowlist extractor).
//
// HARD CONSTRAINT (the whole point of this collector): this module reads ONLY
// local Codex rollout .jsonl files and returns ONLY the allowlist of safe,
// signal-bearing fields named in the FROZEN contract (src/contract/
// envelope.schema.json, the `codexPayload`). It NEVER reads or returns prompt
// text, assistant/reasoning message bodies, file/diff contents, or tool input
// args. No interpretation (pricing, attribution, identity) happens here — that is
// ingest_worker, server-side.
//
// Codex rollout shape (verified against real ~/.codex/sessions/**/rollout-*.jsonl
// from codex-cli 0.139.0 / rollout 0.140.0-alpha). Each line is a JSON object
// with a top-level `type` and a `payload`:
//   session_meta : payload.id, payload.cwd, payload.cli_version, payload.git =
//                  {commit_hash, branch, repository_url}. For subagents,
//                  payload.thread_source === "subagent" and
//                  payload.source.subagent.thread_spawn =
//                  {parent_thread_id, depth, agent_nickname, agent_role}.
//   turn_context : payload.model (e.g. "gpt-5.4-mini"), payload.effort.
//   event_msg token_count : payload.info.total_token_usage is CUMULATIVE; the
//                  LAST such line wins. Codex nests cached ⊆ input and reasoning ⊆
//                  output; we emit the DISJOINT contract below.
//   response_item function_call / custom_tool_call : payload.name → per-tool
//                  counts (names only, never args).
//   response_item function_call_output / custom_tool_call_output : payload.output
//                  is shell/tool stdout — git commit `[branch sha]` lines land
//                  here (same regex as Claude). We scan ONLY the output field.
//   event_msg patch_apply_end : payload.changes[<path>].unified_diff for
//                  apply_patch edits — structural line counts.
//
// Token disjoint contract (the hook plane expects non-overlapping buckets):
//   tokens_in             = input_tokens − cached_input_tokens
//   cache_read_tokens     = cached_input_tokens
//   cache_creation_tokens = null   (Codex does not distinguish cache creation)
//   tokens_out            = output_tokens   (already includes reasoning; that is
//                           the billed output, so we keep it whole)

const fs = require('fs');
const path = require('path');
const os = require('os');

// Shared structural + SHA helpers live in the Claude parser (the canonical home).
const {
  SHA_RE,
  branchFromBracketLine,
  classify,
  syntaxForPath,
  isGeneratedPath,
  newStructAccumulator,
  expandHome,
} = require('./claude_code.cjs');

const CAP_PATH = 256; // branch
const CAP_LABEL = 128; // model / effort / version / agent_type / role / status

function cap(s, n) {
  return typeof s === 'string' && s.length > n ? s.slice(0, n) : s;
}

// Scan a tool-output string for git-commit `[branch sha]` brackets. Returns
// [{ sha, line }]. We scan ONLY the `output` field of a tool-result payload —
// never message bodies or file content.
function extractShasFromOutput(output) {
  const found = [];
  if (typeof output !== 'string' || output.length === 0) return found;
  SHA_RE.lastIndex = 0;
  let m;
  while ((m = SHA_RE.exec(output)) !== null) {
    found.push({ sha: m[1], line: m[0] });
  }
  return found;
}

// Emit the disjoint token contract from Codex's nested total_token_usage object.
// Codex: cached_input_tokens ⊆ input_tokens, reasoning_output_tokens ⊆
// output_tokens. We split input into (fresh, cached) and keep output whole.
function disjointTokens(totalUsage) {
  const u = totalUsage || {};
  const input = u.input_tokens || 0;
  const cached = u.cached_input_tokens || 0;
  const output = u.output_tokens || 0;
  const reasoning = u.reasoning_output_tokens || 0;
  return {
    tokens_in: Math.max(0, input - cached),
    cache_read_tokens: cached,
    cache_creation_tokens: null,
    tokens_out: output,
    reasoning_output_tokens: reasoning,
  };
}

// Accumulate structural line counts from ONE patch_apply_end payload into
// `struct`. Codex carries each edit as payload.changes[<path>].unified_diff, a
// standard unified-diff body (lines prefixed '+', '-', ' '). We classify each
// line by the file's extension and tally. Content is measured then discarded.
function accumulateUnifiedDiff(filePath, diff, struct) {
  if (typeof filePath !== 'string' || filePath === '') return;
  if (isGeneratedPath(filePath)) return; // skip generated/vendored
  if (typeof diff !== 'string' || diff.length === 0) return;
  const syntax = syntaxForPath(filePath);
  const blockState = { open: null }; // fresh per diff
  for (const raw of diff.split('\n')) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    if (raw.startsWith('@@')) continue; // hunk header — not a source line
    const tag = raw[0];
    const content = raw.slice(1);
    const kind = classify(content, syntax, blockState);
    if (tag === '+') {
      if (kind === 'code') struct.lines_code_added += 1;
      else if (kind === 'comment') struct.lines_comment_added += 1;
      else struct.lines_blank_added += 1;
      const len = content.length;
      struct.added_char_n += 1;
      struct.added_char_sum += len;
      struct.added_char_sumsq += len * len;
    } else if (tag === '-') {
      if (kind === 'code') struct.lines_code_removed += 1;
      else if (kind === 'comment') struct.lines_comment_removed += 1;
      else struct.lines_blank_removed += 1;
    }
    // ' ' (context): classify already ran to keep block state honest.
  }
}

function accumulatePatchApply(payload, struct) {
  if (!payload || typeof payload !== 'object') return;
  const changes = payload.changes;
  if (!changes || typeof changes !== 'object') return;
  for (const [filePath, change] of Object.entries(changes)) {
    if (!change || typeof change !== 'object') continue;
    accumulateUnifiedDiff(filePath, change.unified_diff, struct);
  }
}

// Read the session_meta payload from a rollout (first non-empty JSON line whose
// type is session_meta). Returns the payload object, or null. Cheap: stops at the
// first line. Never throws.
function readSessionMeta(rolloutPath) {
  let raw;
  try {
    raw = fs.readFileSync(rolloutPath, 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      return null;
    }
    if (o.type === 'session_meta' && o.payload && typeof o.payload === 'object') {
      return o.payload;
    }
    // session_meta is the first row in practice; bail after the first parsed row.
    return null;
  }
  return null;
}

// The subagent spawn descriptor {parent_thread_id, depth, agent_nickname,
// agent_role} for a rollout, or null when it isn't a subagent. Lives at
// session_meta.source.subagent.thread_spawn.
function threadSpawnOf(meta) {
  const src = meta && meta.source;
  const sub = src && typeof src === 'object' ? src.subagent : null;
  const spawn = sub && typeof sub === 'object' ? sub.thread_spawn : null;
  return spawn && typeof spawn === 'object' ? spawn : null;
}

// True when a rollout is a Codex subagent's own transcript (so the collector
// suppresses its standalone post and nests it into the parent instead).
function isCodexSubagentRollout(rolloutPath) {
  const meta = readSessionMeta(rolloutPath);
  if (!meta) return false;
  return meta.thread_source === 'subagent' || threadSpawnOf(meta) !== null;
}

// Parse a Codex rollout .jsonl into the contract `codexPayload`. `extra` may
// override { sessionId, repo, device_uuid } and set { withSubagents:false } to
// bound recursion when parsing a child. THROWS on unreadable/garbage input.
function parseCodexRollout(rolloutPath, extra = {}) {
  const abs = expandHome(rolloutPath);
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`Codex rollout is empty: ${abs}`);
  }

  let sessionId = null;
  let repo = null;
  let branch = '';
  let headSha = null;
  let repoUrl = null;
  let cliVersion = null;
  let effort = null;
  const models = new Set();
  let lastTotalUsage = null;
  let tMin = null;
  let tMax = null;
  const shaSet = new Set();
  const bracketBranches = new Set();
  const struct = newStructAccumulator();
  const toolUseCounts = new Map(); // tool name -> count (names only)
  let numTurns = 0; // count of agent_message events (assistant turns)

  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch (err) {
      throw new Error(`Malformed JSON in ${abs}: ${err.message} :: ${line.slice(0, 120)}`);
    }

    const ts = o.timestamp;
    if (ts) {
      const t = Date.parse(ts);
      if (!Number.isNaN(t)) {
        if (tMin === null || t < tMin) tMin = t;
        if (tMax === null || t > tMax) tMax = t;
      }
    }

    const type = o.type;
    const p = o.payload;
    if (!p || typeof p !== 'object') continue;

    if (type === 'session_meta') {
      if (p.id && !sessionId) sessionId = p.id;
      if (p.cwd && !repo) repo = p.cwd;
      if (typeof p.cli_version === 'string' && !cliVersion) cliVersion = p.cli_version;
      const git = p.git;
      if (git && typeof git === 'object') {
        if (git.branch && git.branch !== 'HEAD' && !branch) branch = git.branch;
        if (git.commit_hash && !headSha) headSha = git.commit_hash;
        if (git.repository_url && !repoUrl) repoUrl = git.repository_url;
      }
      continue;
    }

    if (type === 'turn_context') {
      if (p.model) models.add(p.model);
      if (typeof p.effort === 'string' && !effort) effort = p.effort;
      continue;
    }

    const pType = p.type;

    // Assistant turns.
    if (type === 'event_msg' && pType === 'agent_message') {
      numTurns += 1;
      continue;
    }

    // Cumulative token usage: the LAST token_count line is authoritative.
    if (type === 'event_msg' && pType === 'token_count') {
      const info = p.info;
      if (info && typeof info === 'object' && info.total_token_usage) {
        lastTotalUsage = info.total_token_usage;
      }
      continue;
    }

    // Per-tool NAMES + counts (never the tool input args).
    if (
      type === 'response_item' &&
      (pType === 'function_call' || pType === 'custom_tool_call' || pType === 'local_shell_call')
    ) {
      const name = typeof p.name === 'string' && p.name ? p.name : pType;
      toolUseCounts.set(name, (toolUseCounts.get(name) || 0) + 1);
      continue;
    }

    // git commit SHA from tool stdout (function_call_output / custom_tool_call_output).
    if (
      type === 'response_item' &&
      (pType === 'function_call_output' || pType === 'custom_tool_call_output')
    ) {
      for (const hit of extractShasFromOutput(p.output)) {
        shaSet.add(hit.sha);
        const b = branchFromBracketLine(hit.line);
        if (b) bracketBranches.add(b);
      }
      continue;
    }

    // Structural line counts from apply_patch edits.
    if (type === 'event_msg' && pType === 'patch_apply_end') {
      accumulatePatchApply(p, struct);
      continue;
    }
  }

  // Branch precedence: session_meta git branch → commit-bracket branch.
  if (!branch && bracketBranches.size > 0) branch = [...bracketBranches][0];

  const tokens = disjointTokens(lastTotalUsage);

  // Subagent plane: Codex spawns each subagent as its OWN rollout file whose
  // session_meta links back via thread_spawn.parent_thread_id. Collect the
  // transitive closure rooted at THIS session, parse each (recursion bounded), and
  // fold their tokens + structural + commits into the session totals — so the
  // materialized session reflects the whole tree, not just the conductor.
  const subagents =
    extra.withSubagents === false
      ? []
      : buildCodexSubagents(extra.sessionId || sessionId, abs);

  let tokensIn = tokens.tokens_in;
  let tokensOut = tokens.tokens_out;
  let cacheRead = tokens.cache_read_tokens;
  const mergedShas = new Set(shaSet);
  for (const sa of subagents) {
    tokensIn += sa.input_tokens || 0;
    tokensOut += sa.output_tokens || 0;
    cacheRead += sa.cache_read_tokens || 0;
    for (const s of sa._commitSHA || []) mergedShas.add(s);
    // Fold child structural counts into the session totals.
    for (const k of Object.keys(struct)) struct[k] += (sa._struct && sa._struct[k]) || 0;
  }
  // Strip the internal fold-only fields before the records enter the payload.
  const cleanSubagents = subagents.map(({ _commitSHA, _struct, ...rest }) => rest);

  const model = models.size ? [...models][0] : null;

  const payload = {
    sessionId: extra.sessionId || sessionId,
    device_uuid: extra.device_uuid != null ? extra.device_uuid : null,
    title: null, // no verified content-safe Codex session title field yet
    model: cap(model, CAP_LABEL),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    started_at: tMin !== null ? new Date(tMin).toISOString() : null,
    ended_at: tMax !== null ? new Date(tMax).toISOString() : null,
    duration_ms: tMin !== null && tMax !== null ? tMax - tMin : null,
    repo: extra.repo || repo,   // UNBOUNDED: full cwd/path (folder->org attribution)
    branch: cap(branch, CAP_PATH),
    commitSHA: [...mergedShas],
    num_turns: numTurns,
    num_tool_calls: [...toolUseCounts.values()].reduce((a, c) => a + c, 0),
    tool_uses: [...toolUseCounts.entries()].map(([name, count]) => ({ name, count })),
    ...struct,
    codex: {
      cache_read_tokens: cacheRead,
      cache_creation_tokens: tokens.cache_creation_tokens,
      reasoning_output_tokens: tokens.reasoning_output_tokens,
      effort: cap(effort, CAP_LABEL),
      cli_version: cap(cliVersion, CAP_LABEL),
      version: cap(cliVersion, CAP_LABEL),
      reason: null,
      remoteSessionId: null,
      subagents: cleanSubagents,
    },
  };

  return payload;
}

// Root of the Codex sessions tree (override for tests).
function sessionsRoot() {
  return process.env.CODEX_SESSIONS_DIR || path.join(os.homedir(), '.codex', 'sessions');
}

// Walk the sessions tree, returning [{ path, meta, spawn }] for EVERY subagent
// rollout (those carrying a thread_spawn). Reads only each file's session_meta
// (first line) — cheap. Never throws.
function listSubagentRollouts(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const meta = readSessionMeta(full);
        const spawn = meta ? threadSpawnOf(meta) : null;
        if (spawn && spawn.parent_thread_id) out.push({ path: full, meta, spawn });
      }
    }
  };
  walk(root);
  return out;
}

// Walk the sessions tree, returning [{ path, sessionId, mtimeMs }] for EVERY
// TOP-LEVEL session rollout (subagent children excluded — they are folded into
// their parent). Reads each file's session_meta (first line) to classify + label
// it; the sessionId is best-effort (session_meta payload.id) and may be null (the
// parser re-derives it from content at parse time). Newest-first by mtime. Never
// throws — used by `attribut backfill` to enumerate history.
function listSessionRollouts(root = sessionsRoot()) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const meta = readSessionMeta(full);
        // Skip subagent children (thread_source/thread_spawn) — the parent folds them.
        if (meta && (meta.thread_source === 'subagent' || threadSpawnOf(meta) !== null)) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          continue; // vanished between readdir and stat — skip
        }
        out.push({ path: full, sessionId: (meta && meta.id) || null, mtimeMs });
      }
    }
  };
  walk(root);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// Build the parent's nested subagents[] from the on-disk child rollouts (the
// separate-file plane). Collects the TRANSITIVE closure rooted at parentSessionId
// (so a depth-2 subagent whose parent is a depth-1 subagent is included), parses
// each child (subagent discovery disabled to bound recursion), and reshapes its
// totals into the subagent struct + private fold-only fields (_commitSHA,
// _struct). Numbers + the spawn's nickname/role labels only — never message/diff
// content. Returns [] on any failure; never throws.
function buildCodexSubagents(parentSessionId, selfPath) {
  try {
    if (!parentSessionId) return [];
    const all = listSubagentRollouts(sessionsRoot());
    if (all.length === 0) return [];

    // Index children by parent id, then BFS from the root to gather descendants.
    const byParent = new Map(); // parent id -> [{path, meta, spawn}]
    for (const rec of all) {
      const pid = rec.spawn.parent_thread_id;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(rec);
    }

    const selfAbs = selfPath ? path.resolve(expandHome(selfPath)) : null;
    const out = [];
    const seen = new Set(); // guard against cycles / self-inclusion
    if (selfAbs) seen.add(selfAbs);
    const queue = [parentSessionId];
    while (queue.length) {
      const pid = queue.shift();
      const kids = byParent.get(pid) || [];
      for (const rec of kids) {
        const childAbs = path.resolve(rec.path);
        if (seen.has(childAbs)) continue;
        seen.add(childAbs);
        let cp;
        try {
          cp = parseCodexRollout(rec.path, { withSubagents: false });
        } catch {
          continue; // unreadable/empty child — skip, never fail the parent
        }
        const cc = cp.codex || {};
        out.push({
          agent_type: cap(rec.spawn.agent_nickname || null, CAP_LABEL),
          role: cap(rec.spawn.agent_role || null, CAP_LABEL),
          model: cp.model,
          status: 'completed',
          tool_uses: cp.tool_uses || [],
          tool_use_count: cp.num_tool_calls || 0,
          input_tokens: cp.tokens_in || 0,
          output_tokens: cp.tokens_out || 0,
          cache_read_tokens: cc.cache_read_tokens || 0,
          cache_creation_tokens: cc.cache_creation_tokens != null ? cc.cache_creation_tokens : null,
          started_at: cp.started_at,
          ended_at: cp.ended_at,
          duration_ms: cp.duration_ms,
          // Private fold-only fields (stripped by the caller before payload build).
          _commitSHA: cp.commitSHA || [],
          _struct: extractStruct(cp),
        });
        // Descend: this child may itself have spawned deeper subagents.
        if (cp.sessionId) queue.push(cp.sessionId);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Pull the 9 structural keys out of a parsed payload into a bare accumulator.
function extractStruct(p) {
  const s = newStructAccumulator();
  for (const k of Object.keys(s)) s[k] = p[k] || 0;
  return s;
}

// Resolve a Codex rollout path from a hook's `transcript_path`, falling back to a
// tree walk by session_id under ~/.codex/sessions when the hook didn't provide one
// (the session id is embedded in the rollout filename). Returns the newest match.
// THROWS (fail loud) when nothing is found.
function resolveRolloutPath({ transcriptPath, sessionId } = {}) {
  if (transcriptPath) {
    const abs = expandHome(transcriptPath);
    if (fs.existsSync(abs)) return abs;
  }
  if (!sessionId) {
    throw new Error(
      'Cannot resolve a Codex rollout: no transcript_path and no session_id to glob by.'
    );
  }
  const root = sessionsRoot();
  if (!fs.existsSync(root)) {
    throw new Error(`Codex sessions dir not found: ${root}`);
  }
  const matches = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(sessionId)) {
        matches.push(full);
      }
    }
  };
  walk(root);
  if (matches.length === 0) {
    throw new Error(`No Codex rollout found for session_id=${sessionId} under ${root}`);
  }
  matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return matches[0];
}

module.exports = {
  extractShasFromOutput,
  disjointTokens,
  accumulateUnifiedDiff,
  accumulatePatchApply,
  readSessionMeta,
  isCodexSubagentRollout,
  parseCodexRollout,
  buildCodexSubagents,
  listSessionRollouts,
  resolveRolloutPath,
  sessionsRoot,
  expandHome,
};
