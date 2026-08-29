'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const settings = require('../src/settings.cjs');
const install = require('../src/install.cjs');
const tokenStore = require('../src/token.cjs');

const COLLECTOR = install.collectorPath();

function hooksMap(key = 'tok-1', ingestBase = null) {
  return install.buildHooksMap({ key, collector: COLLECTOR, ingestBase });
}

/** Count entries in an event array that belong to us. */
function ourEntries(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((e) =>
    Array.isArray(e.hooks) && e.hooks.some((h) => install.isOurCommand(h.command))
  );
}

function tmpSettings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-settings-'));
  return path.join(dir, 'settings.json');
}

/**
 * A no-provider `uninstall` is now a full disconnect that sweeps EVERY agent, so
 * it reads Codex/Cursor/Antigravity config too. Point those at fresh, empty tmp
 * files so the sweep stays sandboxed and never touches the dev machine's real
 * ~/.codex, ~/.cursor, or ~/.gemini. Returns a restore fn for the finally block.
 */
function sandboxOtherAgents() {
  const files = {
    CODEX_CONFIG_PATH: 'config.toml',
    CURSOR_HOOKS_PATH: 'hooks.json',
    AGY_HOOKS_PATH: 'agy-hooks.json',
    GROK_HOOKS_PATH: 'grok-attribut.json',
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-agents-'));
  const prev = {};
  for (const k of Object.keys(files)) {
    prev[k] = process.env[k];
    process.env[k] = path.join(dir, files[k]);
  }
  return () => {
    for (const k of Object.keys(files)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
}

/**
 * Run `fn(dir)` with every agent's config path, the token/config/legacy dirs, and
 * the timer dirs pointed into one fresh tmp dir (timer activation skipped). Used
 * by the multi-agent uninstall tests so installing/removing all agents never
 * escapes the sandbox. Restores all touched env vars afterwards.
 */
function withSandbox(fn) {
  const keys = [
    'CLAUDE_SETTINGS_PATH',
    'CODEX_CONFIG_PATH',
    'CURSOR_HOOKS_PATH',
    'AGY_HOOKS_PATH',
    'GROK_HOOKS_PATH',
    'ATTRIBUT_CONFIG_DIR',
    'ATTRIBUT_HOOKS_DIR',
    'ATTRIBUT_LAUNCHD_DIR',
    'ATTRIBUT_SYSTEMD_USER_DIR',
    'ATTRIBUT_SKIP_TIMER_ACTIVATION',
  ];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-all-'));
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  process.env.CLAUDE_SETTINGS_PATH = path.join(dir, 'claude-settings.json');
  process.env.CODEX_CONFIG_PATH = path.join(dir, 'codex-config.toml');
  process.env.CURSOR_HOOKS_PATH = path.join(dir, 'cursor-hooks.json');
  process.env.AGY_HOOKS_PATH = path.join(dir, 'agy-hooks.json');
  process.env.GROK_HOOKS_PATH = path.join(dir, 'grok-attribut.json');
  process.env.ATTRIBUT_CONFIG_DIR = configDir;
  process.env.ATTRIBUT_HOOKS_DIR = path.join(dir, 'claude-hooks');
  process.env.ATTRIBUT_LAUNCHD_DIR = path.join(dir, 'launchd');
  process.env.ATTRIBUT_SYSTEMD_USER_DIR = path.join(dir, 'systemd');
  process.env.ATTRIBUT_SKIP_TIMER_ACTIVATION = '1';
  try {
    return fn(dir);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('buildHookCommand never embeds the token', () => {
  const cmd = install.buildHookCommand('sessionend', {
    collector: COLLECTOR,
    ingestBase: null,
  });
  assert.ok(!cmd.includes('ATTRIBUT_HOOK_TOKEN'));
  assert.ok(!/token/i.test(cmd));
  assert.ok(cmd.includes(`node '${COLLECTOR}' sessionend`));
  assert.ok(!cmd.includes('INGEST_BASE'));
});

test('buildHookCommand includes INGEST_BASE when given (non-secret)', () => {
  const cmd = install.buildHookCommand('stop', {
    collector: COLLECTOR,
    ingestBase: 'https://ingest.example',
  });
  assert.ok(cmd.includes("INGEST_BASE='https://ingest.example'"));
});

test('mergeHooks is idempotent — running twice does NOT duplicate our hooks', () => {
  const once = settings.mergeHooks({}, hooksMap());
  const twice = settings.mergeHooks(once, hooksMap());
  assert.equal(ourEntries(twice.hooks.PostToolUse).length, 1);
  assert.equal(ourEntries(twice.hooks.SessionEnd).length, 1);
  assert.equal(ourEntries(twice.hooks.Stop).length, 1);
});

test('mergeHooks preserves unrelated user hooks and other settings', () => {
  const existing = {
    theme: 'dark',
    hooks: {
      SessionEnd: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }],
    },
  };
  const merged = settings.mergeHooks(existing, hooksMap());
  assert.equal(merged.theme, 'dark');
  // user hook + our hook both present
  assert.equal(merged.hooks.SessionEnd.length, 2);
  assert.ok(merged.hooks.SessionEnd.some((e) => e.hooks[0].command === 'echo user-hook'));
  assert.equal(ourEntries(merged.hooks.SessionEnd).length, 1);
  // the written entry has no private _dedupeKey leaked
  assert.ok(!('_dedupeKey' in merged.hooks.SessionEnd[1]));
});

test('removeHooks strips only ours, prunes empty events, keeps user hooks', () => {
  const merged = settings.mergeHooks(
    { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } },
    hooksMap()
  );
  const { settings: cleaned, removed } = settings.removeHooks(merged, install.isOurCommand);
  assert.equal(removed, 3); // PostToolUse + SessionEnd + Stop
  // SessionEnd keeps the user hook; PostToolUse/Stop pruned (only had ours)
  assert.equal(cleaned.hooks.SessionEnd.length, 1);
  assert.equal(cleaned.hooks.SessionEnd[0].hooks[0].command, 'echo keep');
  assert.ok(!('PostToolUse' in cleaned.hooks));
  assert.ok(!('Stop' in cleaned.hooks));
});

test('removeHooks drops the empty hooks object entirely when nothing remains', () => {
  const merged = settings.mergeHooks({}, hooksMap());
  const { settings: cleaned, removed } = settings.removeHooks(merged, install.isOurCommand);
  assert.equal(removed, 3);
  assert.ok(!('hooks' in cleaned));
});

test('isOurCommand matches legacy attribut-collector.cjs invocations', () => {
  assert.ok(
    install.isOurCommand(
      "ATTRIBUT_HOOK_TOKEN='x' node '/home/u/.claude/hooks/attribut-collector.cjs' sessionend"
    )
  );
  assert.ok(!install.isOurCommand('echo hello'));
});

test('isOurCommand matches legacy bin-based and env-token hook forms', () => {
  // Pre-overhaul: bin invoked directly with the token as an env prefix.
  assert.ok(install.isOurCommand("ATTRIBUT_HOOK_TOKEN='abc' attribut posttooluse"));
  assert.ok(install.isOurCommand('attribut sessionend'));
  assert.ok(install.isOurCommand("INGEST_BASE='https://x' attribut stop"));
  // The env-token marker alone is enough.
  assert.ok(install.isOurCommand("ATTRIBUT_HOOK_TOKEN='abc' something-else"));
  // Conservative: a bare mention of the word, or another bin, is NOT ours.
  assert.ok(!install.isOurCommand('echo attribut is great'));
  assert.ok(!install.isOurCommand('attribut --version'));
  assert.ok(!install.isOurCommand("node '/x/y/attributes.cjs' stop"));
});

test('mergeHooks evicts a legacy bin hook instead of stacking a duplicate', () => {
  // Reproduces the upgrade-over-old-install bug: an existing pre-overhaul hook
  // whose command does NOT contain the current collector path.
  const existing = {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: "ATTRIBUT_HOOK_TOKEN='old' attribut posttooluse" }],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: "ATTRIBUT_HOOK_TOKEN='old' attribut stop" }] }],
    },
  };
  // Without the predicate the legacy entry survives → duplicate.
  const naive = settings.mergeHooks(existing, hooksMap());
  assert.equal(naive.hooks.PostToolUse.length, 2);
  // With the predicate the legacy entry is replaced in place → exactly one.
  const merged = settings.mergeHooks(existing, hooksMap(), install.isOurCommand);
  assert.equal(merged.hooks.PostToolUse.length, 1);
  assert.equal(ourEntries(merged.hooks.PostToolUse).length, 1);
  assert.equal(merged.hooks.Stop.length, 1);
  // and the surviving command is the current node-based one.
  assert.ok(merged.hooks.PostToolUse[0].hooks[0].command.includes(COLLECTOR));
});

