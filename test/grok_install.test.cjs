'use strict';

// Grok hook installer: write/remove ~/.grok/hooks/attribut.json as an
// ATTRIBUT-owned file. Does not merge into Claude settings or Cursor hooks.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const settingsGrok = require('../src/settings_grok.cjs');
const install = require('../src/install.cjs');

function withIsolated(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-hooks-'));
  const grokHooks = path.join(dir, 'grok', 'hooks', 'attribut.json');
  const claude = path.join(dir, 'claude', 'settings.json');
  const cfg = path.join(dir, 'config');
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.mkdirSync(path.dirname(grokHooks), { recursive: true });
  fs.mkdirSync(cfg, { recursive: true });
  const claudeSeed = JSON.stringify({ env: { KEEP_ME: '1' }, hooks: { Stop: [] } }, null, 2) + '\n';
  fs.writeFileSync(claude, claudeSeed);

  const prev = {
    GROK_HOOKS_PATH: process.env.GROK_HOOKS_PATH,
    CLAUDE_SETTINGS_PATH: process.env.CLAUDE_SETTINGS_PATH,
    ATTRIBUT_CONFIG_DIR: process.env.ATTRIBUT_CONFIG_DIR,
  };
  process.env.GROK_HOOKS_PATH = grokHooks;
  process.env.CLAUDE_SETTINGS_PATH = claude;
  process.env.ATTRIBUT_CONFIG_DIR = cfg;
  try {
    return fn({ dir, grokHooks, claude, claudeSeed, cfg });
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const COLLECTOR = '/abs/collector.cjs';

test('grok is an installable agent (provider xai)', () => {
  assert.ok(install.INSTALLABLE_AGENTS.includes('grok'));
  assert.strictEqual(install.AGENT_PROVIDER.grok, 'xai');
});

test('buildGrokHookSpecs: Stop + SessionEnd command hooks, --provider xai, no token', () => {
  const specs = install.buildGrokHookSpecs({ collector: COLLECTOR, ingestBase: null });
  assert.strictEqual(specs.Stop[0].hooks[0].type, 'command');
  assert.strictEqual(specs.Stop[0].hooks[0].timeout, 30);
  assert.match(specs.Stop[0].hooks[0].command, /--provider xai stop/);
  assert.match(specs.SessionEnd[0].hooks[0].command, /--provider xai sessionend/);
  assert.ok(!/token/i.test(specs.Stop[0].hooks[0].command), 'token must never be embedded');
  assert.ok(!/token/i.test(specs.SessionEnd[0].hooks[0].command), 'token must never be embedded');
});

test('install writes attribut.json with --provider xai; Claude settings.json unchanged', () => {
  withIsolated(({ grokHooks, claude, claudeSeed }) => {
    assert.strictEqual(install.runInstall(['--provider', 'xai', '--key=tok-grok']), 0);
    assert.ok(fs.existsSync(grokHooks), 'attribut.json written');
    const onDisk = JSON.parse(fs.readFileSync(grokHooks, 'utf8'));
    const raw = fs.readFileSync(grokHooks, 'utf8');
    assert.match(raw, /--provider xai (stop|sessionend)/);
    assert.ok(Array.isArray(onDisk.hooks.Stop) && onDisk.hooks.Stop.length === 1);
    assert.ok(Array.isArray(onDisk.hooks.SessionEnd) && onDisk.hooks.SessionEnd.length === 1);
    assert.strictEqual(onDisk.hooks.Stop[0].hooks[0].timeout, 30);
    assert.strictEqual(fs.readFileSync(claude, 'utf8'), claudeSeed, 'Claude settings.json must be untouched');
  });
});

test('re-install is idempotent (no duplicate Stop/SessionEnd entries)', () => {
  withIsolated(({ grokHooks }) => {
    assert.strictEqual(install.runInstall(['--provider', 'xai', '--key=tok-a']), 0);
    assert.strictEqual(install.runInstall(['--provider', 'xai', '--key=tok-b']), 0);
    const onDisk = JSON.parse(fs.readFileSync(grokHooks, 'utf8'));
    assert.strictEqual(onDisk.hooks.Stop.length, 1, 'no duplicate Stop');
    assert.strictEqual(onDisk.hooks.SessionEnd.length, 1, 'no duplicate SessionEnd');
  });
});

test('uninstall --provider xai removes only attribut.json; sibling hook files survive', () => {
  withIsolated(({ grokHooks, claude, claudeSeed }) => {
    const sibling = path.join(path.dirname(grokHooks), 'user-owned.json');
    fs.writeFileSync(sibling, JSON.stringify({ hooks: { SessionStart: [] } }) + '\n');
    assert.strictEqual(install.runInstall(['--provider', 'xai', '--key=tok-grok']), 0);
    assert.ok(fs.existsSync(grokHooks));

    assert.strictEqual(install.runUninstall(['--provider', 'xai']), 0);
    assert.ok(!fs.existsSync(grokHooks), 'attribut.json removed');
    assert.ok(fs.existsSync(sibling), 'sibling hook file preserved');
    assert.strictEqual(fs.readFileSync(claude, 'utf8'), claudeSeed, 'Claude settings.json still untouched');
  });
});

test('uninstall is a no-op when attribut.json is absent', () => {
  withIsolated(() => {
    const res = settingsGrok.applyGrokUninstall();
    assert.strictEqual(res.removed, 0);
    assert.strictEqual(res.backupPath, null);
  });
});

test('applyGrokHooks preserves unrelated events already in attribut.json', () => {
  withIsolated(({ grokHooks }) => {
    fs.writeFileSync(
      grokHooks,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-owned' }] }],
        },
      })
    );
    const specs = install.buildGrokHookSpecs({
      collector: install.collectorPath(),
      ingestBase: null,
    });
    settingsGrok.applyGrokHooks(specs);
    const onDisk = JSON.parse(fs.readFileSync(grokHooks, 'utf8'));
    assert.strictEqual(onDisk.hooks.SessionStart[0].hooks[0].command, 'echo user-owned');
    assert.ok(onDisk.hooks.Stop[0].hooks[0].command.includes('collector.cjs'));
  });
});
