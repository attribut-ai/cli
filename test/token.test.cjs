'use strict';

// TOKEN STORE TEST — the bearer token must live in a 0600 file, never inline.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

process.env.ATTRIBUT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-token-'));
const tokenStore = require('../src/token.cjs');

test('writeToken persists 0600 and readToken round-trips', () => {
  const file = tokenStore.writeToken('  secret-tok  ');
  assert.equal(file, tokenStore.tokenPath());
  assert.equal(tokenStore.readToken(), 'secret-tok'); // trimmed
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('readToken returns empty string when absent (never throws)', () => {
  tokenStore.removeToken();
  assert.equal(tokenStore.readToken(), '');
});

test('removeToken reports whether a file was removed', () => {
  tokenStore.writeToken('x');
  assert.equal(tokenStore.removeToken(), true);
  assert.equal(tokenStore.removeToken(), false); // already gone
});

// --- per-agent tokens (the device-flow `connect` path) ----------------------

test('writeToken(key, agent) stores a per-agent map; readToken(agent) resolves it', () => {
  tokenStore.removeToken();
  tokenStore.writeToken('cc-tok', 'claude_code');
  tokenStore.writeToken('agy-tok', 'agy');
  assert.equal(tokenStore.readToken('claude_code'), 'cc-tok');
  assert.equal(tokenStore.readToken('agy'), 'agy-tok');
  // no-arg read yields the claude_code primary
  assert.equal(tokenStore.readToken(), 'cc-tok');
});

test('a legacy bare token serves any agent (back-compat read)', () => {
  tokenStore.removeToken();
  tokenStore.writeToken('legacy'); // bare write
  assert.equal(tokenStore.readToken(), 'legacy');
  assert.equal(tokenStore.readToken('claude_code'), 'legacy');
  assert.equal(tokenStore.readToken('agy'), 'legacy');
});

test('first per-agent write migrates a legacy bare token to claude_code', () => {
  tokenStore.removeToken();
  tokenStore.writeToken('old-bare'); // legacy
  tokenStore.writeToken('agy-tok', 'agy'); // triggers migration
  assert.equal(tokenStore.readToken('claude_code'), 'old-bare');
  assert.equal(tokenStore.readToken('agy'), 'agy-tok');
});

test('removeToken(agent) drops one entry; file removed once empty', () => {
  tokenStore.removeToken();
  tokenStore.writeToken('cc', 'claude_code');
  tokenStore.writeToken('ag', 'agy');
  assert.equal(tokenStore.removeToken('claude_code'), true);
  assert.equal(tokenStore.readToken('claude_code'), ''); // gone
  assert.equal(tokenStore.readToken('agy'), 'ag'); // kept
  assert.equal(tokenStore.removeToken('agy'), true); // last one
  assert.equal(tokenStore.readToken(), ''); // file removed
});

test('removeToken(agent) leaves a BARE (shared) token untouched', () => {
  tokenStore.removeToken();
  tokenStore.writeToken('shared-bare'); // no agent → bare token
  // A scoped removal cannot attribute a shared token to one agent, so it is a
  // no-op — the token must survive for whichever agents still use it.
  assert.equal(tokenStore.removeToken('codex'), false);
  assert.equal(tokenStore.readToken(), 'shared-bare');
  // The unscoped removal still drops it entirely.
  assert.equal(tokenStore.removeToken(), true);
  assert.equal(tokenStore.readToken(), '');
});
