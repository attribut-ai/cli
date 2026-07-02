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
