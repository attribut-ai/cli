'use strict';

// Field-coverage for the Grok session parser: allowlisted summary / signals /
// events / surgical usage scan against a synthetic sentinel session dir.
// Occupancy from signals.json is NEVER billed as tokens_in.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const grok = require('../src/parser/grok.cjs');
const { buildAndValidate, validateEnvelope } = require('../src/envelope.cjs');

const FIX_DIR = path.join(__dirname, 'fixtures', 'grok');
const SESSION = path.join(FIX_DIR, 'session');
const USAGE_ONLY = path.join(FIX_DIR, 'updates-usage-only.jsonl');
const SID = '01990000-0000-7000-8000-000000000001';

function copySession(mutator) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-grok-'));
  fs.cpSync(SESSION, dir, { recursive: true });
  if (mutator) mutator(dir);
  return dir;
}

test('happy path: sessionId, model grok-4.6, disjoint tokens, title, tool_uses', () => {
  const p = grok.parseGrokSession(SESSION, { device_uuid: 'dev-grok' });
  assert.strictEqual(p.sessionId, SID);
  assert.strictEqual(p.device_uuid, 'dev-grok');
  assert.strictEqual(p.model, 'grok-4.6');
  assert.strictEqual(p.title, 'ALLOWED_TITLE_SENTINEL Refactor grok widget');
  assert.strictEqual(p.repo, '/repo/grok-demo');
  assert.strictEqual(p.started_at, '2026-08-29T10:00:00.000Z');
  assert.strictEqual(p.ended_at, '2026-08-29T10:01:30.000Z');
  assert.strictEqual(p.duration_ms, 90000);

  // LAST usage wins: input 5000 − cachedRead 1000 = 4000 fresh in.
  assert.strictEqual(p.tokens_in, 4000);
  assert.strictEqual(p.tokens_out, 800);
  assert.strictEqual(p.grok.cache_read_tokens, 1000);
  assert.strictEqual(p.grok.cache_creation_tokens, 250);
  assert.strictEqual(p.grok.reasoning_output_tokens, 120);
  assert.strictEqual(p.grok.effort, 'high');
  assert.strictEqual(p.grok.cost_usd_ticks, 42);

  // Occupancy is not the billed input.
  assert.strictEqual(p.grok.context_tokens, 32000);
  assert.strictEqual(p.grok.context_token_limit, 256000);
  assert.notStrictEqual(p.tokens_in, p.grok.context_tokens);

  assert.deepStrictEqual(
    p.tool_uses.map((t) => [t.name, t.count]),
    [
      ['bash', 1],
      ['read_file', 1],
    ]
  );
  assert.strictEqual(p.num_tool_calls, 2);
  assert.strictEqual(p.num_turns, 2);
  assert.deepStrictEqual(p.commitSHA, []);
  assert.strictEqual(p.lines_code_added, null);
});

test('payload builds + validates as an xai/grok envelope', () => {
  const p = grok.parseGrokSession(SESSION, { device_uuid: 'dev-grok' });
  const env = buildAndValidate(p, {
    _trigger: 'stop',
    _source: 'cli',
    _provider: 'xai',
    _tool: 'grok',
  });
  assert.strictEqual(env.provider, 'xai');
  assert.strictEqual(env.tool, 'grok');
  const { valid, errors } = validateEnvelope(env);
  assert.ok(valid, `envelope invalid: ${JSON.stringify(errors)}`);
});

test('missing signals.json still parses; occupancy NULL; tokens from usage', () => {
  const dir = copySession((d) => fs.unlinkSync(path.join(d, 'signals.json')));
  try {
    const p = grok.parseGrokSession(dir);
    assert.strictEqual(p.sessionId, SID);
    assert.strictEqual(p.tokens_in, 4000);
    assert.strictEqual(p.tokens_out, 800);
    assert.strictEqual(p.grok.cache_read_tokens, 1000);
    assert.strictEqual(p.grok.context_tokens, null);
    assert.strictEqual(p.grok.context_token_limit, null);
    assert.deepStrictEqual(
      p.tool_uses.map((t) => [t.name, t.count]),
      [
        ['bash', 1],
        ['read_file', 1],
      ]
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing updates.jsonl → token fields NULL, no throw if summary exists', () => {
  const dir = copySession((d) => fs.unlinkSync(path.join(d, 'updates.jsonl')));
  try {
    const p = grok.parseGrokSession(dir);
    assert.strictEqual(p.sessionId, SID);
    assert.strictEqual(p.model, 'grok-4.6');
    assert.strictEqual(p.tokens_in, null);
    assert.strictEqual(p.tokens_out, null);
    assert.strictEqual(p.grok.cache_read_tokens, null);
    assert.strictEqual(p.grok.cache_creation_tokens, null);
    assert.strictEqual(p.grok.reasoning_output_tokens, null);
    assert.strictEqual(p.grok.cost_usd_ticks, null);
    assert.strictEqual(p.grok.context_tokens, 32000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unreadable session dir throws', () => {
  assert.throws(
    () => grok.parseGrokSession(path.join(os.tmpdir(), 'attribut-grok-missing-' + Date.now())),
    /not found|not a directory|unreadable/i
  );
});

test('redacted usage-only updates.jsonl: last usage wins, disjoint tokens', () => {
  const dir = copySession((d) => {
    fs.copyFileSync(USAGE_ONLY, path.join(d, 'updates.jsonl'));
  });
  try {
    const p = grok.parseGrokSession(dir);
    // last line: input 250 − cachedRead 30 = 220
    assert.strictEqual(p.tokens_in, 220);
    assert.strictEqual(p.tokens_out, 40);
    assert.strictEqual(p.grok.cache_read_tokens, 30);
    assert.strictEqual(p.grok.cache_creation_tokens, 8);
    assert.strictEqual(p.grok.reasoning_output_tokens, 6);
    assert.strictEqual(p.grok.cost_usd_ticks, 11);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('disjointTokens splits Grok nested usage into the contract buckets', () => {
  assert.deepStrictEqual(
    grok.disjointTokens({
      inputTokens: 100,
      cachedReadTokens: 30,
      cacheCreationTokens: 5,
      outputTokens: 40,
      reasoningTokens: 8,
      costUsdTicks: 3,
    }),
    {
      tokens_in: 70,
      cache_read_tokens: 30,
      cache_creation_tokens: 5,
      tokens_out: 40,
      reasoning_output_tokens: 8,
      cost_usd_ticks: 3,
    }
  );
  assert.strictEqual(grok.disjointTokens({ inputTokens: 10, cachedReadTokens: 40 }).tokens_in, 0);
  assert.strictEqual(grok.disjointTokens(null).tokens_in, null);
});

test('resolveSessionDir finds sessionsRoot/<urlencoded-cwd>/<sessionId>', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-grok-sessions-'));
  const cwd = '/repo/grok-demo';
  const encoded = encodeURIComponent(cwd);
  const dest = path.join(root, encoded, SID);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(SESSION, 'summary.json'), path.join(dest, 'summary.json'));
  const prev = process.env.GROK_SESSIONS_DIR;
  process.env.GROK_SESSIONS_DIR = root;
  try {
    const resolved = grok.resolveSessionDir({ sessionId: SID, cwd });
    assert.strictEqual(resolved, dest);
  } finally {
    if (prev === undefined) delete process.env.GROK_SESSIONS_DIR;
    else process.env.GROK_SESSIONS_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
