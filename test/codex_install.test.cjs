'use strict';

// Codex hook installer: write/merge/remove our [[hooks.PostToolUse]] +
// [[hooks.Stop]] array-of-tables in ~/.codex/config.toml, idempotently and
// without disturbing user-authored hooks or other TOML.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const settingsCodex = require('../src/settings_codex.cjs');
const install = require('../src/install.cjs');

function withConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cfg-'));
  const p = path.join(dir, 'config.toml');
  const prev = process.env.CODEX_CONFIG_PATH;
  process.env.CODEX_CONFIG_PATH = p;
  try {
    return fn(p);
  } finally {
    if (prev === undefined) delete process.env.CODEX_CONFIG_PATH;
    else process.env.CODEX_CONFIG_PATH = prev;
  }
}

const COLLECTOR = '/abs/collector.cjs';
const SPECS = install.buildCodexHookSpecs({ collector: COLLECTOR, ingestBase: null });

test('buildCodexHookSpecs: catch-all PostToolUse + Stop, --provider openai, no token', () => {
  const post = SPECS['hooks.PostToolUse'][0];
  assert.strictEqual(post.keys.matcher, '.*');
  const postCmd = post.nested.entries[0].command;
  assert.match(postCmd, /--provider openai posttooluse/);
  assert.match(postCmd, /collector\.cjs/);
  assert.ok(!/token/i.test(postCmd), 'token must never be embedded');

  const stop = SPECS['hooks.Stop'][0];
  assert.deepStrictEqual(stop.keys || {}, {});
  assert.match(stop.nested.entries[0].command, /--provider openai stop/);
});

test('applyCodexHooks writes valid TOML; idempotent re-run does not duplicate', () => {
  withConfig((p) => {
    const isOurs = install.isOurCodexEntry(COLLECTOR);
    settingsCodex.applyCodexHooks(SPECS, isOurs);
    let onDisk = fs.readFileSync(p, 'utf8');
    assert.match(onDisk, /\[\[hooks\.PostToolUse\]\]/);
    assert.match(onDisk, /\[\[hooks\.Stop\]\]/);

    settingsCodex.applyCodexHooks(SPECS, isOurs);
    onDisk = fs.readFileSync(p, 'utf8');
    assert.strictEqual((onDisk.match(/--provider openai posttooluse/g) || []).length, 1);
    assert.strictEqual((onDisk.match(/--provider openai stop/g) || []).length, 1);
  });
});

test('merge preserves a user hook; uninstall removes only ours', () => {
  withConfig((p) => {
    fs.writeFileSync(
      p,
      [
        'model = "gpt-5.5"',
        '',
        '[[hooks.PostToolUse]]',
        'matcher = "^Bash$"',
        '[[hooks.PostToolUse.hooks]]',
        'type = "command"',
        'command = "echo user-owned"',
      ].join('\n')
    );
    const isOurs = install.isOurCodexEntry(COLLECTOR);
    settingsCodex.applyCodexHooks(SPECS, isOurs);
    let onDisk = fs.readFileSync(p, 'utf8');
    assert.match(onDisk, /echo user-owned/);
    assert.match(onDisk, /--provider openai posttooluse/);

    const res = settingsCodex.applyCodexUninstall(isOurs);
    assert.strictEqual(res.removed, 2); // PostToolUse + Stop
    onDisk = fs.readFileSync(p, 'utf8');
    assert.match(onDisk, /echo user-owned/, 'user hook survives uninstall');
    assert.ok(!onDisk.includes(COLLECTOR));
    assert.match(onDisk, /model = "gpt-5\.5"/);
  });
});

test('uninstall is a no-op when our hooks are absent', () => {
  withConfig(() => {
    const res = settingsCodex.applyCodexUninstall(install.isOurCodexEntry(COLLECTOR));
    assert.strictEqual(res.removed, 0);
    assert.strictEqual(res.backupPath, null);
  });
});

test('runInstall/runUninstall --provider openai round-trips via the CLI', () => {
  withConfig((p) => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tok-'));
    const prevCfg = process.env.ATTRIBUT_CONFIG_DIR;
    process.env.ATTRIBUT_CONFIG_DIR = cfg;
    try {
      assert.strictEqual(install.runInstall(['--provider', 'openai', '--key=tok-xyz']), 0);
      assert.ok(fs.existsSync(p), 'config.toml written');
      assert.ok(fs.existsSync(path.join(cfg, 'token')), 'token persisted');
      assert.match(fs.readFileSync(p, 'utf8'), /--provider openai (posttooluse|stop)/);
      assert.strictEqual(install.runUninstall(['--provider', 'openai']), 0);
      assert.ok(!fs.readFileSync(p, 'utf8').includes('collector.cjs'));
    } finally {
      if (prevCfg === undefined) delete process.env.ATTRIBUT_CONFIG_DIR;
      else process.env.ATTRIBUT_CONFIG_DIR = prevCfg;
    }
  });
});

test('codex is an installable agent (registerAgent routes openai)', () => {
  assert.ok(install.INSTALLABLE_AGENTS.includes('codex'));
  assert.strictEqual(install.AGENT_PROVIDER.codex, 'openai');
});
