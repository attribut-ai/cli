'use strict';

// CRITICAL allowlist guarantee for Antigravity: NO prohibited content (prompts,
// assistant bodies, thinking, tool args, file content, command output, commit
// bodies) may appear anywhere in the serialized envelope — from the transcript
// OR the SQLite token store. Positive controls confirm the fixture actually
// exercises the safe extraction paths.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const agy = require('../src/parser/antigravity_cli.cjs');
const tokens = require('../src/parser/antigravity_tokens.cjs');
const { buildAndValidate } = require('../src/envelope.cjs');
const { buildSyntheticDb } = require('./fixtures/agy/build_db.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'agy', 'transcript_full.jsonl');

// Every sentinel seeded in the fixture transcript at a PROHIBITED location.
const TRANSCRIPT_SENTINELS = [
  'SECRET_PROMPT_TEXT',
  'ASSISTANT_RESPONSE_BODY',
  'THINKING_SECRET',
  'LIST_OUTPUT_SECRET',
  'FILE_DIFF_SECRET_COMMENT',
  'FILE_DIFF_SECRET_CODE',
  'WRITE_DESC_SECRET',
  'CODE_ACTION_OUTPUT_SECRET',
  'COMMIT_MSG_SECRET',
  'RUN_OUTPUT_SECRET',
  'FINAL_ASSISTANT_SECRET',
  // replace_file_content (edit) — before/after content + labels must not leak.
  'REPLACE_BEFORE_SECRET',
  'REPLACE_AFTER_SECRET',
  'REPLACE_COMMENT_SECRET',
  'REPLACE_INSTRUCTION_SECRET',
  'REPLACE_DESC_SECRET',
  'REPLACE_RESULT_SECRET',
];

let nodeSqlite = false;
try {
  const { getDatabaseClass } = require('../src/parser/antigravity_tokens.cjs');
  if (getDatabaseClass()) {
    nodeSqlite = true;
  }
} catch {
  nodeSqlite = false;
}

test('no prohibited transcript content appears in the envelope', () => {
  const payload = agy.parseAntigravityTranscript(FIXTURE, {
    sessionId: 'conv-priv',
    repo: '/tmp/agy_fix',
    device_uuid: 'dev-1',
  });
  const env = buildAndValidate(payload, {
    _trigger: 'posttooluse',
    _source: 'cli',
    _provider: 'google',
    _tool: 'antigravity',
  });
  const serialized = JSON.stringify(env);
  for (const s of TRANSCRIPT_SENTINELS) {
    assert.ok(!serialized.includes(s), `LEAK: transcript sentinel "${s}" found in envelope`);
  }
});

test('positive controls: the safe signals WERE extracted', () => {
  const p = agy.parseAntigravityTranscript(FIXTURE, { sessionId: 'c', repo: '/r' });
  assert.deepStrictEqual(p.commitSHA, ['a1b2c3d']); // SHA from commit stdout
  assert.strictEqual(p.branch, 'feature/agy-test'); // branch from bracket
  assert.strictEqual(p.lines_code_added, 4); // write (2) + replace (2) classified
  assert.strictEqual(p.lines_code_removed, 1); // replace diff
  assert.strictEqual(p.lines_comment_added, 1);
  assert.strictEqual(p.num_tool_calls, 4); // list_dir, write, run_command, replace
});

test('no DB content leaks once usage_raw is injected', { skip: !nodeSqlite }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-priv-db-'));
  const prev = process.env.AGY_CONVERSATIONS_DIR;
  process.env.AGY_CONVERSATIONS_DIR = dir;
  try {
    buildSyntheticDb(dir, 'conv-priv', {
      input: 1111,
      output: 22,
      contentSentinel: 'SQLITE_CONTENT_LEAK_SENTINEL',
    });
    const payload = agy.parseAntigravityTranscript(FIXTURE, { sessionId: 'conv-priv' });
    payload.antigravity.usage_raw = tokens.readUsageRaw('conv-priv');
    const env = buildAndValidate(payload, {
      _trigger: 'posttooluse',
      _source: 'cli',
      _provider: 'google',
      _tool: 'antigravity',
    });
    const serialized = JSON.stringify(env);
    assert.ok(!serialized.includes('SQLITE_CONTENT_LEAK_SENTINEL'), 'LEAK: DB content in envelope');
    // and the real token varints DID make it through (positive control)
    assert.strictEqual(payload.antigravity.usage_raw['1.4.2'], 1111);
    assert.strictEqual(payload.antigravity.usage_raw['1.4.3'], 22);
  } finally {
    if (prev === undefined) delete process.env.AGY_CONVERSATIONS_DIR;
    else process.env.AGY_CONVERSATIONS_DIR = prev;
  }
});
