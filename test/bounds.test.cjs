'use strict';

// STRING BOUNDS TEST — free-form strings are capped in the parser AND constrained
// by the schema, so the one content-derived field (title) can never carry an
// unbounded blob, and an over-length value is a loud contract failure.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

const parser = require('../src/parser/claude_code.cjs');
const { buildAndValidate } = require('../src/envelope.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'synthetic.jsonl');

test('parser truncates an over-long title to the 200-char cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-bounds-'));
  const tp = path.join(dir, 't.jsonl');
  const longTitle = 'T'.repeat(500);
  fs.writeFileSync(
    tp,
    JSON.stringify({ type: 'assistant', sessionId: 'sx', message: { model: 'm' } }) +
      '\n' +
      JSON.stringify({ type: 'ai-title', aiTitle: longTitle, sessionId: 'sx' }) +
      '\n',
    'utf8'
  );
  const payload = parser.parseClaudeCodeTranscript(tp);
  assert.equal(payload.title.length, 200);
  assert.ok(longTitle.startsWith(payload.title));
});

test('schema rejects an over-length string (defense-in-depth)', () => {
  const payload = parser.parseClaudeCodeTranscript(FIXTURE);
  payload.title = 'x'.repeat(201); // bypass the parser cap to prove the schema also guards
  assert.throws(
    () => buildAndValidate(payload, { _trigger: 'sessionend', _source: 'cli' }),
    /contract validation/
  );
});

test('parser truncates an over-long repo path to the 2000-char cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-bounds-'));
  const tp = path.join(dir, 't.jsonl');
  const longRepo = '/' + 'r'.repeat(3000); // pathological cwd, well past the cap
  fs.writeFileSync(
    tp,
    JSON.stringify({ type: 'assistant', sessionId: 'sx', cwd: longRepo, message: { model: 'm' } }) +
      '\n',
    'utf8'
  );
  const payload = parser.parseClaudeCodeTranscript(tp);
  assert.equal(payload.repo.length, 2000);
  assert.ok(longRepo.startsWith(payload.repo));
});

test('schema rejects a repo over the 2000-char cap (defense-in-depth)', () => {
  const payload = parser.parseClaudeCodeTranscript(FIXTURE);
  payload.repo = 'x'.repeat(2001); // bypass the parser cap to prove the schema also guards
  assert.throws(
    () => buildAndValidate(payload, { _trigger: 'sessionend', _source: 'cli' }),
    /contract validation/
  );
});
