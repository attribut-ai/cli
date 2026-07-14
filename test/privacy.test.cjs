'use strict';

// PRIVACY GOLDEN TEST — the load-bearing guard for cli2.
//
// The synthetic fixture deliberately plants sentinel strings in EVERY prohibited
// location: the user prompt, assistant response text, file/diff content (added
// AND removed lines), tool input args, the subagent prompt + result body, the
// commit message body, and the `last-prompt` row. This test asserts NONE of
// those sentinels appear anywhere in the produced envelope JSON.
//
// EXCEPTION: `title` is the one explicitly-authorized content-derived field
// (CONTRACT "Content-derived exception"). Its sentinel (ALLOWED_TITLE_SENTINEL)
// is therefore EXCLUDED from the leak assertions, and a separate positive
// control proves the title IS captured. Every OTHER content sentinel must stay
// out of the envelope. If any does, the allowlist has leaked.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

const parser = require('../src/parser/claude_code.cjs');
const { buildAndValidate } = require('../src/envelope.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'synthetic.jsonl');

// Every PROHIBITED sentinel planted in the fixture, by the field it lives in.
// NOTE: ALLOWED_TITLE_SENTINEL is intentionally NOT here — title is the
// authorized content exception, asserted present by a separate positive control.
const SENTINELS = [
  'SECRET_PROMPT_TEXT', // user prompt text
  'ASSISTANT_RESPONSE_BODY', // assistant message text
  'FINAL_ASSISTANT_SECRET', // assistant message text (last turn)
  'TOOL_INPUT_SECRET_ARG_OLD', // tool_use.input args
  'TOOL_INPUT_SECRET_ARG_NEW', // tool_use.input args
  'FILE_DIFF_SECRET_ADDED_CODE', // added line content
  'FILE_DIFF_SECRET_ADDED_COMMENT', // added line content
  'FILE_DIFF_SECRET_REMOVED', // removed line content
  'SUBAGENT_PROMPT_SECRET', // subagent prompt (tool input)
  'SUBAGENT_RESULT_BODY_SECRET', // subagent result body
  'COMMIT_BODY_SECRET', // commit message body
  'LAST_PROMPT_SECRET', // last-prompt row (.lastPrompt) — sibling of the title row
];

test('no prohibited content appears anywhere in the envelope', () => {
  const payload = parser.parseClaudeCodeTranscript(FIXTURE, {
    device_uuid: 'test-device-uuid',
  });
  const envelope = buildAndValidate(payload, {
    _trigger: 'sessionend',
    _source: 'cli',
    _isCloud: false,
  });

  const serialized = JSON.stringify(envelope);
  for (const sentinel of SENTINELS) {
    assert.ok(
      !serialized.includes(sentinel),
      `LEAK: sentinel "${sentinel}" found in produced envelope`
    );
  }
});

test('parser output (pre-envelope) also contains no prohibited sentinels', () => {
  const payload = parser.parseClaudeCodeTranscript(FIXTURE);
  const serialized = JSON.stringify(payload);
  for (const sentinel of SENTINELS) {
    assert.ok(
      !serialized.includes(sentinel),
      `LEAK: sentinel "${sentinel}" found in parser payload`
    );
  }
});

test('the commit SHA from stdout IS extracted (positive control)', () => {
  // Proves the fixture actually exercises the SHA path — so a clean privacy
  // result is meaningful, not just an empty parse.
  const payload = parser.parseClaudeCodeTranscript(FIXTURE);
  assert.deepStrictEqual(payload.commitSHA, ['a1b2c3d']);
});

test('title IS captured — the authorized content-derived exception (positive control)', () => {
  // The fixture's ai-title carries ALLOWED_TITLE_SENTINEL; it MUST appear in the
  // payload. This proves the exception is wired, not that the title path is
  // silently empty. (The sibling last-prompt sentinel is asserted absent above.)
  const payload = parser.parseClaudeCodeTranscript(FIXTURE);
  assert.strictEqual(payload.title, 'ALLOWED_TITLE_SENTINEL Refactor the widget');
  assert.ok(
    JSON.stringify(payload).includes('ALLOWED_TITLE_SENTINEL'),
    'expected the authorized title to be present in the payload'
  );
});

// --- Subagent (file-plane) line-count privacy -------------------------------
//
// The per-subagent 9-key structural breakdown (added Jul-2026) is derived by
// re-parsing the CHILD worker's OWN on-disk transcript (buildClaudeSubagents in
// src/parser/claude_code.cjs). This is a distinct code path from the inline-Task
// subagent plane the fixture above exercises, so it needs its own sentinel-leak
// guard: plant a unique code string in a CHILD's Edit toolUseResult, then prove
// (a) the subagent's lines_* counts are non-zero — the count WAS derived from
// that content — and (b) the sentinel text itself never appears anywhere in the
// parser payload or the serialized envelope.
test('subagent line counts are derived from the child\'s own code but the code text never leaks', () => {
  const SID = 'ffffffff-1111-2222-3333-444444444444';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-privacy-subagent-'));
  const proj = path.join(root, 'projects', '-Users-test-repo');
  const subDir = path.join(proj, SID, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });

  const SUBAGENT_CODE_SENTINEL = 'SUBAGENT_FILE_DIFF_SECRET_CODE_9f3a';

  const parentPath = path.join(proj, `${SID}.jsonl`);
  fs.writeFileSync(
    parentPath,
    JSON.stringify({
      type: 'assistant',
      sessionId: SID,
      cwd: '/Users/test/repo',
      timestamp: '2026-06-15T10:00:00.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'tool_use', name: 'Agent', input: {} }],
      },
    }) + '\n'
  );

  // The CHILD's own transcript: an Edit result whose structuredPatch carries the
  // sentinel on an ADDED line and a plain line on a REMOVED line — read ONLY to
  // classify + measure, then discarded (mirrors the parent-level privacy test).
  const workerRows = [
    JSON.stringify({
      type: 'assistant',
      sessionId: SID,
      cwd: '/Users/test/repo',
      timestamp: '2026-06-15T10:05:00.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 500, output_tokens: 200 },
        content: [{ type: 'tool_use', name: 'Edit', input: {} }],
      },
    }),
    JSON.stringify({
      type: 'user',
      sessionId: SID,
      timestamp: '2026-06-15T10:06:00.000Z',
      toolUseResult: {
        filePath: '/Users/test/repo/worker.js',
        type: 'edit',
        structuredPatch: [
          {
            lines: [`+const secret = "${SUBAGENT_CODE_SENTINEL}";`, '-const old = 1;'],
          },
        ],
      },
    }),
  ];
  fs.writeFileSync(
    path.join(subDir, 'agent-worker-deadbeef0001.jsonl'),
    workerRows.join('\n') + '\n'
  );

  try {
    const payload = parser.parseClaudeCodeTranscript(parentPath, { sessionId: SID });
    const subs = payload.claude_code.subagents;
    assert.strictEqual(subs.length, 1, 'one file-plane subagent captured');
    const s = subs[0];

    // Positive control: the counts WERE derived from the child's own content.
    assert.strictEqual(s.lines_code_added, 1, 'subagent code-added derived from its own content');
    assert.strictEqual(s.lines_code_removed, 1, 'subagent code-removed derived from its own content');
    assert.ok(s.added_char_n > 0, 'subagent added_char_n derived from its own content');
    assert.ok(s.added_char_sum > 0, 'subagent added_char_sum derived from its own content');

    const envelope = buildAndValidate(payload, {
      _trigger: 'sessionend',
      _source: 'cli',
      _isCloud: false,
    });

    const serializedPayload = JSON.stringify(payload);
    const serializedEnvelope = JSON.stringify(envelope);
    assert.ok(
      !serializedPayload.includes(SUBAGENT_CODE_SENTINEL),
      'LEAK: subagent code sentinel found in parser payload'
    );
    assert.ok(
      !serializedEnvelope.includes(SUBAGENT_CODE_SENTINEL),
      'LEAK: subagent code sentinel found in produced envelope'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
