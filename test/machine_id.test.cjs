'use strict';

// MACHINE ID TEST — cached, hardware-hashed where readable, UUID fallback
// otherwise. Never sends the raw platform id (only its sha256).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const machineId = require('../src/machine_id.cjs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

let tmpDir;
let prevConfigDir;

beforeEach(() => {
  prevConfigDir = process.env.ATTRIBUT_CONFIG_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-machineid-'));
  process.env.ATTRIBUT_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.ATTRIBUT_CONFIG_DIR;
  else process.env.ATTRIBUT_CONFIG_DIR = prevConfigDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('readRawHardwareId returns null for an unrecognized platform (never throws)', () => {
  assert.equal(machineId.readRawHardwareId('sunos'), null);
  assert.equal(machineId.readRawHardwareId('freebsd'), null);
});

test('an unrecognized platform falls back to a persisted random UUID', () => {
  const file = machineId.machineIdPath();
  assert.equal(fs.existsSync(file), false, 'file should not exist yet');

  const id = machineId.getOrCreateMachineId('sunos');
  assert.ok(UUID_RE.test(id), `expected a canonical UUID fallback, got: ${id}`);
  assert.equal(fs.existsSync(file), true, 'fallback id should be persisted');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), id);
});

test('machine id is STABLE across calls (cached, not re-derived)', () => {
  const first = machineId.getOrCreateMachineId('sunos');
  const second = machineId.getOrCreateMachineId('sunos');
  assert.equal(first, second);
});

test('a cached value wins even if the platform argument changes on a later call', () => {
  const first = machineId.getOrCreateMachineId('sunos');
  // Simulates "hardware id became unreadable/platform changed after first run"
  // — the cache must still win so the id stays stable.
  const second = machineId.getOrCreateMachineId('linux');
  assert.equal(first, second);
});

test('sha256Hex never leaks the raw input — fixed-length hex digest', () => {
  const digest = machineId.sha256Hex('super-secret-hardware-uuid');
  assert.ok(SHA256_HEX_RE.test(digest), `not a sha256 hex digest: ${digest}`);
  assert.ok(!digest.includes('super-secret-hardware-uuid'));
});

test('a corrupt/empty cached file is treated as absent (regenerates)', () => {
  const file = machineId.machineIdPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '   \n'); // whitespace-only → trim()s to empty

  const id = machineId.getOrCreateMachineId('sunos');
  assert.ok(UUID_RE.test(id));
});

test('the persisted machine_id file is written 0600', () => {
  machineId.getOrCreateMachineId('sunos');
  const mode = fs.statSync(machineId.machineIdPath()).mode & 0o777;
  assert.equal(mode, 0o600);
});

// Only meaningful on a host that actually has the platform's hardware id
// reader available — exercises the real hashing path end-to-end without
// hardcoding a platform-specific expectation for every CI runner.
test('when a real hardware id IS readable on this host, it is sha256-hashed (not sent raw)', () => {
  const raw = machineId.readRawHardwareId(process.platform);
  if (!raw) {
    return; // unreadable on this host/sandbox — covered by the fallback tests above
  }
  const id = machineId.getOrCreateMachineId(process.platform);
  assert.ok(SHA256_HEX_RE.test(id), `expected a sha256 digest, got: ${id}`);
  assert.equal(id, machineId.sha256Hex(raw));
});