test('runInstall over a legacy install does not duplicate hooks on disk', () => {
  const p = tmpSettings();
  fs.writeFileSync(
    p,
    JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: "ATTRIBUT_HOOK_TOKEN='old' attribut posttooluse" },
            ],
          },
        ],
        SessionEnd: [
          { hooks: [{ type: 'command', command: "ATTRIBUT_HOOK_TOKEN='old' attribut sessionend" }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: "ATTRIBUT_HOOK_TOKEN='old' attribut stop" }] }],
      },
    }) + '\n',
    'utf8'
  );
  const prevEnv = process.env.CLAUDE_SETTINGS_PATH;
  const prevConfig = process.env.ATTRIBUT_CONFIG_DIR;
  process.env.CLAUDE_SETTINGS_PATH = p;
  process.env.ATTRIBUT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-config-'));
  try {
    assert.equal(install.runInstall(['--key=tok-new']), 0);
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const ev of ['PostToolUse', 'SessionEnd', 'Stop']) {
      assert.equal(onDisk.hooks[ev].length, 1, `${ev} should have exactly one entry`);
      assert.ok(onDisk.hooks[ev][0].hooks[0].command.includes(COLLECTOR));
      assert.ok(!onDisk.hooks[ev][0].hooks[0].command.includes('ATTRIBUT_HOOK_TOKEN'));
    }
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_SETTINGS_PATH;
    else process.env.CLAUDE_SETTINGS_PATH = prevEnv;
    if (prevConfig === undefined) delete process.env.ATTRIBUT_CONFIG_DIR;
    else process.env.ATTRIBUT_CONFIG_DIR = prevConfig;
  }
});

