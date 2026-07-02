'use strict';

// DEVICE UUID TEST — generated once, persisted, and stable across runs.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const device = require('../src/device.cjs');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let tmpDir;
let prevConfigDir;

beforeEach(() => {
  prevConfigDir = process.env.ATTRIBUT_CONFIG_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-device-'));
  process.env.ATTRIBUT_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.ATTRIBUT_CONFIG_DIR;
  else process.env.ATTRIBUT_CONFIG_DIR = prevConfigDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('first call generates a canonical UUID and persists it', () => {
  const file = device.deviceUuidPath();
  assert.strictEqual(fs.existsSync(file), false, 'file should not exist yet');

  const uuid = device.getOrCreateDeviceUuid();
  assert.ok(UUID_RE.test(uuid), `not a canonical UUID: ${uuid}`);

  // persisted to ${ATTRIBUT_CONFIG_DIR}/device_uuid
  assert.strictEqual(file, path.join(tmpDir, 'device_uuid'));
  assert.strictEqual(fs.existsSync(file), true, 'file should be created');
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), uuid);
});

test('device_uuid is STABLE across two runs (same machine)', () => {
  const first = device.getOrCreateDeviceUuid();
  const second = device.getOrCreateDeviceUuid();
  assert.strictEqual(first, second, 'device uuid must be stable across runs');
});

test('a corrupt persisted value is regenerated', () => {
  const file = device.deviceUuidPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not-a-uuid\n');

  const uuid = device.getOrCreateDeviceUuid();
  assert.ok(UUID_RE.test(uuid), 'should regenerate a valid UUID');
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), uuid);
});
