'use strict';

// Test helper: build a synthetic agy conversation SQLite DB whose `gen_metadata`
// table mirrors the real one — one row per generation, each a protobuf blob with
// usage varints at path 1.4.2 (input/prompt) and 1.4.3 (output), PLUS a
// length-delimited string field carrying a content sentinel the numbers-only
// token walk must NEVER emit. Optionally adds an oversized "embedding" row that
// the reader must skip. Built with node:sqlite (same engine the reader uses).

const path = require('path');
const fs = require('fs');

function varint(n) {
  const bytes = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function tag(field, wire) {
  return varint((field << 3) | wire);
}

function lenField(field, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([tag(field, 2), varint(buf.length), buf]);
}

function varintField(field, n) {
  return Buffer.concat([tag(field, 0), varint(n)]);
}

// Encode one generation's gen_metadata row:
//   field1 { field4 { field2=input, field3=output, field5=cacheRead?,
//                     field9="<contentSentinel>" } }
// → token paths 1.4.2 / 1.4.3 / 1.4.5; the sentinel sits at a length-delimited
// field the numbers-only walk must skip. cacheRead is omitted when absent/0 (as
// proto3 omits zero-valued varints).
function encodeGenRow({ input, output, cacheRead, contentSentinel, model, agentType }) {
  const usage = Buffer.concat([
    varintField(2, input),
    varintField(3, output),
    cacheRead ? varintField(5, cacheRead) : Buffer.alloc(0),
    lenField(9, contentSentinel),
  ]);
  const field4 = lenField(4, usage);
  // A model-id label string somewhere in the row (readModel scans for the
  // gemini-*/claude-* pattern). Default to a real priced id.
  const modelField = lenField(5, model || 'gemini-3-flash-a');
  // Optional agent-type label (readAgentType substring-matches known names).
  const agentField = agentType ? lenField(6, agentType) : Buffer.alloc(0);
  const field1 = lenField(1, Buffer.concat([field4, modelField, agentField]));
  return field1;
}

// Create <dir>/<conversationId>.db with a gen_metadata table. `rows` is an array
// of { input, output, contentSentinel } usage rows (summed by the reader). Pass
// opts.bigRow to also insert an oversized blob the reader must skip.
function buildSyntheticDb(dir, conversationId, opts = {}) {
  const { getDatabaseClass } = require('../../../src/parser/antigravity_tokens.cjs');
  const DatabaseSync = getDatabaseClass();
  if (!DatabaseSync) {
    throw new Error('No SQLite driver available (node:sqlite not found — requires Node >=22.5)');
  }
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, `${conversationId}.db`);
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* absent */
    }
  }
  const rows =
    opts.rows ||
    [{ input: opts.input != null ? opts.input : 1234, output: opts.output != null ? opts.output : 567, cacheRead: opts.cacheRead, contentSentinel: opts.contentSentinel || 'DB_CONTENT_SECRET' }];

  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0)');
  const stmt = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
  let idx = 0;
  for (const r of rows) {
    const blob = encodeGenRow({
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead,
      contentSentinel: r.contentSentinel || 'DB_CONTENT_SECRET',
      model: r.model || opts.model,
      agentType: r.agentType || opts.agentType,
    });
    stmt.run(idx++, blob, blob.length);
  }
  if (opts.bigRow) {
    // An oversized "embedding" row carrying a sentinel + huge varints; the reader
    // skips rows over its size threshold, so none of this must surface.
    const big = Buffer.concat([
      varintField(2, 9999999),
      lenField(9, 'BIG_ROW_CONTENT_SECRET'),
      Buffer.alloc(9000, 0x01),
    ]);
    stmt.run(idx++, big, big.length);
  }

  // trajectory_metadata_blob: readParentId reads the parent conversationId at
  // protobuf path 5 (present only for subagent children).
  db.exec('CREATE TABLE trajectory_metadata_blob (idx INTEGER PRIMARY KEY, data BLOB)');
  if (opts.parentId) {
    const blob = lenField(5, opts.parentId); // path "5"
    db.prepare('INSERT INTO trajectory_metadata_blob (idx, data) VALUES (?, ?)').run(0, blob);
  }

  // steps table: readTitle pulls the generated title from step_payload path 30.4.
  // We also plant a prompt at the SIBLING path 30.5 to prove the title extractor
  // never emits the adjacent prompt.
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_payload BLOB)');
  if (opts.title || opts.prompt) {
    const inner = Buffer.concat([
      opts.title ? lenField(4, opts.title) : Buffer.alloc(0),
      opts.prompt ? lenField(5, opts.prompt) : Buffer.alloc(0),
    ]);
    const stepPayload = lenField(30, inner); // → title at 30.4, prompt at 30.5
    db.prepare('INSERT INTO steps (idx, step_payload) VALUES (?, ?)').run(0, stepPayload);
  }

  db.close();
  return dbPath;
}

