'use strict';

// END-TO-END SAFETY TEST — the collector's core invariant: on the hot path it
// must NEVER exit non-zero (it would break the user's session), but it must log
// what went wrong. Explicit CLI misuse, by contrast, fails loud (exit 2).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

const COLLECTOR = path.resolve(__dirname, '..', 'src', 'collector.cjs');
const FIXTURE = path.join(__dirname, 'fixtures', 'synthetic.jsonl');

function run(args, { input = '', env = {}, token = null } = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-e2e-'));
  if (token) fs.writeFileSync(path.join(configDir, 'token'), token + '\n', { mode: 0o600 });
  return spawnSync('node', [COLLECTOR, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ATTRIBUT_CONFIG_DIR: configDir, ...env },
  });
}

test('garbage stdin on the hot path → exit 0, logged (never blocks the session)', () => {
  const r = run(['stop'], { input: 'not json at all' });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /\[attribut\].*hook JSON/);
});

test('empty stdin → exit 0', () => {
  const r = run(['stop'], { input: '' });
  assert.equal(r.status, 0);
});

test('a valid hook whose POST fails → still exit 0, logged', () => {
  const r = run(['stop'], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: FIXTURE, session_id: 's' }),
    token: 'tok',
    env: {
      ATTRIBUT_COLLECTOR_URL: 'http://127.0.0.1:1/v1/hook', // refused
      ATTRIBUT_ALLOW_INSECURE: '1',
    },
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /POST failed/);
});

test('--parse with no file argument → exit 2 (explicit misuse fails loud)', () => {
  const r = run(['--parse']);
  assert.equal(r.status, 2);
});

test('unknown subcommand → exit 2 with help', () => {
  const r = run(['frobnicate'], { input: '' });
  assert.equal(r.status, 2);
});
