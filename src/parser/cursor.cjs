'use strict';

// ATTRIBUT — Cursor session parser (allowlist extractor, ISOLATED + FAIL-SAFE).
//
// HARD CONSTRAINT (the whole point of this collector): this module reads ONLY
// local Cursor state and returns ONLY the allowlist of safe, signal-bearing
// fields named in the FROZEN contract (src/contract/envelope.schema.json, the
// `cursorPayload`). It NEVER reads or returns prompt text, assistant/reasoning
// message bodies, file/diff contents, tool input args, summaries, todos, or
// cursor rules. No interpretation (pricing, attribution, identity) happens here —
// that is ingest_worker, server-side.
//
// Cursor stores the rich per-session signal on disk in its VS Code state DB, NOT
// in the hook payload or the agent transcript. Verified against Cursor 3.9.16:
//   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb  (SQLite)
//   table cursorDiskKV (key TEXT PRIMARY KEY, value TEXT-JSON):
//     composerData:<id>          one row per session (id == hook conversation_id):
//        modelConfig.modelName        session model (~97% populated; else "default")
//        usageData.<model>.{costInCents, amount}
//                                     EXACT metered cost + billed-request count —
//                                     present only for the ~2% of sessions that
//                                     incurred usage-based charges (empty otherwise)
//        contextTokensUsed / contextTokenLimit / contextUsagePercent
//                                     context-window occupancy snapshot (latest turn)
//        totalLinesAdded / totalLinesRemoved / filesChangedCount   session LOC totals
//        createdAt / lastUpdatedAt    epoch-ms session start/end
//        fullConversationHeadersOnly  ordered [{bubbleId, type}] (1=user, 2=asst)
//        subComposerIds               child composer ids (subagents)
//     bubbleId:<composerId>:<bubbleId>   per-turn: type + tokenCount.{inputTokens,
//        outputTokens}. inputTokens is CUMULATIVE context occupancy (monotonic);
//        outputTokens is real per-turn generation (but sparse — most bubbles 0).
//
// Billed input/output/cache tokens are NOT reliably local (Cursor confirms this;
// the Admin API is the only exact source, Enterprise-team only, server-side). So
// we ship RAW proxy components — context occupancy, summed real output tokens, the
// uncached cumulative-input upper bound, and exact cost where Cursor recorded it —
// and let the server derive tokens/value/cost. cost is NEVER fabricated here.
//
// GUARANTEES (mirror antigravity_tokens.cjs): CONTENT NEVER LEAKS (only numbers +
// a strictly model-id-shaped label leave this module); FAIL-SAFE (any error —
// missing/locked/corrupt DB, no SQLite, absent row — degrades to null / a minimal
// payload, never throws on the hot path); READ-ONLY (the DB is opened read-only;
// Cursor uses WAL so a concurrent read is safe and cannot corrupt the live DB).

const fs = require('fs');
const os = require('os');
const path = require('path');

const { expandHome } = require('./claude_code.cjs');
const { getDatabaseClass } = require('./antigravity_tokens.cjs');

const CAP_PATH = 256; // repo / branch
const CAP_LABEL = 128; // model / version / reason
const CAP_EMAIL = 320; // RFC-ish upper bound; the schema caps at 320
const MAX_SUBAGENTS = 64; // sanity bound on subComposerIds fan-out

function cap(s, n) {
  return typeof s === 'string' && s.length > n ? s.slice(0, n) : s;
}

function intOrNull(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.trunc(v));
}

function numOrNull(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v < 0 ? 0 : v;
}

// A model id is a structured config value, never free text — but we still gate it
// so nothing but an id-shaped token can ever leave: a single word, no whitespace,
// vendor-id charset, length-capped. "default" (Cursor's unresolved placeholder) and
// anything that fails the shape map to null. Same discipline as the agy MODEL_ID_RE.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function modelOrNull(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s === 'default') return null;
  return MODEL_ID_RE.test(s) ? s : null;
}

/** Default Cursor state DB path. Override via CURSOR_STATE_DB (used in tests). */
function stateDbPath() {
  return (
    process.env.CURSOR_STATE_DB ||
    path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb'
    )
  );
}

/** Open the state DB read-only. Returns null on any failure (SQLite unavailable,
 * file missing, locked). Caller must close(). Never throws. */
