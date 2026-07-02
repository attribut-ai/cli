'use strict';

// CODEX COLLECTOR TEST — the hook-context path for Codex: buildCodexEnvelopeFromHook
// tags openai/codex, resolves the rollout from transcript_path, stamps device_uuid
// + reason, and validates; and the CLI dry-run path suppresses a subagent child.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { spawnSync } = require('node:child_process');

process.env.ATTRIBUT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-codex-'));

const collector = require('../src/collector.cjs');

const FIX_DIR = path.join(__dirname, 'fixtures', 'codex');
const PARENT = path.join(FIX_DIR, 'rollout.jsonl');
const CHILD = path.join(FIX_DIR, 'subagent.jsonl');
const COLLECTOR = path.resolve(__dirname, '..', 'src', 'collector.cjs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('agentForProvider maps openai → codex', () => {
  assert.strictEqual(collector.agentForProvider('openai'), 'codex');
});

test('buildCodexEnvelopeFromHook produces a valid openai/codex envelope', () => {
  const prev = process.env.CODEX_SESSIONS_DIR;
  process.env.CODEX_SESSIONS_DIR = FIX_DIR;
  try {
    const hook = {
      hook_event_name: 'Stop',
      session_id: '00000000-0000-7000-8000-000000000001',
      transcript_path: PARENT,
      cwd: '/hook/cwd/repo',
      reason: 'end_turn',
    };
    const env = collector.buildCodexEnvelopeFromHook(hook, { trigger: 'stop', source: 'cli' });
    assert.strictEqual(env.provider, 'openai');
    assert.strictEqual(env.tool, 'codex');
    assert.strictEqual(env._trigger, 'stop');
    assert.strictEqual(env.payload.sessionId, '00000000-0000-7000-8000-000000000001');
    assert.strictEqual(env.payload.repo, '/hook/cwd/repo'); // hook cwd overrides
    assert.strictEqual(env.payload.codex.reason, 'end_turn');
    assert.strictEqual(env.payload.codex.remoteSessionId, null);
    assert.strictEqual(env._isCloud, false);
    assert.ok(UUID_RE.test(env.payload.device_uuid));
    // subagent folded in (CODEX_SESSIONS_DIR points at the fixtures dir)
    assert.strictEqual(env.payload.codex.subagents.length, 1);
  } finally {
    if (prev === undefined) delete process.env.CODEX_SESSIONS_DIR;
    else process.env.CODEX_SESSIONS_DIR = prev;
  }
});

// Spawn the collector CLI with a hook JSON on stdin (mirrors e2e.test.cjs).
function run(args, { input, env = {} }) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-'));
  return spawnSync('node', [COLLECTOR, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ATTRIBUT_CONFIG_DIR: configDir, CODEX_SESSIONS_DIR: FIX_DIR, ...env },
  });
}

test('dry-run Stop builds a codex envelope on stdout', () => {
  const hook = JSON.stringify({
    hook_event_name: 'Stop',
    session_id: '00000000-0000-7000-8000-000000000001',
    transcript_path: PARENT,
    cwd: '/repo',
  });
  const res = run(['--provider', 'openai', '--dry-run'], { input: hook });
  assert.strictEqual(res.status, 0);
  const env = JSON.parse(res.stdout);
  assert.strictEqual(env.provider, 'openai');
  assert.strictEqual(env.tool, 'codex');
  assert.strictEqual(env.payload.tokens_in, 4600); // parent 600 + child 4000
});

test('a subagent child hook is SUPPRESSED (no post) on the hot path', () => {
  // Non-dry-run, no token → if it tried to post it would log a token error. A
  // suppressed child returns 0 with the suppression log and never builds/POSTs.
  const hook = JSON.stringify({
    hook_event_name: 'Stop',
    session_id: '00000000-0000-7000-8000-000000000002',
    transcript_path: CHILD,
    cwd: '/repo',
  });
  const res = run(['--provider', 'openai'], { input: hook });
  assert.strictEqual(res.status, 0);
  assert.match(res.stderr, /suppressing codex subagent child/);
  assert.ok(!/could not build codex envelope/.test(res.stderr));
});

test('unresolvable rollout fails quietly (exit 0), never blocks the session', () => {
  const hook = JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 'no-such-session-id-anywhere',
    cwd: '/repo',
  });
  const res = run(['--provider', 'openai'], { input: hook, env: { CODEX_SESSIONS_DIR: os.tmpdir() } });
  assert.strictEqual(res.status, 0);
  assert.match(res.stderr, /could not resolve codex rollout/);
});
