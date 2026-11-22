'use strict';

// Antigravity hook installer: write/merge/remove our named hook in
// ~/.gemini/config/hooks.json (the named-hook map shape), idempotently and
// without disturbing other named hooks.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const settingsAgy = require('../src/settings_agy.cjs');
const install = require('../src/install.cjs');

function withHooksFile(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hooks-'));
  const p = path.join(dir, 'hooks.json');
  const prev = process.env.AGY_HOOKS_PATH;
  process.env.AGY_HOOKS_PATH = p;
  try {
    return fn(p);
  } finally {
    if (prev === undefined) delete process.env.AGY_HOOKS_PATH;
    else process.env.AGY_HOOKS_PATH = prev;
  }
}

const SPEC = install.buildAgyHookSpec({ collector: '/abs/collector.cjs', ingestBase: null });

test('buildAgyHookSpec registers a PostToolUse command hook with --provider', () => {
  const groups = SPEC.PostToolUse;
  assert.ok(Array.isArray(groups) && groups.length === 1);
  const handler = groups[0].hooks[0];
  assert.strictEqual(handler.type, 'command');
  assert.match(handler.command, /--provider antigravity posttooluse/);
  assert.match(handler.command, /collector\.cjs/);
});

test('buildAgyHookSpec registers Stop as a FLAT handler list (no matcher) with the stop trigger', () => {
  const stop = SPEC.Stop;
  assert.ok(Array.isArray(stop) && stop.length === 1, 'one Stop handler');
  const handler = stop[0];
  // Stop is flat in agy's hooks.json: handler objects directly, no group wrapper.
  assert.strictEqual(handler.type, 'command');
  assert.ok(!('matcher' in handler) && !('hooks' in handler), 'no matcher/hooks wrapper');
  assert.match(handler.command, /collector\.cjs' --provider antigravity stop$/);
  assert.strictEqual(handler.timeout, 30);
  // Only the two events we capture; nothing agy doesn't support (no SessionEnd).
  assert.deepStrictEqual(Object.keys(SPEC).sort(), ['PostToolUse', 'Stop']);
  // The ingest base (not a secret) is inlined on both handlers alike.
  const withBase = install.buildAgyHookSpec({ collector: '/abs/collector.cjs', ingestBase: 'https://ingest.example' });
  assert.match(withBase.Stop[0].command, /^INGEST_BASE='https:\/\/ingest\.example' node /);
  assert.match(withBase.PostToolUse[0].hooks[0].command, /^INGEST_BASE='https:\/\/ingest\.example' node /);
});

test('applyAgyHooks writes our named hook; idempotent re-run does not duplicate', () => {
  withHooksFile((p) => {
    settingsAgy.applyAgyHooks(SPEC);
    let onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(onDisk[settingsAgy.AGY_HOOK_NAME], 'named hook present');
    assert.strictEqual(Object.keys(onDisk).length, 1);

    // Re-run → still exactly one named entry (replaced in place).
    settingsAgy.applyAgyHooks(SPEC);
    onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(Object.keys(onDisk).length, 1);
    assert.ok(onDisk[settingsAgy.AGY_HOOK_NAME].PostToolUse);
    assert.strictEqual(onDisk[settingsAgy.AGY_HOOK_NAME].Stop.length, 1, 'Stop not duplicated');
  });
});

test('re-install over a PostToolUse-only entry adds Stop; uninstall removes both', () => {
  withHooksFile((p) => {
    // An entry written by an older installer (PostToolUse only).
    const legacy = { PostToolUse: SPEC.PostToolUse };
    fs.writeFileSync(p, JSON.stringify({ [settingsAgy.AGY_HOOK_NAME]: legacy, 'user-thing': { Stop: [] } }));
    settingsAgy.applyAgyHooks(SPEC);
    let onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepStrictEqual(onDisk[settingsAgy.AGY_HOOK_NAME], SPEC);
    assert.deepStrictEqual(onDisk['user-thing'], { Stop: [] }, 'foreign Stop hook untouched');

    settingsAgy.applyAgyUninstall();
    onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(!onDisk[settingsAgy.AGY_HOOK_NAME], 'whole named entry (PostToolUse + Stop) removed');
    assert.deepStrictEqual(onDisk['user-thing'], { Stop: [] });
  });
});

test('merge preserves OTHER named hooks; uninstall removes only ours', () => {
  withHooksFile((p) => {
    // Seed a foreign hook the user owns.
    fs.writeFileSync(p, JSON.stringify({ 'user-thing': { Stop: [] } }));
    settingsAgy.applyAgyHooks(SPEC);
    let onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(onDisk['user-thing'], 'foreign hook preserved');
    assert.ok(onDisk[settingsAgy.AGY_HOOK_NAME], 'our hook added');

    const res = settingsAgy.applyAgyUninstall();
    assert.strictEqual(res.removed, 1);
    onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(onDisk['user-thing'], 'foreign hook still there after uninstall');
    assert.ok(!onDisk[settingsAgy.AGY_HOOK_NAME], 'our hook removed');
  });
});

test('uninstall is a no-op when our hook is absent', () => {
  withHooksFile(() => {
    const res = settingsAgy.applyAgyUninstall();
    assert.strictEqual(res.removed, 0);
    assert.strictEqual(res.backupPath, null);
  });
});

test('runInstall/runUninstall --provider antigravity round-trips via the CLI', () => {
  withHooksFile((p) => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cfg-'));
    const prevCfg = process.env.ATTRIBUT_CONFIG_DIR;
    process.env.ATTRIBUT_CONFIG_DIR = cfg;
    try {
      assert.strictEqual(install.runInstall(['--provider', 'antigravity', '--key=tok-xyz']), 0);
      assert.ok(fs.existsSync(p), 'hooks.json written');
      const installed = JSON.parse(fs.readFileSync(p, 'utf8'))[settingsAgy.AGY_HOOK_NAME];
      assert.match(installed.PostToolUse[0].hooks[0].command, / --provider antigravity posttooluse$/);
      assert.match(installed.Stop[0].command, / --provider antigravity stop$/);
      assert.ok(fs.existsSync(path.join(cfg, 'token')), 'token persisted');
      assert.strictEqual(install.runUninstall(['--provider', 'antigravity']), 0);
      const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.ok(!onDisk[settingsAgy.AGY_HOOK_NAME], 'our hook removed');
    } finally {
      if (prevCfg === undefined) delete process.env.ATTRIBUT_CONFIG_DIR;
      else process.env.ATTRIBUT_CONFIG_DIR = prevCfg;
    }
  });
});

test('unknown --provider is rejected (exit 2)', () => {
  assert.strictEqual(install.runInstall(['--provider', 'bogus', '--key=x']), 2);
});
