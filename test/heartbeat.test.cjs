'use strict';

// HEARTBEAT TEST — payload shape (privacy allowlist) + runHeartbeat exit codes.
// No real network calls: --dry-run never POSTs, and the "no token" path
// returns before postJson is ever reached.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const heartbeat = require('../src/heartbeat.cjs');
const tokenStore = require('../src/token.cjs');
const { version: PKG_VERSION } = require('../package.json');

// The exact allowlist — nothing outside this list may appear in the payload.
const ALLOWED_KEYS = [
  'kind',
  'schema_version',
  'sent_at',
  'device_uuid',
  'machine_id',
  'cli_version',
  'platform',
  'os_release',
  'source',
  'last_hook_invocation_at',
].sort();

let tmpDir;
let prevConfigDir;

beforeEach(() => {
  prevConfigDir = process.env.ATTRIBUT_CONFIG_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-heartbeat-'));
  process.env.ATTRIBUT_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.ATTRIBUT_CONFIG_DIR;
  else process.env.ATTRIBUT_CONFIG_DIR = prevConfigDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('buildHeartbeatPayload contains EXACTLY the privacy-allowlisted fields', () => {
  const payload = heartbeat.buildHeartbeatPayload({
    now: new Date('2026-07-03T12:00:00.000Z'),
    deviceUuid: 'device-uuid-1',
    machineId: 'machine-id-1',
    lastHookInvocationAt: '2026-07-03T11:00:00.000Z',
  });
  assert.deepEqual(Object.keys(payload).sort(), ALLOWED_KEYS);
});

test('buildHeartbeatPayload fields carry exactly the injected/expected values', () => {
  const now = new Date('2026-07-03T12:34:56.000Z');
  const payload = heartbeat.buildHeartbeatPayload({
    now,
    deviceUuid: 'device-uuid-1',
    machineId: 'machine-id-1',
    lastHookInvocationAt: '2026-07-03T11:00:00.000Z',
  });
  assert.equal(payload.kind, 'heartbeat');
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.sent_at, now.toISOString());
  assert.equal(payload.device_uuid, 'device-uuid-1');
  assert.equal(payload.machine_id, 'machine-id-1');
  assert.equal(payload.cli_version, PKG_VERSION);
  assert.equal(payload.platform, process.platform);
  assert.equal(payload.os_release, os.release());
  assert.equal(payload.source, 'timer');
  assert.equal(payload.last_hook_invocation_at, '2026-07-03T11:00:00.000Z');
});

test('buildHeartbeatPayload passes through a null last_hook_invocation_at as null (not omitted)', () => {
  const payload = heartbeat.buildHeartbeatPayload({
    deviceUuid: 'd',
    machineId: 'm',
    lastHookInvocationAt: null,
  });
  assert.equal(payload.last_hook_invocation_at, null);
  assert.ok('last_hook_invocation_at' in payload);
});

test('buildHeartbeatPayload never leaks a path, prompt, or content string', () => {
  const payload = heartbeat.buildHeartbeatPayload({
    deviceUuid: 'd',
    machineId: 'm',
    lastHookInvocationAt: null,
  });
  const json = JSON.stringify(payload);
  assert.ok(!json.includes(os.homedir()), 'must not include a filesystem path');
  assert.ok(!/\bprompt\b|\bresponse\b|\bdiff\b/i.test(json));
});

test('runHeartbeat exits 1 and never POSTs when no token is configured', async () => {
  const code = await heartbeat.runHeartbeat([]);
  assert.equal(code, 1);
});

test('runHeartbeat --dry-run prints the payload and exits 0 even with no token', async () => {
  const orig = process.stdout.write;
  let printed = '';
  process.stdout.write = (chunk) => {
    printed += chunk;
    return true;
  };
  let code;
  try {
    code = await heartbeat.runHeartbeat(['--dry-run']);
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(code, 0);
  const payload = JSON.parse(printed);
  assert.deepEqual(Object.keys(payload).sort(), ALLOWED_KEYS);
});

test('runHeartbeat --dry-run exits 0 with a token configured too (no network call)', async () => {
  tokenStore.writeToken('tok-123');
  const orig = process.stdout.write;
  process.stdout.write = () => true;
  let code;
  try {
    code = await heartbeat.runHeartbeat(['--dry-run']);
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(code, 0);
});

test('runHeartbeat --help exits 0 without touching the token store', async () => {
  const orig = process.stdout.write;
  process.stdout.write = () => true;
  let code;
  try {
    code = await heartbeat.runHeartbeat(['--help']);
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(code, 0);
});

test('endpoint() respects INGEST_BASE and appends /v1/heartbeat', () => {
  const prev = process.env.INGEST_BASE;
  process.env.INGEST_BASE = 'https://ingest.example.com/';
  try {
    assert.equal(heartbeat.endpoint(), 'https://ingest.example.com/v1/heartbeat');
  } finally {
    if (prev === undefined) delete process.env.INGEST_BASE;
    else process.env.INGEST_BASE = prev;
  }
});

test('postJson refuses a non-https endpoint without ATTRIBUT_ALLOW_INSECURE', async () => {
  await assert.rejects(
    () => heartbeat.postJson('http://example.com/v1/heartbeat', {}, { bearer: 'x' }),
    /refusing to POST to non-https endpoint/
  );
});
