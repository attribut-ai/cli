'use strict';

// ATTRIBUT — Google Antigravity token reader (ISOLATED, FAIL-SAFE).
//
// Antigravity does NOT expose token usage in its hook payload or its JSONL
// transcript. The only local source is the per-conversation SQLite DB at
// <store>/conversations/<conversationId>.db (see "store resolution" below for
// which <store>), table `gen_metadata` — one row PER MODEL GENERATION, each a
// protobuf blob carrying that turn's usage (verified: path 1.4.2 = uncached new
// input tokens, 1.4.3 = output tokens, 1.4.5 = cached-prefix / cache-read input
// tokens; values scale with real session size, unlike `executor_metadata` which
// holds only static config/limits). We SUM each varint path across the small
// per-generation rows to get session totals, and skip the oversized embedding
// rows (the large blobs are model-context dumps, not usage).
//
// This module reads that DB and returns a `usage_raw` map of { "<dotted field
// path>": integer }. The session's own usage_raw ships RAW — the semantic
// mapping is applied server-side in ingest_worker, so it can change without
// reshipping the collector. The one client-side projection is for NESTED
// subagents (usageInputOutput / USAGE_PATHS), whose tokens the contract carries
// pre-labelled; USAGE_PATHS is the single place that path knowledge lives.
//
// THREE HARD GUARANTEES:
//   1. CONTENT NEVER LEAKS. We emit ONLY varint (wire-type-0) values as integers.
//      Conversation content is always length-delimited (wire-type-2 string/bytes)
//      and is NEVER emitted — we may descend into a sub-message to find nested
//      varints, but the raw bytes of any field never leave this module. So even a
//      mis-identified string can only ever contribute spurious *numbers*, never text.
//   2. FAIL-SAFE. Any error (missing/locked/corrupt DB, no node:sqlite, bad
//      protobuf) returns null. The collector treats null as "no tokens" and
//      proceeds — token capture must never break a capture or the user's session.
//   3. READ-ONLY. The DB is opened read-only; we never write. agy uses WAL, so a
//      concurrent read is consistent and cannot corrupt the live DB.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');

// Bounds: agy's executor_metadata is ~3 KB. These caps stop a pathological blob
// from blowing up memory/output and keep usage_raw within the schema's limits.
const MAX_DEPTH = 7;
const MAX_ENTRIES = 128; // matches the schema's maxProperties on usage_raw
// Per-generation usage rows are ~1-2 KB; the embedding/context dumps are 100 KB+.
// Only walk rows at or below this size — the big rows are model context, not usage.
const MAX_ROW_BYTES = 8192;
// Sanity cap on subagent children nested under one parent (observed max is in
// the tens). The contract's subagents array has no lower maxItems.
const MAX_CHILDREN = 256;

// --- store resolution --------------------------------------------------------
//
// Each Antigravity surface keeps its own on-disk STORE, all with one layout:
//   <root>/conversations/<id>.db          per-conversation SQLite (usage, model,
//                                         generated title, parent link)
//   <root>/brain/<id>/.system_generated/logs/transcript_full.jsonl
//   <root>/conversation_summaries.db      store-level index (see SUMMARY_SAFE_COLUMNS)
// Known roots under ~/.gemini, in priority order:
//   antigravity       the Antigravity desktop app
//   antigravity-cli   the `agy` terminal CLI
//   antigravity-ide   the legacy Antigravity IDE
// `antigravity-backup` is deliberately NOT a store (it is a copy of another one).
//
// On the live hook path the store is the one the hook's transcriptPath lives in
// (authoritative). Otherwise — or when the path lacks that shape — it is the first
// known store that holds <id>.db. A parent's subagent children are looked up in
// the parent's own store.
//
// Test overrides: AGY_CONVERSATIONS_DIR pins ONE store (its conversations dir;
// the summaries DB is that dir's sibling); AGY_BRAIN_DIR pins the brain dir;
// AGY_STORE_ROOTS (path.delimiter-separated) replaces the known-root list.
const STORE_ROOT_NAMES = Object.freeze(['antigravity', 'antigravity-cli', 'antigravity-ide']);
const TRANSCRIPT_TAIL = Object.freeze(['.system_generated', 'logs', 'transcript_full.jsonl']);