test('applyHooks backs up, writes valid JSON, and is idempotent on disk', () => {
  const p = tmpSettings();
  fs.writeFileSync(p, JSON.stringify({ theme: 'dark' }) + '\n', 'utf8');

  const r1 = settings.applyHooks(hooksMap(), p);
  // backup created since the file existed before the write
  assert.ok(r1.backupPath && r1.backupPath.startsWith(p + '.bak.'));
  let onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(onDisk.theme, 'dark');
  assert.equal(ourEntries(onDisk.hooks.PostToolUse).length, 1);

  settings.applyHooks(hooksMap('tok-2'), p);
  onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(ourEntries(onDisk.hooks.SessionEnd).length, 1); // still one
});

test('applyUninstall is a no-op (no backup, no rewrite) when nothing matches', () => {
  const p = tmpSettings();
  fs.writeFileSync(p, JSON.stringify({ theme: 'dark' }) + '\n', 'utf8');
  const r = settings.applyUninstall(install.isOurCommand, p);
  assert.equal(r.removed, 0);
  assert.equal(r.backupPath, null);
  // no .bak.* file created
  const dir = path.dirname(p);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.bak.')).length, 0);
});

test('install then uninstall round-trips on disk, preserving other settings', () => {
  const p = tmpSettings();
  fs.writeFileSync(
    p,
    JSON.stringify({
      theme: 'dark',
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] },
    }) + '\n',
    'utf8'
  );
  const prevEnv = process.env.CLAUDE_SETTINGS_PATH;
  const prevHooks = process.env.ATTRIBUT_HOOKS_DIR;
  const prevConfig = process.env.ATTRIBUT_CONFIG_DIR;
  // runUninstall's default (no --provider) path also removes the heartbeat
  // timer (timer.cjs) — sandbox its dirs and skip real OS activation so this
  // never touches the dev machine's or CI runner's actual scheduler.
  const prevLaunchd = process.env.ATTRIBUT_LAUNCHD_DIR;
  const prevSystemd = process.env.ATTRIBUT_SYSTEMD_USER_DIR;
  const prevSkipTimer = process.env.ATTRIBUT_SKIP_TIMER_ACTIVATION;
  process.env.CLAUDE_SETTINGS_PATH = p;
  process.env.ATTRIBUT_HOOKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-hooks-'));
  process.env.ATTRIBUT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-config-'));
  process.env.ATTRIBUT_LAUNCHD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-launchd-'));
  process.env.ATTRIBUT_SYSTEMD_USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-systemd-'));
  process.env.ATTRIBUT_SKIP_TIMER_ACTIVATION = '1';
  const restoreAgents = sandboxOtherAgents();
  const tokenFile = path.join(process.env.ATTRIBUT_CONFIG_DIR, 'token');
  try {
    assert.equal(install.runInstall(['--key=tok-xyz']), 0);
    let onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(ourEntries(onDisk.hooks.SessionEnd).length, 1);
    assert.equal(onDisk.hooks.SessionEnd.length, 2); // user + ours

    // Token lives in its own 0600 file, NOT in settings.json.
    assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), 'tok-xyz');
    assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(p, 'utf8').includes('tok-xyz'));
    // settings.json is written user-only.
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);

    assert.equal(install.runUninstall([]), 0);
    onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(onDisk.theme, 'dark');
    assert.equal(onDisk.hooks.SessionEnd.length, 1);
    assert.equal(onDisk.hooks.SessionEnd[0].hooks[0].command, 'echo keep');
    // Uninstall dropped the token file.
    assert.ok(!fs.existsSync(tokenFile));
  } finally {
    restoreAgents();
    if (prevEnv === undefined) delete process.env.CLAUDE_SETTINGS_PATH;
    else process.env.CLAUDE_SETTINGS_PATH = prevEnv;
    if (prevHooks === undefined) delete process.env.ATTRIBUT_HOOKS_DIR;
    else process.env.ATTRIBUT_HOOKS_DIR = prevHooks;
    if (prevConfig === undefined) delete process.env.ATTRIBUT_CONFIG_DIR;
    else process.env.ATTRIBUT_CONFIG_DIR = prevConfig;
    if (prevLaunchd === undefined) delete process.env.ATTRIBUT_LAUNCHD_DIR;
    else process.env.ATTRIBUT_LAUNCHD_DIR = prevLaunchd;
    if (prevSystemd === undefined) delete process.env.ATTRIBUT_SYSTEMD_USER_DIR;
    else process.env.ATTRIBUT_SYSTEMD_USER_DIR = prevSystemd;
    if (prevSkipTimer === undefined) delete process.env.ATTRIBUT_SKIP_TIMER_ACTIVATION;
    else process.env.ATTRIBUT_SKIP_TIMER_ACTIVATION = prevSkipTimer;
  }
});

