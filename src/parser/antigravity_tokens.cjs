'use strict';

// ATTRIBUT — Google Antigravity token reader (ISOLATED, FAIL-SAFE).
//
// Antigravity does NOT expose token usage in its hook payload or its JSONL
// transcript. The only local source is the per-conversation SQLite store at
// ~/.gemini/antigravity-cli/conversations/<conversationId>.db, table
// `gen_metadata` — one row PER MODEL GENERATION, each a protobuf blob carrying
// that turn's usage (verified: path 1.4.2 ≈ prompt/input tokens, 1.4.3 ≈ output
// tokens; values scale with real session size, unlike `executor_metadata` which
// holds only static config/limits). We SUM each varint path across the small
// per-generation rows to get session totals, and skip the oversized embedding
// rows (the large blobs are model-context dumps, not usage).
//
// This module reads that DB and returns a `usage_raw` map of { "<dotted field
// path>": integer }. It deliberately knows NOTHING about which field is input vs
// output — that semantic mapping is reverse-engineered and applied server-side
// in ingest_worker, so it can change without reshipping the collector.
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

// Bounds: agy's executor_metadata is ~3 KB. These caps stop a pathological blob
// from blowing up memory/output and keep usage_raw within the schema's limits.
const MAX_DEPTH = 7;
const MAX_ENTRIES = 128; // matches the schema's maxProperties on usage_raw
// Per-generation usage rows are ~1-2 KB; the embedding/context dumps are 100 KB+.
// Only walk rows at or below this size — the big rows are model context, not usage.
const MAX_ROW_BYTES = 8192;

/** Conversations dir; override via AGY_CONVERSATIONS_DIR for tests. */
function conversationsDir() {
  return (
    process.env.AGY_CONVERSATIONS_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations')
  );
}

