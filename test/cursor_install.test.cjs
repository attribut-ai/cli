'use strict';

// Cursor hook installer: write/merge/remove our sessionEnd + stop +
// afterShellExecution entries in ~/.cursor/hooks.json, idempotently and without
// disturbing user-authored hooks, the `version`, or other events.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const settingsCursor = require('../src/settings_cursor.cjs');
const install = require('../src/install.cjs');

function withHooks(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-hooks-'));
  const p = path.join(dir, 'hooks.json');
  const prev = process.env.CURSOR_HOOKS_PATH;
  process.env.CURSOR_HOOKS_PATH = p;
  try {
    return fn(p);
  } finally {
    if (prev === undefined) delete process.env.CURSOR_HOOKS_PATH;
    else process.env.CURSOR_HOOKS_PATH = prev;
  }
}

const COLLECTOR = '/abs/collector.cjs';
const SPECS = install.buildCursorHookSpecs({ collector: COLLECTOR, ingestBase: null });

test('buildCursorHookSpecs: sessionEnd/stop/afterShellExecution, --provider cursor, no token', () => {
  assert.match(SPECS.sessionEnd[0].command, /--provider cursor sessionend/);
  assert.match(SPECS.stop[0].command, /--provider cursor stop/);
  assert.match(SPECS.afterShellExecution[0].command, /--provider cursor posttooluse/);
  for (const ev of ['sessionEnd', 'stop', 'afterShellExecution']) {
    assert.strictEqual(SPECS[ev][0].type, 'command');
    assert.ok(!/token/i.test(SPECS[ev][0].command), 'token must never be embedded');
  }
});

test('applyCursorHooks writes version-1 JSON; idempotent re-run does not duplicate', () => {
  withHooks((p) => {
    const isOurs = install.isOurCursorEntry(COLLECTOR);
    settingsCursor.applyCursorHooks(SPECS, isOurs);
    let onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(onDisk.version, 1);
    assert.strictEqual(onDisk.hooks.sessionEnd.length, 1);

    settingsCursor.applyCursorHooks(SPECS, isOurs);
    onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(onDisk.hooks.sessionEnd.length, 1, 'no duplicate on re-run');
    assert.strictEqual(onDisk.hooks.afterShellExecution.length, 1);
  });
});

test('merge preserves a user hook + version; uninstall removes only ours', () => {
  withHooks((p) => {
    fs.writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        hooks: {
          sessionEnd: [{ command: 'echo user-owned', type: 'command' }],
          beforeSubmitPrompt: [{ command: 'echo other-event', type: 'command' }],
        },
      })
    );
    const isOurs = install.isOurCursorEntry(COLLECTOR);
    settingsCursor.applyCursorHooks(SPECS, isOurs);
    let onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    // user's sessionEnd hook survives alongside ours
    assert.strictEqual(onDisk.hooks.sessionEnd.length, 2);
    assert.ok(onDisk.hooks.sessionEnd.some((h) => h.command === 'echo user-owned'));
    assert.ok(onDisk.hooks.sessionEnd.some((h) => h.command.includes(COLLECTOR)));
    // an untouched event is preserved verbatim
    assert.strictEqual(onDisk.hooks.beforeSubmitPrompt[0].command, 'echo other-event');

    const res = settingsCursor.applyCursorUninstall(isOurs);
    assert.strictEqual(res.removed, 3); // sessionEnd + stop + afterShellExecution
    onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepStrictEqual(onDisk.hooks.sessionEnd, [{ command: 'echo user-owned', type: 'command' }]);
    assert.strictEqual(onDisk.hooks.beforeSubmitPrompt[0].command, 'echo other-event');
    assert.ok(!JSON.stringify(onDisk).includes(COLLECTOR));
  });
});

test('uninstall is a no-op when our hooks are absent', () => {
  withHooks(() => {
    const res = settingsCursor.applyCursorUninstall(install.isOurCursorEntry(COLLECTOR));
    assert.strictEqual(res.removed, 0);
    assert.strictEqual(res.backupPath, null);
  });
});

test('runInstall/runUninstall --provider cursor round-trips via the CLI', () => {
  withHooks((p) => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-tok-'));
    const prevCfg = process.env.ATTRIBUT_CONFIG_DIR;
    process.env.ATTRIBUT_CONFIG_DIR = cfg;
    try {
      assert.strictEqual(install.runInstall(['--provider', 'cursor', '--key=tok-xyz']), 0);
      assert.ok(fs.existsSync(p), 'hooks.json written');
      assert.ok(fs.existsSync(path.join(cfg, 'token')), 'token persisted');
      assert.match(fs.readFileSync(p, 'utf8'), /--provider cursor (sessionend|stop|posttooluse)/);
      assert.strictEqual(install.runUninstall(['--provider', 'cursor']), 0);
      assert.ok(!fs.readFileSync(p, 'utf8').includes('collector.cjs'));
    } finally {
      if (prevCfg === undefined) delete process.env.ATTRIBUT_CONFIG_DIR;
      else process.env.ATTRIBUT_CONFIG_DIR = prevCfg;
    }
  });
});

test('cursor is an installable agent (registerAgent routes cursor)', () => {
  assert.ok(install.INSTALLABLE_AGENTS.includes('cursor'));
  assert.strictEqual(install.AGENT_PROVIDER.cursor, 'cursor');
});