function openStateDb(dbPath = stateDbPath()) {
  const DatabaseSync = getDatabaseClass();
  if (!DatabaseSync) return null;
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

// One targeted PK lookup for a composer's row. Returns the parsed JSON object, or
// null. Reads ONLY the allowlisted numeric/label fields out of it — the rest of
// the (content-rich) row is never touched by callers.
function readComposerRow(db, composerId) {
  if (!db || !composerId) return null;
  try {
    const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').all(`composerData:${composerId}`)[0];
    if (!row || typeof row.value !== 'string') return null;
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

// Extract the allowlisted session-level signal from a parsed composerData object.
// NUMBERS + a model-id label ONLY. Never returns summaries/todos/rules/paths/text.
function pickComposerFields(o) {
  if (!o || typeof o !== 'object') return null;

  // usageData is { "<modelName>": { costInCents, amount } } — the metered ledger,
  // present only when the session incurred usage-based charges. Sum across models.
  let costCents = null;
  let costAmount = null;
  const usage = o.usageData;
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    for (const v of Object.values(usage)) {
      if (!v || typeof v !== 'object') continue;
      const c = numOrNull(v.costInCents);
      const a = intOrNull(v.amount);
      if (c !== null) costCents = (costCents || 0) + c;
      if (a !== null) costAmount = (costAmount || 0) + a;
    }
  }

  // Ordered bubble ids + turn count from the headers (type 2 == assistant). We read
  // ONLY the bubbleId (a uuid) and the numeric type — never any content.
  const headers = Array.isArray(o.fullConversationHeadersOnly)
    ? o.fullConversationHeadersOnly
    : [];
  const orderedBubbleIds = [];
  let numTurns = 0;
  for (const h of headers) {
    if (!h || typeof h !== 'object') continue;
    if (typeof h.bubbleId === 'string') orderedBubbleIds.push(h.bubbleId);
    if (h.type === 2) numTurns += 1;
  }

  const subIds = Array.isArray(o.subComposerIds)
    ? o.subComposerIds.filter((s) => typeof s === 'string').slice(0, MAX_SUBAGENTS)
    : [];

  const created = intOrNull(o.createdAt);
  const updated = intOrNull(o.lastUpdatedAt);

  return {
    model: modelOrNull(o.modelConfig && o.modelConfig.modelName),
    cost_cents: costCents,
    cost_amount: costAmount,
    context_tokens: intOrNull(o.contextTokensUsed),
    context_token_limit: intOrNull(o.contextTokenLimit),
    context_usage_percent: numOrNull(o.contextUsagePercent),
    lines_added: intOrNull(o.totalLinesAdded),
    lines_removed: intOrNull(o.totalLinesRemoved),
    files_changed: intOrNull(o.filesChangedCount),
    createdAt: created,
    lastUpdatedAt: updated,
    orderedBubbleIds,
    num_turns: numTurns,
    subComposerIds: subIds,
  };
}

// Read per-turn token numbers for a composer's bubbles. Returns { output_tokens,
// input_tokens_cumulative, priced_turns }. NUMBERS ONLY — never message content.
//
//   output_tokens            = Σ outputTokens over all bubbles (real generation).
//   input_tokens_cumulative  = Σ (cumulative inputTokens) over priced assistant
//                              turns — the UNCACHED upper bound on billed input
//                              (each turn re-sends its whole context; inputTokens
//                              is that context's size). The server discounts for
//                              caching. A compaction reset (cumulative drops) just
//                              contributes its new, smaller value — no special
//                              casing needed since we sum per-turn values, not deltas.
//   priced_turns             = count of assistant bubbles carrying non-zero tokens.
function readBubbleTokens(db, composerId, orderedBubbleIds) {
  const empty = { output_tokens: null, input_tokens_cumulative: null, priced_turns: null };
  if (!db || !composerId) return empty;
  let byId;
  try {
    const rows = db
      .prepare('SELECT key, value FROM cursorDiskKV WHERE key LIKE ?')
      .all(`bubbleId:${composerId}:%`);
    byId = new Map();
    for (const r of rows) {
      if (!r || typeof r.value !== 'string' || typeof r.key !== 'string') continue;
      const bubbleId = r.key.slice(`bubbleId:${composerId}:`.length);
      let o;
      try {
        o = JSON.parse(r.value);
      } catch {
        continue;
      }
      byId.set(bubbleId, o);
    }
  } catch {
    return empty;
  }
  if (byId.size === 0) return empty;

  // Iterate in canonical conversation order (the headers) so cumulative-input is
  // read in the right sequence; fall back to whatever order the map yields.
  const order =
    Array.isArray(orderedBubbleIds) && orderedBubbleIds.length
      ? orderedBubbleIds
      : [...byId.keys()];

  let outputSum = 0;
  let inputCumSum = 0;
  let priced = 0;
  let seenAny = false;
  for (const bubbleId of order) {
    const o = byId.get(bubbleId);
    if (!o || typeof o !== 'object') continue;
    const tc = o.tokenCount;
    if (!tc || typeof tc !== 'object') continue;
    const inp = intOrNull(tc.inputTokens) || 0;
    const out = intOrNull(tc.outputTokens) || 0;
    if (inp === 0 && out === 0) continue;
    seenAny = true;
    outputSum += out;
    // Assistant turns (type 2) carry the billed context; sum their cumulative input.
    if (o.type === 2 && inp > 0) {
      inputCumSum += inp;
      priced += 1;
    }
  }
  if (!seenAny) return empty;
  return {
    output_tokens: outputSum,
    input_tokens_cumulative: inputCumSum > 0 ? inputCumSum : null,
    priced_turns: priced > 0 ? priced : null,
  };
}

// Tool-use NAMES + counts from the agent transcript, plus an assistant-turn count.
// The transcript (`<id>.jsonl`) has NO tokens/model; we read it ONLY for the
// Anthropic-style content blocks' `type==='tool_use'` NAME (never the tool input,
// never `text` blocks). Returns { tool_uses:[{name,count}], num_turns }. Fail-safe.
function toolUsesFromTranscript(transcriptPath) {
  const out = { tool_uses: [], num_turns: 0 };
  if (!transcriptPath) return out;
  let raw;
  try {
    raw = fs.readFileSync(expandHome(transcriptPath), 'utf8');
  } catch {
    return out;
  }
  const counts = new Map();
  let turns = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o.role === 'assistant') turns += 1;
    const msg = o.message;
    const content = msg && typeof msg === 'object' ? msg.content : null;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'tool_use') {
        const name = typeof block.name === 'string' && block.name ? block.name : 'unknown';
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
  }
  return {
    tool_uses: [...counts.entries()].map(([name, count]) => ({ name: cap(name, CAP_LABEL), count })),
    num_turns: turns,
  };
}

