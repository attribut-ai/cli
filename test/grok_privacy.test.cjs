'use strict';

// GROK PRIVACY GOLDEN TEST — the load-bearing guard for the grok parser.
//
// The synthetic fixture plants sentinel strings in every prohibited location:
// user/assistant text and tool args / lastAssistantMessage in updates.jsonl
// (outside the usage object), tool input/output on events.jsonl, summary recap
// fields, and the forbidden files chat_history.jsonl / system_prompt.txt /
// prompt_context.json. This test asserts NONE of those sentinels appear in the
// produced envelope JSON.
//
// EXCEPTION: `title` is the one authorized content-derived field (generated_title).
// ALLOWED_TITLE_SENTINEL is therefore excluded from leak assertions; a positive
// control proves the title IS captured.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const grok = require('../src/parser/grok.cjs');
const { buildAndValidate } = require('../src/envelope.cjs');

const SESSION = path.join(__dirname, 'fixtures', 'grok', 'session');

const SENTINELS = [
  'SECRET_UPDATES_USER_PROMPT',
  'SECRET_UPDATES_ASSISTANT_BODY',
  'SECRET_UPDATES_TOOL_ARG',
  'SECRET_LAST_ASSISTANT',
  'SECRET_EVENTS_TOOL_ARG',
  'SECRET_EVENTS_TOOL_OUTPUT',
  'SECRET_CHAT_HISTORY_PROMPT',
  'SECRET_CHAT_HISTORY_RESPONSE',
  'SECRET_SYSTEM_PROMPT',
  'SECRET_PROMPT_CONTEXT',
  'SECRET_SUMMARY_RECAP',
  'SECRET_SESSION_RECAP',
];

const FORBIDDEN_BASENAMES = ['chat_history.jsonl', 'system_prompt.txt', 'prompt_context.json'];

test('no prohibited content appears anywhere in the envelope', () => {
  const payload = grok.parseGrokSession(SESSION, { device_uuid: 'test-device-uuid' });
  const envelope = buildAndValidate(payload, {
    _trigger: 'sessionend',
    _source: 'cli',
    _provider: 'xai',
    _tool: 'grok',
  });

  const serialized = JSON.stringify(envelope);
  for (const sentinel of SENTINELS) {
    assert.ok(!serialized.includes(sentinel), `LEAK: sentinel "${sentinel}" found in produced envelope`);
  }
});

test('parser output (pre-envelope) also contains no prohibited sentinels', () => {
  const payload = grok.parseGrokSession(SESSION);
  const serialized = JSON.stringify(payload);
  for (const sentinel of SENTINELS) {
    assert.ok(!serialized.includes(sentinel), `LEAK: sentinel "${sentinel}" found in parser payload`);
  }
});

test('title IS captured — the authorized content-derived exception (positive control)', () => {
  const payload = grok.parseGrokSession(SESSION);
  assert.strictEqual(payload.title, 'ALLOWED_TITLE_SENTINEL Refactor grok widget');
  assert.ok(
    JSON.stringify(payload).includes('ALLOWED_TITLE_SENTINEL'),
    'expected the authorized title to be present in the payload'
  );
});

test('parser never opens chat_history.jsonl / system_prompt.txt / prompt_context.json', () => {
  const opened = [];
  const origRead = fs.readFileSync;
  const origOpen = fs.openSync;
  fs.readFileSync = function spyRead(p, ...args) {
    opened.push(path.basename(String(p)));
    return origRead.call(fs, p, ...args);
  };
  fs.openSync = function spyOpen(p, ...args) {
    opened.push(path.basename(String(p)));
    return origOpen.call(fs, p, ...args);
  };
  try {
    grok.parseGrokSession(SESSION);
  } finally {
    fs.readFileSync = origRead;
    fs.openSync = origOpen;
  }
  for (const name of FORBIDDEN_BASENAMES) {
    assert.ok(!opened.includes(name), `opened forbidden file ${name}: ${opened.join(',')}`);
  }
  assert.ok(opened.includes('summary.json'), 'expected to read summary.json');
  assert.ok(opened.includes('updates.jsonl'), 'expected to scan updates.jsonl for usage');
});