test('uninstall removes legacy copied collector files', () => {
  const settingsP = tmpSettings();
  const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-hooks-'));
  fs.writeFileSync(path.join(hooksDir, 'attribut-collector.cjs'), '// legacy', 'utf8');
  fs.writeFileSync(path.join(hooksDir, 'parser.cjs'), '// legacy', 'utf8');

  const prevEnv = process.env.CLAUDE_SETTINGS_PATH;
  const prevHooks = process.env.ATTRIBUT_HOOKS_DIR;
  const prevConfig = process.env.ATTRIBUT_CONFIG_DIR;
  // See the timer.cjs sandboxing note in the round-trip test above.
  const prevLaunchd = process.env.ATTRIBUT_LAUNCHD_DIR;
  const prevSystemd = process.env.ATTRIBUT_SYSTEMD_USER_DIR;
  const prevSkipTimer = process.env.ATTRIBUT_SKIP_TIMER_ACTIVATION;
  process.env.CLAUDE_SETTINGS_PATH = settingsP;
  process.env.ATTRIBUT_HOOKS_DIR = hooksDir;
  process.env.ATTRIBUT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-config-'));
  process.env.ATTRIBUT_LAUNCHD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-launchd-'));
  process.env.ATTRIBUT_SYSTEMD_USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-systemd-'));
  process.env.ATTRIBUT_SKIP_TIMER_ACTIVATION = '1';
  const restoreAgents = sandboxOtherAgents();
  try {
    assert.equal(install.runUninstall([]), 0);
    assert.ok(!fs.existsSync(path.join(hooksDir, 'attribut-collector.cjs')));
    assert.ok(!fs.existsSync(path.join(hooksDir, 'parser.cjs')));
    // dir was emptied → pruned
    assert.ok(!fs.existsSync(hooksDir));
  } finally {
    restoreAgents();
    if (prevEnv === undefined) delete process.env.CLAUDE_SETTINGS_PATH;
    else process.env.CLAUDE_SETTINGS_PATH = prevEnv;
    if (prevHooks === undefined) delete process.env.ATTRIBUT_HOOKS_DIR;
    else process.env.ATTRIBUT_HOOKS_DIR = prevHooks;
    if (prevConfig === undefined) delete process.env.ATTRIBUT_CONFIG_DIR;
    else process.env.ATTRIBUT_CONFIG_DIR = prevConfig;
    if (prevLaunchd === undefined) delete process.env.ATTRIBUT_LAUNCHD_DIR;
    else process.env.ATTRIBUT_LAUNCHD_DIR = prevLaunchd;
    if (prevSystemd === undefined) delete process.env.ATTRIBUT_SYSTEMD_USER_DIR;
    else process.env.ATTRIBUT_SYSTEMD_USER_DIR = prevSystemd;
    if (prevSkipTimer === undefined) delete process.env.ATTRIBUT_SKIP_TIMER_ACTIVATION;
    else process.env.ATTRIBUT_SKIP_TIMER_ACTIVATION = prevSkipTimer;
  }
});

