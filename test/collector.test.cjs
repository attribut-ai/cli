'use strict';

// COLLECTOR TEST — the hook-context path: trigger mapping, cloud stamping, and
// envelope assembly from a hook object (no network; uses buildEnvelopeFromHook).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

// Isolate device_uuid persistence to a temp dir so the suite never touches the
// real ~/.attribut. buildEnvelopeFromHook generates/persists a device id.
process.env.ATTRIBUT_CONFIG_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'attribut-collector-')
);

const collector = require('../src/collector.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'synthetic.jsonl');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('triggerFor maps hook_event_name to the contract enum', () => {
  assert.strictEqual(collector.triggerFor('SessionEnd'), 'sessionend');
  assert.strictEqual(collector.triggerFor('Stop'), 'stop');
  assert.strictEqual(collector.triggerFor('PostToolUse'), 'posttooluse');
  assert.strictEqual(collector.triggerFor('Unknown'), null);
  assert.strictEqual(collector.triggerFor('Stop', 'sessionend'), 'sessionend'); // explicit wins
});

test('buildEnvelopeFromHook produces a valid, tagged envelope', () => {
  const hook = {
    hook_event_name: 'SessionEnd',
    session_id: 'hook-session-id',
    transcript_path: FIXTURE,
    cwd: '/hook/cwd/repo',
    reason: 'clear',
  };
  const env = collector.buildEnvelopeFromHook(hook, { trigger: 'sessionend', source: 'cli' });

  assert.strictEqual(env.provider, 'anthropic');
  assert.strictEqual(env.tool, 'claude_code');
  assert.strictEqual(env._trigger, 'sessionend');
  assert.strictEqual(env._source, 'cli');
  // hook overrides applied
  assert.strictEqual(env.payload.sessionId, 'hook-session-id');
  assert.strictEqual(env.payload.repo, '/hook/cwd/repo');
  // claude_code transport context stamped
  assert.strictEqual(env.payload.claude_code.reason, 'clear');
  assert.strictEqual(env.payload.claude_code.remoteSessionId, null); // not cloud in test env
  assert.strictEqual(env._isCloud, false);
  // device_uuid stamped by the collector (generated + persisted)
  assert.ok(UUID_RE.test(env.payload.device_uuid), 'device_uuid should be a UUID');
});

test('the hook path stamps a STABLE device_uuid across two builds', () => {
  const hook = {
    hook_event_name: 'SessionEnd',
    session_id: 's',
    transcript_path: FIXTURE,
    cwd: '/repo',
  };
  const a = collector.buildEnvelopeFromHook(hook, { trigger: 'sessionend' });
  const b = collector.buildEnvelopeFromHook(hook, { trigger: 'sessionend' });
  assert.strictEqual(a.payload.device_uuid, b.payload.device_uuid);
});

test('cloudContext reads CLAUDE_CODE_REMOTE_SESSION_ID', () => {
  const prev = process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  process.env.CLAUDE_CODE_REMOTE_SESSION_ID = 'session_01abc';
  try {
    const ctx = collector.cloudContext();
    assert.strictEqual(ctx.remoteSessionId, 'session_01abc');
    assert.strictEqual(ctx.isCloud, true);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
    else process.env.CLAUDE_CODE_REMOTE_SESSION_ID = prev;
  }
});

test('endpoint() derives from INGEST_BASE, full-URL override wins', () => {
  const prevBase = process.env.INGEST_BASE;
  const prevFull = process.env.ATTRIBUT_COLLECTOR_URL;
  try {
    delete process.env.ATTRIBUT_COLLECTOR_URL;
    process.env.INGEST_BASE = 'https://ingest.example.com/';
    assert.strictEqual(collector.endpoint(), 'https://ingest.example.com/v1/hook');
    process.env.ATTRIBUT_COLLECTOR_URL = 'http://localhost:9999/custom';
    assert.strictEqual(collector.endpoint(), 'http://localhost:9999/custom');
  } finally {
    if (prevBase === undefined) delete process.env.INGEST_BASE;
    else process.env.INGEST_BASE = prevBase;
    if (prevFull === undefined) delete process.env.ATTRIBUT_COLLECTOR_URL;
    else process.env.ATTRIBUT_COLLECTOR_URL = prevFull;
  }
});

test('hook missing transcript_path throws (caller swallows, but builder is loud)', () => {
  assert.throws(
    () => collector.buildEnvelopeFromHook({ hook_event_name: 'Stop' }, { trigger: 'stop' }),
    /transcript_path/
  );
});