// A store descriptor rooted at `root`. opts.conversationsDir / opts.brainDir
// replace the default <root>/conversations and <root>/brain.
function storeAt(root, opts = {}) {
  return {
    root,
    conversationsDir: opts.conversationsDir || path.join(root, 'conversations'),
    brainDir: opts.brainDir || process.env.AGY_BRAIN_DIR || path.join(root, 'brain'),
    summariesDb: path.join(root, 'conversation_summaries.db'),
  };
}

/** The known stores, in priority order (see "store resolution"). */
function knownStores() {
  const pinned = process.env.AGY_CONVERSATIONS_DIR;
  if (pinned) return [storeAt(path.dirname(pinned), { conversationsDir: pinned })];
  const roots = process.env.AGY_STORE_ROOTS
    ? process.env.AGY_STORE_ROOTS.split(path.delimiter).filter(Boolean)
    : STORE_ROOT_NAMES.map((n) => path.join(os.homedir(), '.gemini', n));
  return roots.map((r) => storeAt(r));
}

/** Conversations dir of the highest-priority store (kept for callers/tests). */
function conversationsDir() {
  return knownStores()[0].conversationsDir;
}

// basename-guard a conversation id against traversal. null for an unusable id.
function safeId(conversationId) {
  const safe = path.basename(String(conversationId || ''));
  if (!safe || safe === '.' || safe === '..') return null;
  return safe;
}

// The first known store that holds <id>.db, or null.
function findStore(conversationId) {
  const safe = safeId(conversationId);
  if (!safe) return null;
  for (const s of knownStores()) {
    if (fs.existsSync(path.join(s.conversationsDir, `${safe}.db`))) return s;
  }
  return null;
}

// The store a transcript path belongs to, when it has the canonical shape
// <root>/brain/<id>/.system_generated/logs/transcript_full.jsonl (and <id>
// matches conversationId, when given). null otherwise, and always null while
// AGY_CONVERSATIONS_DIR pins a single store.
function storeFromTranscriptPath(transcriptPath, conversationId) {
  if (process.env.AGY_CONVERSATIONS_DIR) return null;
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  let p = transcriptPath;
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  p = path.resolve(p);
  for (let i = TRANSCRIPT_TAIL.length - 1; i >= 0; i--) {
    if (path.basename(p) !== TRANSCRIPT_TAIL[i]) return null;
    p = path.dirname(p);
  }
  const idDir = p; // <root>/brain/<id>
  const brainDir = path.dirname(idDir);
  if (path.basename(brainDir) !== 'brain') return null;
  const want = safeId(conversationId);
  if (want && path.basename(idDir) !== want) return null; // another conversation's transcript
  return storeAt(path.dirname(brainDir), { brainDir });
}

// The store a conversation lives in: the transcript's own store when the path
// has the canonical shape, else the first known store holding <id>.db, else null.
function resolveStore(conversationId, transcriptPath) {
  return storeFromTranscriptPath(transcriptPath, conversationId) || findStore(conversationId);
}

/**
 * Absolute DB path for a conversation id, in `store` when given, else in the
 * first known store that holds it (else the highest-priority store's path,
 * which may not exist). basename-guards against traversal.
 */
function dbPathFor(conversationId, store) {
  const safe = safeId(conversationId);
  if (!safe) return null;
  const s = store || findStore(safe) || knownStores()[0];
  return path.join(s.conversationsDir, `${safe}.db`);
}

// --- protobuf numbers-only walk ---------------------------------------------

