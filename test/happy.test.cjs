'use strict';

// HAPPY-PATH TEST — the envelope validates against the frozen schema and every
// extracted field carries the correct value computed from the synthetic fixture.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const parser = require('../src/parser/claude_code.cjs');
const { buildEnvelope, validateEnvelope, buildAndValidate } = require('../src/envelope.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'synthetic.jsonl');

test('envelope validates against the frozen contract schema', () => {
  const payload = parser.parseClaudeCodeTranscript(FIXTURE);
  const envelope = buildEnvelope(payload, {
    _trigger: 'sessionend',
    _source: 'cli',
    _isCloud: false,
  });
  const { valid, errors } = validateEnvelope(envelope);
  assert.ok(valid, `envelope invalid: ${JSON.stringify(errors)}`);
});

test('buildAndValidate returns the tagged envelope', () => {
  const payload = parser.parseClaudeCodeTranscript(FIXTURE);
  const env = buildAndValidate(payload, { _trigger: 'stop', _source: 'cli', _isCloud: false });
  assert.strictEqual(env.provider, 'anthropic');
  assert.strictEqual(env.tool, 'claude_code');
  assert.strictEqual(env.schema_version, 1);
  assert.strictEqual(env._trigger, 'stop');
});

test('agnostic fields are extracted correctly', () => {
  const p = parser.parseClaudeCodeTranscript(FIXTURE);

  assert.strictEqual(p.sessionId, '11111111-2222-3333-4444-555555555555');
  assert.strictEqual(p.model, 'claude-opus-4-8');
  assert.strictEqual(p.repo, '/Users/test/repo');
  assert.strictEqual(p.branch, 'feature/widget');
  assert.deepStrictEqual(p.commitSHA, ['a1b2c3d']);

  // tokens: 4 assistant usage rows + 1 folded subagent.
  // in: 1200+400+300+150 + 4000 = 6050 ; out: 350+120+90+40 + 600 = 1200
  assert.strictEqual(p.tokens_in, 6050);
  assert.strictEqual(p.tokens_out, 1200);

  assert.strictEqual(p.started_at, '2026-06-15T10:00:00.000Z');
  assert.strictEqual(p.ended_at, '2026-06-15T10:01:00.000Z');
  assert.strictEqual(p.duration_ms, 60000);

  assert.strictEqual(p.num_turns, 4); // 4 assistant rows in the fixture
});

test('title: ai-title is captured when no custom-title exists', () => {
  const p = parser.parseClaudeCodeTranscript(FIXTURE);
  assert.strictEqual(p.title, 'ALLOWED_TITLE_SENTINEL Refactor the widget');
});

test('title: a user custom-title overrides the ai-title', () => {
  const p = parser.parseClaudeCodeTranscript(
    path.join(__dirname, 'fixtures', 'with_custom_title.jsonl')
  );
  assert.strictEqual(p.title, 'User chosen title');
});

test('title: null when no title row exists yet', () => {
  const p = parser.parseClaudeCodeTranscript(
    path.join(__dirname, 'fixtures', 'no_title.jsonl')
  );
  assert.strictEqual(p.title, null);
});

test('device_uuid: passed through from extra, null when absent', () => {
  const withDevice = parser.parseClaudeCodeTranscript(FIXTURE, {
    device_uuid: 'dev-1234',
  });
  assert.strictEqual(withDevice.device_uuid, 'dev-1234');

  const without = parser.parseClaudeCodeTranscript(FIXTURE);
  assert.strictEqual(without.device_uuid, null);
});

test('tool_uses carries names + counts only, num_tool_calls is their sum', () => {
  const p = parser.parseClaudeCodeTranscript(FIXTURE);
  const byName = Object.fromEntries(p.tool_uses.map((t) => [t.name, t.count]));
  assert.deepStrictEqual(byName, { Edit: 1, Task: 1, Bash: 1 });
  assert.strictEqual(p.num_tool_calls, 3);
  // No tool_use entry may carry anything beyond name + count.
  for (const t of p.tool_uses) {
    assert.deepStrictEqual(Object.keys(t).sort(), ['count', 'name']);
  }
});

test('structural line metrics classify the patch correctly', () => {
  const p = parser.parseClaudeCodeTranscript(FIXTURE);
  // app.js (.js): added = 1 code, 1 comment, 1 blank ; removed = 1 code.
  assert.strictEqual(p.lines_code_added, 1);
  assert.strictEqual(p.lines_comment_added, 1);
  assert.strictEqual(p.lines_blank_added, 1);
  assert.strictEqual(p.lines_code_removed, 1);
  assert.strictEqual(p.lines_comment_removed, 0);
  assert.strictEqual(p.lines_blank_removed, 0);
  // char stats over the 3 added lines (only n is asserted; sums are content-len).
  assert.strictEqual(p.added_char_n, 3);
  assert.ok(p.added_char_sum > 0);
  assert.ok(p.added_char_sumsq > 0);
});

test('claude_code sub-struct: cache, tier, stop_reason, version', () => {
  const p = parser.parseClaudeCodeTranscript(FIXTURE);
  assert.strictEqual(p.claude_code.cache_read_tokens, 1300); // 800+200 + 300
  assert.strictEqual(p.claude_code.cache_creation_tokens, 150); // 100+0 + 50
  assert.strictEqual(p.claude_code.service_tier, 'standard');
  assert.strictEqual(p.claude_code.stop_reason, 'end_turn'); // last assistant row
  assert.strictEqual(p.claude_code.version, '1.2.3');
});

test('subagents are exposed per-invocation with safe fields only (incl. resolvedModel)', () => {
  const p = parser.parseClaudeCodeTranscript(FIXTURE);
  assert.strictEqual(p.claude_code.subagents.length, 1);
  const s = p.claude_code.subagents[0];
  assert.deepStrictEqual(s, {
    agent_type: 'general-purpose',
    model: 'claude-haiku-4-5-20251001', // captured from toolUseResult.resolvedModel
    status: 'completed',
    tool_use_count: 7,
    input_tokens: 4000,
    output_tokens: 600,
    cache_read_tokens: 300,
    cache_creation_tokens: 50,
    // approx window: Task tool_use row → its result row (synthetic fixture)
    started_at: '2026-06-15T10:00:10.000Z',
    ended_at: '2026-06-15T10:00:30.000Z',
    duration_ms: 20000,
  });
});

test('extra.sessionId / extra.repo override transcript values', () => {
  const p = parser.parseClaudeCodeTranscript(FIXTURE, {
    sessionId: 'override-sid',
    repo: '/override/repo',
  });
  assert.strictEqual(p.sessionId, 'override-sid');
  assert.strictEqual(p.repo, '/override/repo');
});

test('empty transcript throws (fail loud at the parser layer)', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const tmp = path.join(os.tmpdir(), `attribut-empty-${Date.now()}.jsonl`);
  fs.writeFileSync(tmp, '\n\n');
  assert.throws(() => parser.parseClaudeCodeTranscript(tmp), /empty/i);
  fs.unlinkSync(tmp);
});
