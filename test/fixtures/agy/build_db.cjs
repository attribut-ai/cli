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
//   field1 { field4 { field2=input, field3=output, field9="<contentSentinel>" } }
// → token paths 1.4.2 / 1.4.3; the sentinel sits at a length-delimited field the
// numbers-only walk must skip.
function encodeGenRow({ input, output, contentSentinel, model, agentType }) {
  const usage = Buffer.concat([
    varintField(2, input),
    varintField(3, output),
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
    throw new Error('No SQLite driver available (neither node:sqlite nor better-sqlite3 found)');
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
    [{ input: opts.input != null ? opts.input : 1234, output: opts.output != null ? opts.output : 567, contentSentinel: opts.contentSentinel || 'DB_CONTENT_SECRET' }];

  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER DEFAULT 0)');
  const stmt = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
  let idx = 0;
  for (const r of rows) {
    const blob = encodeGenRow({
      input: r.input,
      output: r.output,
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

module.exports = { buildSyntheticDb, encodeGenRow };