// Read a base-128 varint from buf at offset i. Returns [value, nextOffset].
// THROWS on a truncated varint (caller treats the whole blob as un-parseable).
function readVarint(buf, i) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (i >= buf.length) throw new Error('truncated varint');
    const byte = buf[i++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  }
  return [result, i];
}

// Does `chunk` parse cleanly and completely as a protobuf message? Used to
// decide whether a length-delimited field is a nested message (descend) or
// opaque bytes/string (skip). Conservative: any malformation → not a message.
function looksLikeMessage(chunk) {
  let i = 0;
  let fields = 0;
  while (i < chunk.length) {
    let tag;
    try {
      [tag, i] = readVarint(chunk, i);
    } catch {
      return false;
    }
    const wire = Number(tag & 7n);
    const field = Number(tag >> 3n);
    if (field === 0) return false;
    if (wire === 0) {
      try {
        [, i] = readVarint(chunk, i);
      } catch {
        return false;
      }
    } else if (wire === 2) {
      let len;
      try {
        [len, i] = readVarint(chunk, i);
      } catch {
        return false;
      }
      const n = Number(len);
      if (n < 0 || i + n > chunk.length) return false;
      i += n;
    } else if (wire === 5) {
      i += 4;
      if (i > chunk.length) return false;
    } else if (wire === 1) {
      i += 8;
      if (i > chunk.length) return false;
    } else {
      return false; // wire types 3/4 (groups) — treat as not-a-message
    }
    fields += 1;
    if (fields > 4096) return false;
  }
  return i === chunk.length && fields > 0;
}

// Walk a protobuf message, collecting ONLY varint values into `out` keyed by
// dotted field path (e.g. "10.1.1"). Descends into length-delimited fields that
// parse as sub-messages; NEVER emits their bytes. Bounded by depth + entry count.
function collectVarints(buf, prefix, out, depth) {
  if (depth > MAX_DEPTH) return;
  let i = 0;
  while (i < buf.length) {
    if (Object.keys(out).length >= MAX_ENTRIES) return;
    let tag;
    try {
      [tag, i] = readVarint(buf, i);
    } catch {
      return; // give up on the rest of this (sub)message
    }
    const wire = Number(tag & 7n);
    const field = Number(tag >> 3n);
    if (field === 0) return;
    const key = prefix ? `${prefix}.${field}` : `${field}`;

    if (wire === 0) {
      let v;
      try {
        [v, i] = readVarint(buf, i);
      } catch {
        return;
      }
      // Emit as a JS number. Token counts are small; clamp absurd values out.
      if (v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) {
        const n = Number(v);
        // First write wins for a path; repeated fields keep the first.
        if (!(key in out)) out[key] = n;
      }
    } else if (wire === 2) {
      let len;
      try {
        [len, i] = readVarint(buf, i);
      } catch {
        return;
      }
      const n = Number(len);
      if (n < 0 || i + n > buf.length) return;
      const chunk = buf.subarray(i, i + n);
      i += n;
      // Descend ONLY if it parses as a message. Never emit the bytes.
      if (n > 0 && looksLikeMessage(chunk)) {
        collectVarints(chunk, key, out, depth + 1);
      }
    } else if (wire === 5) {
      i += 4; // fixed32 — skip (not a token count; could be float/content)
    } else if (wire === 1) {
      i += 8; // fixed64 — skip
    } else {
      return; // groups / unknown — stop
    }
  }
}

// Suppress node:sqlite's one-time ExperimentalWarning ONLY for the duration of a
// synchronous callback, restoring process.emitWarning immediately afterward. A
// PERSISTENT override of process.emitWarning breaks tooling that depends on it
// (notably the node:test runner's IPC), so the window must be as narrow as the
// require itself. Returns whatever `fn` returns.
function withoutSqliteExperimentalWarning(fn) {
  const orig = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
    const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (String(type) === 'ExperimentalWarning' && /sqlite/i.test(text)) return undefined;
    return orig.call(process, warning, ...rest);
  };
  try {
    return fn();
  } finally {
    process.emitWarning = orig;
  }
}