test('readSettings throws on malformed JSON (never clobbers)', () => {
  const p = tmpSettings();
  fs.writeFileSync(p, '{ not json', 'utf8');
  assert.throws(() => settings.readSettings(p), /not valid JSON/);
});

test('uninstall (no --provider) fully disconnects EVERY agent, not just Claude', () => {
  withSandbox((dir) => {
    // Connect every agent.
    assert.equal(install.runInstall(['--provider', 'anthropic', '--key=tok-a']), 0);
    assert.equal(install.runInstall(['--provider', 'openai', '--key=tok-o']), 0);
    assert.equal(install.runInstall(['--provider', 'cursor', '--key=tok-c']), 0);
    assert.equal(install.runInstall(['--provider', 'antigravity', '--key=tok-g']), 0);
    assert.equal(install.runInstall(['--provider', 'xai', '--key=tok-x']), 0);

    const files = [
      process.env.CLAUDE_SETTINGS_PATH,
      process.env.CODEX_CONFIG_PATH,
      process.env.CURSOR_HOOKS_PATH,
      process.env.AGY_HOOKS_PATH,
      process.env.GROK_HOOKS_PATH,
    ];
    for (const f of files) {
      assert.match(fs.readFileSync(f, 'utf8'), /collector\.cjs/, `${f} has our hook before uninstall`);
    }
    const tokenFile = path.join(process.env.ATTRIBUT_CONFIG_DIR, 'token');
    assert.ok(fs.existsSync(tokenFile), 'token store exists before uninstall');

    // The plain, no-flag uninstall must remove ALL of them.
    assert.equal(install.runUninstall([]), 0);

    for (const f of files) {
      if (!fs.existsSync(f)) continue; // grok uninstall deletes attribut.json
      assert.ok(
        !fs.readFileSync(f, 'utf8').includes('collector.cjs'),
        `${f} must have NO orphaned ATTRIBUT hook after full uninstall`
      );
    }
    assert.ok(!fs.existsSync(tokenFile), 'token store dropped on full uninstall');
  });
});

test('uninstall --provider openai scopes to Codex, leaving Claude + shared token intact', () => {
  withSandbox(() => {
    // Manual `install` writes a single shared (bare) token, so a scoped uninstall
    // must remove only Codex's hook and leave the shared token for Claude.
    assert.equal(install.runInstall(['--provider', 'anthropic', '--key=tok-a']), 0);
    assert.equal(install.runInstall(['--provider', 'openai', '--key=tok-shared']), 0);

    assert.equal(install.runUninstall(['--provider', 'openai']), 0);

    // Codex hook gone…
    assert.ok(!fs.readFileSync(process.env.CODEX_CONFIG_PATH, 'utf8').includes('collector.cjs'));
    // …but Claude's hook stays, and the shared token is NOT yanked out from under it.
    assert.match(fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8'), /collector\.cjs/);
    assert.ok(
      fs.existsSync(path.join(process.env.ATTRIBUT_CONFIG_DIR, 'token')),
      'shared token preserved for the still-connected Claude agent'
    );
  });
});

test('uninstall --provider revokes only that agent entry in a per-agent token map', () => {
  withSandbox(() => {
    // The `connect` flow stores a per-agent map — a scoped uninstall drops just
    // that agent's entry and keeps the rest.
    tokenStore.writeToken('cc', 'claude_code');
    tokenStore.writeToken('oo', 'codex');
    install.runInstall(['--provider', 'openai', '--key=oo']); // bake Codex's hook to remove
    // Re-establish the map (runInstall's bare write clobbered it).
    tokenStore.writeToken('cc', 'claude_code');
    tokenStore.writeToken('oo', 'codex');

    assert.equal(install.runUninstall(['--provider', 'openai']), 0);

    assert.equal(tokenStore.readToken('codex'), '', 'Codex token revoked');
    assert.equal(tokenStore.readToken('claude_code'), 'cc', 'Claude token kept');
  });
});
