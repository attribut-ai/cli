'use strict';

// LOCAL STATE TEST — last_hook_invocation_at, touched on every hook fire.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const state = require('../src/state.cjs');

let tmpDir;
let prevConfigDir;

beforeEach(() => {
  prevConfigDir = process.env.ATTRIBUT_CONFIG_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-state-'));
  process.env.ATTRIBUT_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.ATTRIBUT_CONFIG_DIR;
  else process.env.ATTRIBUT_CONFIG_DIR = prevConfigDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('readLastHookInvocationAt is null before any touch', () => {
  assert.equal(state.readLastHookInvocationAt(), null);
});

test('touchHookInvocation persists an ISO timestamp, readable back', () => {
  const now = new Date('2026-07-03T12:00:00.000Z');
  state.touchHookInvocation(now);
  assert.equal(state.readLastHookInvocationAt(), '2026-07-03T12:00:00.000Z');
});

test('a later touch overwrites the earlier one', () => {
  state.touchHookInvocation(new Date('2026-07-03T12:00:00.000Z'));
  state.touchHookInvocation(new Date('2026-07-03T13:00:00.000Z'));
  assert.equal(state.readLastHookInvocationAt(), '2026-07-03T13:00:00.000Z');
});

test('state.json is written 0600', () => {
  state.touchHookInvocation(new Date());
  const mode = fs.statSync(state.statePath()).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('a corrupt state.json is treated as empty, never throws', () => {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(state.statePath(), '{ not json', 'utf8');
  assert.equal(state.readLastHookInvocationAt(), null);
  // and touching after corruption recovers cleanly
  assert.doesNotThrow(() => state.touchHookInvocation(new Date('2026-07-03T00:00:00.000Z')));
  assert.equal(state.readLastHookInvocationAt(), '2026-07-03T00:00:00.000Z');
});

test('touchHookInvocation never throws even if the config dir is unwritable', () => {
  // Point at a path that can never be created (a file where a dir is expected).
  const blocker = path.join(tmpDir, 'blocker-file');
  fs.writeFileSync(blocker, 'x');
  process.env.ATTRIBUT_CONFIG_DIR = path.join(blocker, 'nested');
  assert.doesNotThrow(() => state.touchHookInvocation(new Date()));
});

test('readState preserves other keys already in the file (forward-compatible)', () => {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(state.statePath(), JSON.stringify({ some_future_key: 'x' }) + '\n', 'utf8');
  state.touchHookInvocation(new Date('2026-07-03T00:00:00.000Z'));
  const onDisk = JSON.parse(fs.readFileSync(state.statePath(), 'utf8'));
  assert.equal(onDisk.some_future_key, 'x');
  assert.equal(onDisk.last_hook_invocation_at, '2026-07-03T00:00:00.000Z');
});