function isoOrNull(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

// Build one subagent record from a child composer's row (numbers + model only).
function buildSubagent(db, composerId) {
  const row = readComposerRow(db, composerId);
  const cd = pickComposerFields(row);
  if (!cd) return null;
  const tok = readBubbleTokens(db, composerId, cd.orderedBubbleIds);
  return {
    composer_id: cap(composerId, CAP_LABEL),
    model: cap(cd.model, CAP_LABEL),
    status: 'completed',
    output_tokens: tok.output_tokens,
    input_tokens_cumulative: tok.input_tokens_cumulative,
    context_tokens: cd.context_tokens,
    cost_cents: cd.cost_cents,
    cost_amount: cd.cost_amount,
    lines_added: cd.lines_added,
    lines_removed: cd.lines_removed,
    started_at: isoOrNull(cd.createdAt),
    ended_at: isoOrNull(cd.lastUpdatedAt),
    duration_ms:
      cd.createdAt && cd.lastUpdatedAt && cd.lastUpdatedAt >= cd.createdAt
        ? cd.lastUpdatedAt - cd.createdAt
        : null,
  };
}

// Parse a Cursor session into the contract `cursorPayload`. `extra` provides the
// hook context: { composerId (== conversation_id), transcriptPath, repo,
// device_uuid, withSubagents }. NEVER throws — a missing/locked DB yields a minimal
// payload (sessionId + whatever the transcript gave). Token/cost/model capture must
// never break capture.
function parseCursorSession(extra = {}) {
  const composerId = extra.composerId || null;
  const tools = toolUsesFromTranscript(extra.transcriptPath);

  let cd = null;
  let tok = { output_tokens: null, input_tokens_cumulative: null, priced_turns: null };
  let subagents = [];
  let db = null;
  try {
    db = openStateDb();
    if (db && composerId) {
      cd = pickComposerFields(readComposerRow(db, composerId));
      if (cd) {
        tok = readBubbleTokens(db, composerId, cd.orderedBubbleIds);
        if (extra.withSubagents !== false && cd.subComposerIds.length) {
          for (const sub of cd.subComposerIds) {
            const rec = buildSubagent(db, sub);
            if (rec) subagents.push(rec);
          }
        }
      }
    }
  } catch {
    // fall through to the minimal payload
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }

  // num_turns: composerData headers are authoritative; fall back to the transcript's
  // assistant-role count when the DB row was unavailable.
  const numTurns = cd ? cd.num_turns : tools.num_turns;
  const numToolCalls = tools.tool_uses.reduce((a, t) => a + t.count, 0);

  const startedAt = cd ? isoOrNull(cd.createdAt) : null;
  const endedAt = cd ? isoOrNull(cd.lastUpdatedAt) : null;
  const durationMs =
    cd && cd.createdAt && cd.lastUpdatedAt && cd.lastUpdatedAt >= cd.createdAt
      ? cd.lastUpdatedAt - cd.createdAt
      : null;

  return {
    sessionId: composerId,
    device_uuid: extra.device_uuid != null ? extra.device_uuid : null,
    title: null, // no verified content-safe Cursor session title field
    model: cap(cd && cd.model, CAP_LABEL),
    // Billed in/out are not reliably local; the server derives them from the cursor
    // sub-struct proxy components. Left null by the collector.
    tokens_in: null,
    tokens_out: null,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    repo: extra.repo || null,   // UNBOUNDED: full cwd/path (folder->org attribution)
    branch: cap(extra.branch || null, CAP_PATH),
    commitSHA: [],
    num_turns: numTurns,
    num_tool_calls: numToolCalls,
    tool_uses: tools.tool_uses,
    // Cursor gives session LOC TOTALS (pure numbers), not code/comment/blank splits —
    // those land in the cursor sub-struct; the classified structural fields stay null.
    lines_code_added: null,
    lines_comment_added: null,
    lines_blank_added: null,
    lines_code_removed: null,
    lines_comment_removed: null,
    lines_blank_removed: null,
    added_char_n: null,
    added_char_sum: null,
    added_char_sumsq: null,
    cursor: {
      context_tokens: cd ? cd.context_tokens : null,
      context_token_limit: cd ? cd.context_token_limit : null,
      context_usage_percent: cd ? cd.context_usage_percent : null,
      output_tokens: tok.output_tokens,
      input_tokens_cumulative: tok.input_tokens_cumulative,
      priced_turns: tok.priced_turns,
      cost_cents: cd ? cd.cost_cents : null,
      cost_amount: cd ? cd.cost_amount : null,
      lines_added: cd ? cd.lines_added : null,
      lines_removed: cd ? cd.lines_removed : null,
      files_changed: cd ? cd.files_changed : null,
      user_email: cap(extra.user_email || null, CAP_EMAIL),
      cursor_version: cap(extra.cursor_version || null, CAP_LABEL),
      reason: cap(extra.reason || null, CAP_LABEL),
      remoteSessionId: null,
      subagents,
    },
  };
}

// Resolve the composer id (== session id) from the hook. Cursor's hook provides
// `conversation_id`; fall back to the transcript file/dir basename (named by id).
function resolveComposerId({ conversationId, transcriptPath } = {}) {
  if (conversationId && typeof conversationId === 'string') return conversationId;
  if (transcriptPath && typeof transcriptPath === 'string') {
    const base = path.basename(transcriptPath).replace(/\.jsonl$/, '');
    if (base) return base;
  }
  return null;
}

// List EVERY top-level Cursor composer (session) from an open state.vscdb handle,
// excluding sub-composers (children referenced in some parent's subComposerIds).
// Returns [{ composerId, createdAt, lastUpdatedAt }] newest-first (lastUpdatedAt
// then createdAt). READ-ONLY, fail-safe → [] on any error. Never throws.
function listComposerIds(db) {
  if (!db) return [];
  let rows;
  try {
    rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
  } catch {
    return [];
  }
  const prefix = 'composerData:';
  const items = [];
  const childIds = new Set();
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || typeof row.value !== 'string') continue;
    const composerId = row.key.slice(prefix.length);
    let o;
    try {
      o = JSON.parse(row.value);
    } catch {
      continue;
    }
    const createdAt = intOrNull(o && o.createdAt);
    const lastUpdatedAt = intOrNull(o && o.lastUpdatedAt);
    if (o && Array.isArray(o.subComposerIds)) {
      for (const c of o.subComposerIds) {
        if (typeof c === 'string') childIds.add(c);
      }
    }
    items.push({ composerId, createdAt, lastUpdatedAt });
  }
  const out = items.filter((it) => !childIds.has(it.composerId));
  out.sort((a, b) => (b.lastUpdatedAt || b.createdAt || 0) - (a.lastUpdatedAt || a.createdAt || 0));
  return out;
}

module.exports = {
  stateDbPath,
  openStateDb,
  readComposerRow,
  pickComposerFields,
  readBubbleTokens,
  toolUsesFromTranscript,
  parseCursorSession,
  resolveComposerId,
  modelOrNull,
  listComposerIds,
};
