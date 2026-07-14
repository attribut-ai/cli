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

// --- Subagent (child transcript) line-count privacy -------------------------
//
// The per-subagent 9-key structural breakdown (added Jul-2026) is derived by
// childStats() re-reading the CHILD's OWN brainTranscriptPath and running the
// SAME classifier (accumulateFileChange/classifyInto) the session-level path
// uses — a distinct code path from the top-level transcript this file's other
// tests cover. Plant a unique code string in a child's write_to_file tool call,
// then prove (a) the subagent's lines_* counts are non-zero — the count WAS
// derived from that content — and (b) the code text itself never appears
// anywhere in buildAntigravitySubagents' output nor in a full envelope built
// around it (mirroring how the real collector attaches
// payload.antigravity.subagents, see src/collector.cjs).
test(
  'subagent line counts are derived from the child\'s own code but the code text never leaks',
  { skip: !nodeSqlite },
  () => {
    const { buildSyntheticDb } = require('./fixtures/agy/build_db.cjs');
    const conv = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-priv-sa-conv-'));
    const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-priv-sa-brain-'));
    const prevC = process.env.AGY_CONVERSATIONS_DIR;
    const prevB = process.env.AGY_BRAIN_DIR;
    process.env.AGY_CONVERSATIONS_DIR = conv;
    process.env.AGY_BRAIN_DIR = brain;

    const PA = '44444444-4444-4444-4444-444444444444';
    const K1 = '55555555-5555-5555-5555-555555555555';
    const AGY_SUBAGENT_CODE_SENTINEL = 'AGY_SUBAGENT_DIFF_SECRET_CODE_4d1e';

    try {
      buildSyntheticDb(conv, PA, { input: 100, output: 10 });
      buildSyntheticDb(conv, K1, { input: 2000, output: 500, parentId: PA, agentType: 'code-writer' });

      // Child's own transcript: a write_to_file tool call whose CodeContent
      // carries the sentinel. childStats() reads this file ONLY, classifies each
      // line, then discards the text — only the 9 integer counts must survive.
      const childDir = path.join(brain, K1, '.system_generated', 'logs');
      fs.mkdirSync(childDir, { recursive: true });
      const childLine = JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        created_at: '2026-06-13T01:00:00Z',
        tool_calls: [
          {
            name: 'write_to_file',
            args: {
              TargetFile: '/tmp/agy_fix/child_worker.js',
              CodeContent: `const secret = "${AGY_SUBAGENT_CODE_SENTINEL}";\n// a comment line\n\n`,
            },
          },
        ],
      });
      fs.writeFileSync(path.join(childDir, 'transcript_full.jsonl'), childLine);

      // Parent transcript declaring the subagent (labels only — never a prompt).
      const ptx = path.join(brain, 'parent.jsonl');
      fs.writeFileSync(
        ptx,
        JSON.stringify({
          tool_calls: [
            {
              name: 'invoke_subagent',
              args: { Subagents: [{ TypeName: 'code-writer', Role: 'Code Writer' }] },
            },
          ],
        })
      );

      const subs = agy.buildAntigravitySubagents(ptx, PA);
      assert.strictEqual(subs.length, 1, 'one subagent captured');
      const s = subs[0];

      // Positive control: the counts WERE derived from the child's own content.
      assert.strictEqual(s.lines_code_added, 1, 'subagent code-added derived from its own content');
      assert.strictEqual(s.lines_comment_added, 1, 'subagent comment-added derived from its own content');
      assert.strictEqual(s.lines_blank_added, 1, 'subagent blank-added derived from its own content');
      assert.ok(s.added_char_n > 0, 'subagent added_char_n derived from its own content');
      assert.ok(s.added_char_sum > 0, 'subagent added_char_sum derived from its own content');

      const serializedSubs = JSON.stringify(subs);
      assert.ok(
        !serializedSubs.includes(AGY_SUBAGENT_CODE_SENTINEL),
        'LEAK: subagent code sentinel found in buildAntigravitySubagents output'
      );

      // Also prove it survives full envelope build+validation, mirroring how the
      // real collector attaches payload.antigravity.subagents (src/collector.cjs).
      const payload = agy.parseAntigravityTranscript(FIXTURE, {
        sessionId: 'conv-priv-sub',
        repo: '/tmp/agy_fix',
        device_uuid: 'dev-1',
      });
      payload.antigravity.subagents = subs;
      const env = buildAndValidate(payload, {
        _trigger: 'posttooluse',
        _source: 'cli',
        _provider: 'google',
        _tool: 'antigravity',
      });
      assert.ok(
        !JSON.stringify(env).includes(AGY_SUBAGENT_CODE_SENTINEL),
        'LEAK: subagent code sentinel found in produced envelope'
      );
    } finally {
      if (prevC === undefined) delete process.env.AGY_CONVERSATIONS_DIR;
      else process.env.AGY_CONVERSATIONS_DIR = prevC;
      if (prevB === undefined) delete process.env.AGY_BRAIN_DIR;
      else process.env.AGY_BRAIN_DIR = prevB;
      fs.rmSync(conv, { recursive: true, force: true });
      fs.rmSync(brain, { recursive: true, force: true });
    }
  }
);

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