/** Absolute DB path for a conversation id. basename-guards against traversal. */
function dbPathFor(conversationId) {
  const safe = path.basename(String(conversationId || ''));
  if (!safe || safe === '.' || safe === '..') return null;
  return path.join(conversationsDir(), `${safe}.db`);
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

// Central helper to load a SQLite database driver class.
// Mimics Node's `DatabaseSync` interface so that we support both node:sqlite and better-sqlite3 seamlessly.
// Memoized: driver availability can't change mid-process, so the `require` resolution
// (including a permanent null when no driver exists) is cached after the first call.
let _databaseClass; // undefined = not yet resolved; null = resolved-unavailable
function getDatabaseClass() {
  if (_databaseClass !== undefined) return _databaseClass;
  try {
    const { DatabaseSync } = require('node:sqlite');
    if (DatabaseSync) {
      _databaseClass = DatabaseSync;
      return _databaseClass;
    }
  } catch {
    /* fallback to better-sqlite3 */
  }

  try {
    const BetterSqlite3 = require('better-sqlite3');
    _databaseClass = class DatabaseSyncFallback {
      constructor(path, options) {
        const readonly = !!(options && options.readOnly);
        this.db = new BetterSqlite3(path, { readonly });
      }
      exec(sql) {
        this.db.exec(sql);
      }
      prepare(sql) {
        const stmt = this.db.prepare(sql);
        return {
          all(...args) {
            return stmt.all(...args);
          },
          run(...args) {
            return stmt.run(...args);
          }
        };
      }
      close() {
        this.db.close();
      }
    };
    return _databaseClass;
  } catch {
    _databaseClass = null; // no driver available — cache the negative result
    return _databaseClass;
  }
}

// --- public API --------------------------------------------------------------

// Open the conversation DB ONCE and derive BOTH the usage_raw map and the model
// id from a SINGLE pass over gen_metadata. readUsageRaw + readModel previously
// opened + scanned these same rows separately; on the collector path that ran 3-4×
// per session (parent + each child), so one combined pass halves the work per call.
// Returns { usageRaw, model } — either may be null. READ-ONLY, fail-safe; never throws.
function readGenMetadata(conversationId) {
  const DatabaseSync = getDatabaseClass();
  if (!DatabaseSync) return { usageRaw: null, model: null };

  const dbPath = dbPathFor(conversationId);
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
      MODEL_ID_RE.lastIndex = 0;
      let m;
      while ((m = MODEL_ID_RE.exec(text)) !== null) {
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
function readUsageRaw(conversationId) {
  return readGenMetadata(conversationId).usageRaw;
}

// The resolved model id is the ONE allowlisted label we read from the DB (like
// the Claude collector's `model`). It is NOT free content: this strict pattern
// matches only a vendor model-id token (gemini-*/claude-*), so — as with the
// commit-SHA extraction — nothing but a model id can ever be emitted. The id is
// the internal one Antigravity stamps per generation (e.g. `gemini-3-flash-a`),
// which is exactly the key the server's pricing table uses.
const MODEL_ID_RE = /\b(?:gemini|claude)-[a-z0-9][a-z0-9.-]{1,48}/gi;

// Read the resolved model id for a conversation, or null. Delegates to the
// combined single pass, which tallies model-id-shaped tokens across the small
// per-generation gen_metadata rows and returns the most frequent one. READ-ONLY,
// fail-safe (never throws).
function readModel(conversationId) {
  return readGenMetadata(conversationId).model;
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
// READ-ONLY, fail-safe.
function readTitle(conversationId) {
  const DatabaseSync = getDatabaseClass();
  if (!DatabaseSync) return null;

  const dbPath = dbPathFor(conversationId);
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
// subagent child. READ-ONLY, fail-safe.
function readParentId(conversationId) {
  const DatabaseSync = getDatabaseClass();
  if (!DatabaseSync) return null;

  const dbPath = dbPathFor(conversationId);
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

// Semantic input/output token totals for a conversation (the RE'd 1.4.2/1.4.3
// paths). Used for nested subagents, whose tokens must be labelled client-side
// (the parent's own tokens stay raw → server-mapped). { input, output } or null.
function readUsageInputOutput(conversationId) {
  const u = readUsageRaw(conversationId);
  if (!u) return null;
  return { input: u['1.4.2'] || 0, output: u['1.4.3'] || 0 };
}

// Find the child conversationIds whose parent is `parentId` (reverse scan of the
// conversations dir). Bounded. READ-ONLY, fail-safe → [] on any error.
function findChildren(parentId) {
  if (!parentId) return [];
  let entries;
  try {
    entries = fs.readdirSync(conversationsDir());
  } catch {
    return [];
  }
  const children = [];
  for (const name of entries) {
    if (!name.endsWith('.db')) continue;
    const id = name.slice(0, -3);
    if (id === parentId) continue;
    try {
      if (readParentId(id) === parentId) children.push(id);
    } catch {
      /* skip */
    }
    if (children.length >= 64) break; // sanity cap
  }
  return children;
}

// Which of the known `candidateNames` (the parent's declared subagent names)
// appears in this child's gen_metadata — i.e. the child's agent_type. We match
// only against the KNOWN content-safe labels, never free text. null if none.
function readAgentType(conversationId, candidateNames) {
  if (!Array.isArray(candidateNames) || candidateNames.length === 0) return null;
  const DatabaseSync = getDatabaseClass();
  if (!DatabaseSync) return null;

  const dbPath = dbPathFor(conversationId);
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

// List EVERY top-level agy conversation id (subagent children excluded — they
// fold into their parent). Returns [{ id, mtimeMs }] newest-first by mtime.
// READ-ONLY, fail-safe → [] on any error. Never throws.
function listConversationIds() {
  let entries;
  try {
    entries = fs.readdirSync(conversationsDir());
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.db')) continue;
    const id = name.slice(0, -3);
    let parentId;
    try {
      parentId = readParentId(id);
    } catch {
      parentId = null; // failed lookup → don't drop a real session, include it
    }
    if (parentId) continue; // has a parent → subagent child, exclude
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(dbPathFor(id)).mtimeMs;
    } catch {
      continue; // stat failed → skip this id
    }
    out.push({ id, mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

module.exports = {
  conversationsDir,
  dbPathFor,
  readVarint,
  looksLikeMessage,
  collectVarints,
  collectStringsAtPath,
  looksLikeTitle,
  readUsageRaw,
  readModel,
  readTitle,
  readParentId,
  readUsageInputOutput,
  findChildren,
  readAgentType,
  getDatabaseClass,
  listConversationIds,
  TITLE_PATH,
};