// Load Node's built-in SQLite driver (`DatabaseSync`). The package requires Node
// >=22.5 (see engines), where node:sqlite is always present, so this normally
// resolves; a null return only happens on a broken/patched runtime, and every
// caller is fail-safe against it (degrades to an empty read, never throws).
// Memoized — driver availability can't change mid-process.
let _databaseClass; // undefined = not yet resolved; null = resolved-unavailable
function getDatabaseClass() {
  if (_databaseClass !== undefined) return _databaseClass;
  try {
    const { DatabaseSync } = withoutSqliteExperimentalWarning(() => require('node:sqlite'));
    _databaseClass = DatabaseSync || null;
  } catch {
    _databaseClass = null; // node:sqlite unavailable — cache the negative result
  }
  return _databaseClass;
}

// --- public API --------------------------------------------------------------

// Open the conversation DB ONCE and derive BOTH the usage_raw map and the model
// id from a SINGLE pass over gen_metadata. readUsageRaw + readModel previously
// opened + scanned these same rows separately; on the collector path that ran 3-4×
// per session (parent + each child), so one combined pass halves the work per call.
// Returns { usageRaw, model } — either may be null. `store` (optional) is the
// conversation's resolved store. READ-ONLY, fail-safe; never throws.
function readGenMetadata(conversationId, store) {
  const DatabaseSync = getDatabaseClass();
  if (!DatabaseSync) return { usageRaw: null, model: null };

  const dbPath = dbPathFor(conversationId, store);
  if (!dbPath || !fs.existsSync(dbPath)) return { usageRaw: null, model: null };

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // One row per generation; SUM each varint path across the small usage rows to
    // get session totals (per-turn usage, like the Claude collector), and tally the
    // model-id-shaped tokens in the same pass. The big context/embedding rows are
    // skipped by size (they are model context, not usage/model labels).
    const rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx').all();
    const total = {};
    const modelCounts = new Map();
    for (const row of rows) {
      const blob = row && row.data;
      if (!blob || !(blob instanceof Uint8Array)) continue;
      if (blob.length > MAX_ROW_BYTES) continue; // embedding dump — not usage/model
      const b = Buffer.from(blob);
      // usage: sum each varint path across the small usage rows.
      const perRow = {};
      collectVarints(b, '', perRow, 0);
      for (const [k, v] of Object.entries(perRow)) {
        if (k in total) {
          if (total[k] + v <= Number.MAX_SAFE_INTEGER) total[k] += v;
        } else if (Object.keys(total).length < MAX_ENTRIES) {
          total[k] = v;
        }
      }
      // model: count each model-id-shaped token; most-frequent wins below.
      const text = b.toString('latin1');
      MODEL_ID_SCAN_RE.lastIndex = 0;
      let m;
      while ((m = MODEL_ID_SCAN_RE.exec(text)) !== null) {
        const id = m[0].toLowerCase();
        modelCounts.set(id, (modelCounts.get(id) || 0) + 1);
      }
    }
    const usageRaw = Object.keys(total).length > 0 ? total : null;
    let model = null;
    let bestN = -1;
    for (const [id, n] of modelCounts) {
      if (n > bestN) {
        model = id;
        bestN = n;
      }
    }
    return { usageRaw, model: model ? model.slice(0, 64) : null };
  } catch {
    return { usageRaw: null, model: null }; // locked / corrupt / schema drift — fail safe
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// Read usage_raw for a conversation. Returns a { "<path>": int } object, or null
// on ANY failure (missing/locked/corrupt DB, SQLite unavailable, no rows,
// nothing extractable). NEVER throws. Thin wrapper over the combined single pass.
function readUsageRaw(conversationId, store) {
  return readGenMetadata(conversationId, store).usageRaw;
}

// The resolved model id is the ONE allowlisted label we read from the DB (like
// the Claude collector's `model`). It is NOT free content: this strict pattern
// matches only a vendor model-id token (gemini-*/claude-*), so — as with the
// commit-SHA extraction — nothing but a model id can ever be emitted. The id is
// the internal one Antigravity stamps per generation (e.g. `gemini-3-flash-a`),
// which is exactly the key the server's pricing table uses.
const MODEL_ID_SCAN_RE = /\b(?:gemini|claude)-[a-z0-9][a-z0-9.-]{1,48}/gi;

// Read the resolved model id for a conversation, or null. Delegates to the
// combined single pass, which tallies model-id-shaped tokens across the small
// per-generation gen_metadata rows and returns the most frequent one. READ-ONLY,
// fail-safe (never throws).
function readModel(conversationId, store) {
  return readGenMetadata(conversationId, store).model;
}

// The generated session title — a short, model-produced summary (Title Case,
// e.g. "Create Hello World Script"), the direct analogue of Claude Code's
// ai-title and the contract's ONE authorized content-derived field. It lives at
// a FIXED protobuf path in the steps' step_payload; the raw user prompt sits at a
// DIFFERENT path, so targeting this exact path emits the title and never the
// prompt. (Verified across many real sessions: this path == the title shown in
// agy's /resume browser.)
const TITLE_PATH = '30.4';

// Collect the string value(s) found at the EXACT dotted protobuf path `target`.
// Descends length-delimited fields to reach the path but only ever pushes the
// string sitting at `target` — nothing else leaves. Used solely for the title.
function collectStringsAtPath(buf, prefix, target, out) {
  let i = 0;
  while (i < buf.length) {
    let tag;
    try {
      [tag, i] = readVarint(buf, i);
    } catch {
      return;
    }
    const w = Number(tag & 7n);
    const f = Number(tag >> 3n);
    if (f === 0) return;
    const key = prefix ? `${prefix}.${f}` : `${f}`;
    if (w === 0) {
      try {
        [, i] = readVarint(buf, i);
      } catch {
        return;
      }
    } else if (w === 2) {
      let len;
      try {
        [len, i] = readVarint(buf, i);
      } catch {
        return;
      }
      const n = Number(len);
      if (n < 0 || i + n > buf.length) return;
      const chunk = buf.subarray(i, i + n);
      i += n;
      if (key === target) {
        const s = chunk.toString('utf8');
        if (s) out.push(s);
      } else {
        collectStringsAtPath(chunk, key, target, out);
      }
    } else if (w === 5) {
      i += 4;
    } else if (w === 1) {
      i += 8;
    } else {
      return;
    }
  }
}

// A generated title is a single-line summary. Reject any candidate that is
// multi-line or carries control characters — those shapes signal we have drifted
// off TITLE_PATH onto prompt/response or code body text (e.g. an upstream agy
// protobuf-field renumber), which must NEVER leave the machine. Defense-in-depth
// on top of TITLE_PATH being the empirically verified title location.
function looksLikeTitle(s) {
  return typeof s === 'string' && s.length > 0 && !/[\x00-\x1f\x7f]/.test(s);
}

// Read the generated session title for a conversation, or null. Scans the steps'
// step_payload for the string at TITLE_PATH and returns the latest non-empty one
// that passes the title shape-guard (the title is refined as the session grows).
// The desktop app does not write TITLE_PATH; when the scan yields nothing, fall
// back to the store index's `title` column (readSummaryTitle). READ-ONLY, fail-safe.
function readTitle(conversationId, store) {
  return readStepTitle(conversationId, store) || readSummaryTitle(conversationId, store);
}

function readStepTitle(conversationId, store) {
  const DatabaseSync = getDatabaseClass();
  if (!DatabaseSync) return null;

  const dbPath = dbPathFor(conversationId, store);
  if (!dbPath || !fs.existsSync(dbPath)) return null;

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT step_payload FROM steps ORDER BY idx').all();
    let title = null;
    for (const row of rows) {
      const blob = row && row.step_payload;
      if (!blob || !(blob instanceof Uint8Array)) continue;
      const out = [];
      collectStringsAtPath(Buffer.from(blob), '', TITLE_PATH, out);
      // Latest non-empty, title-shaped candidate wins.
      for (const s of out) {
        const t = s && s.trim();
        if (t && looksLikeTitle(t)) title = t;
      }
    }
    return title ? title.slice(0, 200) : null;
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// --- store index (conversation_summaries.db) ---------------------------------
//
// PRIVACY: the store index ALSO holds conversation CONTENT — `preview` (prompt/
// response text), `raw_summary` (a serialized summary blob) and the
// `conversations_fts*` full-text tables. We read ONLY the named columns in
// SUMMARY_SAFE_COLUMNS, each by exact name in its own single-row SELECT keyed by
// conversation_id: the generated `title` (same allowlisted field as TITLE_PATH),
// the short subagent label `agent_name`, and the `workspace_uris` folder list
// (the same repo path the hook's workspacePaths carries). NEVER `SELECT *`, never
// select `preview`/`raw_summary`, never touch a `conversations_fts*` table. One
// statement per column also means an older store schema missing a column only
// nulls that field. READ-ONLY, fail-safe (missing/locked/corrupt DB → nulls).
const SUMMARY_SAFE_COLUMNS = Object.freeze(['title', 'agent_name', 'workspace_uris']);

// { <column>: string|null } for the requested allowlisted columns. A column
// outside SUMMARY_SAFE_COLUMNS is never queried (stays null).
function readSummaryColumns(conversationId, store, columns) {
  const out = {};
  for (const c of columns) out[c] = null;
  const DatabaseSync = getDatabaseClass();
  const safe = safeId(conversationId);
  const s = store || findStore(safe);
  if (!DatabaseSync || !safe || !s || !fs.existsSync(s.summariesDb)) return out;
  let db = null;
  try {
    db = new DatabaseSync(s.summariesDb, { readOnly: true });
    for (const c of columns) {
      if (!SUMMARY_SAFE_COLUMNS.includes(c)) continue;
      try {
        const row = db
          .prepare(`SELECT ${c} AS v FROM conversation_summaries WHERE conversation_id = ?`)
          .get(safe);
        if (row && typeof row.v === 'string' && row.v) out[c] = row.v;
      } catch {
        /* column/table absent in this store's schema — field stays null */
      }
    }
  } catch {
    /* locked / corrupt — all fields stay null */
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

// The store index's generated title for a conversation, through the same
// single-line shape-guard + 200-char cap as the TITLE_PATH scan. null if absent.
function readSummaryTitle(conversationId, store) {
  const v = readSummaryColumns(conversationId, store, ['title']).title;
  const t = v && v.trim();
  return t && looksLikeTitle(t) ? t.slice(0, 200) : null;
}

// Labels the store index uses that say nothing about the subagent's type:
// `self` marks a fork of the parent agent itself.
const UNINFORMATIVE_AGENT_NAMES = new Set(['self']);
const MAX_LABEL = 128; // matches the schema's agent_type maxLength

// A subagent child's short label from the store index (`agent_name`), or null
// when absent, uninformative (`self`), or not label-shaped. Capped to MAX_LABEL.
function readSummaryAgentName(conversationId, store) {
  const v = readSummaryColumns(conversationId, store, ['agent_name']).agent_name;
  const t = v && v.trim();
  if (!t || !looksLikeTitle(t) || UNINFORMATIVE_AGENT_NAMES.has(t.toLowerCase())) return null;
  return t.slice(0, MAX_LABEL);
}

// The first file:// workspace folder the store index recorded for a
// conversation, decoded to a filesystem path, or null. `workspace_uris` is a JSON
// array of URIs; non-file schemes are ignored.
function readSummaryWorkspacePath(conversationId, store) {
  const v = readSummaryColumns(conversationId, store, ['workspace_uris']).workspace_uris;
  if (!v) return null;
  try {
    const uris = JSON.parse(v);
    if (!Array.isArray(uris)) return null;
    for (const u of uris) {
      if (typeof u === 'string' && u.startsWith('file://')) return fileURLToPath(u);
    }
  } catch {
    /* malformed JSON / URI */
  }
  return null;
}

// --- subagent linkage --------------------------------------------------------
//
// agy runs each subagent as a SEPARATE conversation (its own DB/transcript). The
// child stores its PARENT's conversationId in trajectory_metadata_blob at protobuf
// path 5 (verified). We use that to (a) detect+suppress a child's own standalone
// post and (b) find a parent's children by reverse scan, so the parent can nest
// them — Claude-style — into payload.antigravity.subagents[].

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARENT_ID_PATH = '5'; // trajectory_metadata_blob → parent conversationId

// Parent conversationId for a child, or null if this conversation is not a
// subagent child. `store` (optional) is the child's resolved store. READ-ONLY,
// fail-safe.
function readParentId(conversationId, store) {
  const DatabaseSync = getDatabaseClass();
  if (!DatabaseSync) return null;

  const dbPath = dbPathFor(conversationId, store);
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    let rows;
    try {
      rows = db.prepare('SELECT data FROM trajectory_metadata_blob').all();
    } catch {
      return null; // table absent → not a child
    }
    const self = path.basename(String(conversationId || ''));
    for (const row of rows) {
      const blob = row && row.data;
      if (!blob || !(blob instanceof Uint8Array)) continue;
      const out = [];
      collectStringsAtPath(Buffer.from(blob), '', PARENT_ID_PATH, out);
      for (const s of out) {
        if (UUID_RE.test(s) && !s.startsWith(self)) return s;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// The reverse-engineered semantic paths inside a usage_raw map (per-generation
// sums). THE one place this knowledge lives on the client — used only to label
// nested subagents' tokens (the session's own usage_raw stays raw → server-mapped).
//   input     1.4.2  uncached new input tokens
//   output    1.4.3  output tokens
//   cacheRead 1.4.5  cached-prefix (cache-read) input tokens
// proto3 omits zero-valued varints, so an absent path means 0 for that turn.
const USAGE_PATHS = Object.freeze({ input: '1.4.2', output: '1.4.3', cacheRead: '1.4.5' });

// Project a usage_raw object to { input, output, cacheRead }, or null. Pure, so
// callers that already hold usage_raw (from a combined readGenMetadata) don't
// re-read the DB just to map it.
function usageInputOutput(usageRaw) {
  if (!usageRaw) return null;
  return {
    input: usageRaw[USAGE_PATHS.input] || 0,
    output: usageRaw[USAGE_PATHS.output] || 0,
    cacheRead: usageRaw[USAGE_PATHS.cacheRead] || 0,
  };
}

function readUsageInputOutput(conversationId, store) {
  return usageInputOutput(readUsageRaw(conversationId, store));
}

// Find the child conversationIds whose parent is `parentId`: a reverse scan of
// the PARENT's own store (`store`, else the first known store holding the
// parent; none → []). Bounded by MAX_CHILDREN. READ-ONLY, fail-safe → [] on any
// error.
function findChildren(parentId, store) {
  if (!parentId) return [];
  const s = store || findStore(parentId);
  if (!s) return [];
  let entries;
  try {
    entries = fs.readdirSync(s.conversationsDir);
  } catch {
    return [];
  }
  const children = [];
  for (const name of entries) {
    if (!name.endsWith('.db')) continue;
    const id = name.slice(0, -3);
    if (id === parentId) continue;
    try {
      if (readParentId(id, s) === parentId) children.push(id);
    } catch {
      /* skip */
    }
    if (children.length >= MAX_CHILDREN) break; // sanity cap
  }
  return children;
}

// Which of the known `candidateNames` (the parent's declared subagent names)
// appears in this child's gen_metadata — i.e. the child's agent_type. We match
// only against the KNOWN content-safe labels, never free text. null if none.
function readAgentType(conversationId, candidateNames, store) {
  if (!Array.isArray(candidateNames) || candidateNames.length === 0) return null;
  const DatabaseSync = getDatabaseClass();
  if (!DatabaseSync) return null;

  const dbPath = dbPathFor(conversationId, store);
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx').all();
    for (const row of rows) {
      const blob = row && row.data;
      if (!blob || !(blob instanceof Uint8Array)) continue;
      // The child's own type label often sits in the LARGE context row (its
      // system prompt), so unlike usage we don't size-skip here. We only ever
      // return one of the KNOWN content-safe candidate names — never free text.
      if (blob.length > 4 * 1024 * 1024) continue; // pathological guard only
      const text = Buffer.from(blob).toString('latin1');
      for (const name of candidateNames) {
        if (typeof name === 'string' && name && text.includes(name)) return name;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// Last-modified time of a conversation DB, counting its write-ahead log: agy
// keeps the DB in WAL mode, so recent writes land in <db>-wal and the main file's
// mtime only moves on a checkpoint (often days later). Returns the newer of the
// two; a missing WAL just means the main file's mtime. THROWS if the DB itself
// can't be stat'd (the caller skips that copy).
function dbMtimeMs(dbPath) {
  const main = fs.statSync(dbPath).mtimeMs;
  try {
    return Math.max(main, fs.statSync(`${dbPath}-wal`).mtimeMs);
  } catch {
    return main; // no WAL (checkpointed / closed cleanly)
  }
}

// List EVERY top-level agy conversation across ALL known stores (subagent
// children excluded — they fold into their parent). An id present in more than
// one store is listed once, from the store whose DB was written most recently
// (dbMtimeMs, WAL included); an id that is a child in any store is excluded.
// Returns [{ id, mtimeMs, store }] newest-first by mtimeMs — `store` lets the
// caller build the transcript path in the matching store. READ-ONLY, fail-safe →
// [] on any error. Never throws.
function listConversationIds() {
  const byId = new Map();
  const childIds = new Set();
  for (const store of knownStores()) {
    let entries;
    try {
      entries = fs.readdirSync(store.conversationsDir);
    } catch {
      continue; // store absent on this machine
    }
    for (const name of entries) {
      if (!name.endsWith('.db')) continue;
      const id = name.slice(0, -3);
      let parentId;
      try {
        parentId = readParentId(id, store);
      } catch {
        parentId = null; // failed lookup → don't drop a real session, include it
      }
      if (parentId) {
        childIds.add(id); // has a parent → subagent child, exclude
        continue;
      }
      let mtimeMs;
      try {
        mtimeMs = dbMtimeMs(path.join(store.conversationsDir, name));
      } catch {
        continue; // stat failed → skip this copy
      }
      const prev = byId.get(id);
      if (!prev || mtimeMs > prev.mtimeMs) byId.set(id, { id, mtimeMs, store });
    }
  }
  const out = [...byId.values()].filter((d) => !childIds.has(d.id));
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

module.exports = {
  STORE_ROOT_NAMES,
  knownStores,
  findStore,
  storeFromTranscriptPath,
  resolveStore,
  conversationsDir,
  dbPathFor,
  readVarint,
  looksLikeMessage,
  collectVarints,
  collectStringsAtPath,
  looksLikeTitle,
  readGenMetadata,
  readUsageRaw,
  readModel,
  readTitle,
  readSummaryTitle,
  readSummaryAgentName,
  readSummaryWorkspacePath,
  readParentId,
  USAGE_PATHS,
  usageInputOutput,
  readUsageInputOutput,
  findChildren,
  readAgentType,
  getDatabaseClass,
  listConversationIds,
  dbMtimeMs,
  SUMMARY_SAFE_COLUMNS,
  MAX_CHILDREN,
  TITLE_PATH,
};