// Create <storeRoot>/conversation_summaries.db — the store-level index the
// desktop app keeps. Mirrors the real column set, INCLUDING the content-bearing
// columns (`preview`, `raw_summary`) and a full-text content table, so tests can
// plant sentinels there and prove the reader never selects them. `rows` items:
// { conversation_id, title?, preview?, raw_summary?, agent_name?,
//   parent_conversation_id?, workspace_uris? (array → JSON; a string is stored
//   verbatim, for malformed-value tests), fts? (planted in the full-text table) }.
// opts.legacy builds an older schema WITHOUT agent_name / workspace_uris, to
// prove every column read is fail-safe on its own.
function buildSummariesDb(storeRoot, rows, opts = {}) {
  const { getDatabaseClass } = require('../../../src/parser/antigravity_tokens.cjs');
  const DatabaseSync = getDatabaseClass();
  if (!DatabaseSync) throw new Error('No SQLite driver available (node:sqlite)');
  fs.mkdirSync(storeRoot, { recursive: true });
  const dbPath = path.join(storeRoot, 'conversation_summaries.db');
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* absent */
  }
  const db = new DatabaseSync(dbPath);
  const cols = opts.legacy
    ? ['conversation_id', 'title', 'preview', 'parent_conversation_id', 'raw_summary']
    : ['conversation_id', 'title', 'preview', 'agent_name', 'parent_conversation_id', 'workspace_uris', 'raw_summary'];
  db.exec(
    `CREATE TABLE conversation_summaries (${cols
      .map((c) => (c === 'raw_summary' ? 'raw_summary BLOB' : `${c} TEXT NOT NULL DEFAULT ''`))
      .join(', ')}, PRIMARY KEY (conversation_id))`
  );
  db.exec('CREATE TABLE conversations_fts_content (id INTEGER PRIMARY KEY, c0 TEXT, c1 TEXT)');
  const insert = db.prepare(
    `INSERT INTO conversation_summaries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  );
  const fts = db.prepare('INSERT INTO conversations_fts_content (c0, c1) VALUES (?, ?)');
  for (const r of rows) {
    const values = cols.map((c) => {
      if (c === 'workspace_uris') {
        return typeof r.workspace_uris === 'string' ? r.workspace_uris : JSON.stringify(r.workspace_uris || []);
      }
      if (c === 'raw_summary') return Buffer.from(r.raw_summary || '');
      return r[c] != null ? String(r[c]) : '';
    });
    insert.run(...values);
    if (r.fts) fts.run(r.conversation_id, r.fts);
  }
  db.close();
  return dbPath;
}

// Write <brainDir>/<id>/.system_generated/logs/transcript_full.jsonl (the
// canonical transcript location inside a store). `content` is the raw JSONL.
function writeBrainTranscript(brainDir, conversationId, content) {
  const dir = path.join(brainDir, conversationId, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'transcript_full.jsonl');
  fs.writeFileSync(p, content);
  return p;
}

module.exports = { buildSyntheticDb, buildSummariesDb, writeBrainTranscript, encodeGenRow };
