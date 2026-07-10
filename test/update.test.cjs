'use strict';

// UPDATE TEST — semver compare, install-shape detection, the auto-update
// guardrails, the heartbeat update directive, the interactive nudge, and
// `attribut install --rebake`. No real network and no real npm: every side
// effect is injected (exec/fetchLatest/installInfo) and all state lives in a
// tmp ATTRIBUT_CONFIG_DIR.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const update = require('../src/update.cjs');
const heartbeat = require('../src/heartbeat.cjs');
const installer = require('../src/install.cjs');
const tokenStore = require('../src/token.cjs');
const { readState, writeState } = require('../src/state.cjs');
const { version: PKG_VERSION } = require('../package.json');

// Env the update paths are gated on — cleared per test, restored after. CI in
// particular is set on GitHub runners and would short-circuit every attempt.
const GATED_ENV = [
  'ATTRIBUT_CONFIG_DIR',
  'ATTRIBUT_NO_AUTO_UPDATE',
  'ATTRIBUT_NO_UPDATE_NOTIFIER',
  'NO_UPDATE_NOTIFIER',
  'CI',
  'CLAUDE_SETTINGS_PATH',
  'AGY_HOOKS_PATH',
  'CODEX_CONFIG_PATH',
  'CURSOR_HOOKS_PATH',
  'ATTRIBUT_LAUNCHD_DIR',
  'ATTRIBUT_SYSTEMD_USER_DIR',
  'ATTRIBUT_SKIP_TIMER_ACTIVATION',
];

let tmpDir;
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const k of GATED_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-update-'));
  process.env.ATTRIBUT_CONFIG_DIR = tmpDir;
  process.env.ATTRIBUT_SKIP_TIMER_ACTIVATION = '1';
  // Rebake reads EVERY provider's settings file — point them all into the tmp
  // dir so a test can never touch (or rewrite!) this machine's real hooks.
  process.env.CLAUDE_SETTINGS_PATH = path.join(tmpDir, 'settings.json');
  process.env.AGY_HOOKS_PATH = path.join(tmpDir, 'agy-hooks.json');
  process.env.CODEX_CONFIG_PATH = path.join(tmpDir, 'codex-config.toml');
  process.env.CURSOR_HOOKS_PATH = path.join(tmpDir, 'cursor-hooks.json');
  process.env.ATTRIBUT_LAUNCHD_DIR = path.join(tmpDir, 'launchd');
  process.env.ATTRIBUT_SYSTEMD_USER_DIR = path.join(tmpDir, 'systemd');
});

afterEach(() => {
  for (const k of GATED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// A writable fake npm-global install rooted in the tmp dir.
function fakeNpmGlobal() {
  const pkgDir = path.join(tmpDir, 'lib', 'node_modules', 'attribut');
  fs.mkdirSync(pkgDir, { recursive: true });
  return { kind: 'npm-global', packageDir: pkgDir };
}

// ---- compareSemver --------------------------------------------------------

test('compareSemver orders versions and rejects garbage', () => {
  assert.equal(update.compareSemver('1.0.0', '1.0.1'), -1);
  assert.equal(update.compareSemver('1.2.0', '1.1.9'), 1);
  assert.equal(update.compareSemver('2.0.0', '10.0.0'), -1); // numeric, not lexical
  assert.equal(update.compareSemver('1.1.0', '1.1.0'), 0);
  assert.equal(update.compareSemver('1.1.0-rc.1', '1.1.0'), -1); // prerelease < release
  assert.equal(update.compareSemver(' 1.1.0 ', '1.1.0'), 0); // trimmed
  assert.equal(update.compareSemver('latest', '1.0.0'), null);
  assert.equal(update.compareSemver('1.0', '1.0.0'), null);
  assert.equal(update.compareSemver(undefined, '1.0.0'), null);
});

// ---- detectInstall --------------------------------------------------------

test('detectInstall classifies the install shape from the collector path', () => {
  const cases = [
    ['/Users/x/.npm/_npx/2e275b8c/node_modules/attribut/src/collector.cjs', 'npx'],
    ['/usr/local/lib/node_modules/attribut/src/collector.cjs', 'npm-global'],
    ['/Users/x/.nvm/versions/node/v22.5.0/lib/node_modules/attribut/src/collector.cjs', 'npm-global'],
    ['/Users/x/Library/pnpm/global/5/.pnpm/attribut@1.0.1/node_modules/attribut/src/collector.cjs', 'pnpm'],
    ['/Users/x/.bun/install/global/node_modules/attribut/src/collector.cjs', 'bun'],
    ['/Users/x/Code/ATTRIBUT/cli/src/collector.cjs', 'checkout'],
  ];
  for (const [p, kind] of cases) {
    assert.equal(update.detectInstall(p).kind, kind, p);
  }
  assert.equal(
    update.detectInstall('/usr/local/lib/node_modules/attribut/src/collector.cjs').packageDir,
    '/usr/local/lib/node_modules/attribut'
  );
  assert.equal(update.detectInstall('/Users/x/Code/cli/src/collector.cjs').packageDir, null);
});

// ---- maybeAutoUpdate guardrails -------------------------------------------

test('maybeAutoUpdate skips invalid, equal, opted-out, CI, and non-npm targets', async () => {
  const calls = [];
  const exec = (args) => calls.push(args);
  const info = fakeNpmGlobal();

  let r = await update.maybeAutoUpdate({ updateTo: 'banana', exec, installInfo: info });
  assert.equal(r.attempted, false);
  assert.match(r.reason, /invalid/);

  r = await update.maybeAutoUpdate({ updateTo: PKG_VERSION, exec, installInfo: info });
  assert.deepEqual(r, { attempted: false, reason: 'already current' });

  process.env.ATTRIBUT_NO_AUTO_UPDATE = '1';
  r = await update.maybeAutoUpdate({ updateTo: '99.0.0', exec, installInfo: info });
  assert.match(r.reason, /env/);
  delete process.env.ATTRIBUT_NO_AUTO_UPDATE;

  fs.writeFileSync(update.autoUpdateOptOutPath(), '');
  r = await update.maybeAutoUpdate({ updateTo: '99.0.0', exec, installInfo: info });
  assert.match(r.reason, /--auto=off/);
  fs.unlinkSync(update.autoUpdateOptOutPath());

  process.env.CI = 'true';
  r = await update.maybeAutoUpdate({ updateTo: '99.0.0', exec, installInfo: info });
  assert.equal(r.reason, 'CI');
  delete process.env.CI;

  for (const kind of ['npx', 'pnpm', 'bun', 'yarn', 'checkout']) {
    r = await update.maybeAutoUpdate({ updateTo: '99.0.0', exec, installInfo: { kind, packageDir: null } });
    assert.equal(r.attempted, false, kind);
    assert.match(r.reason, new RegExp(kind));
  }

  assert.equal(calls.length, 0, 'no guard may reach npm');
});

const IS_WIN = process.platform === 'win32';

test('maybeAutoUpdate runs a pinned install and records the attempt', { skip: IS_WIN }, async () => {
  const calls = [];
  const r = await update.maybeAutoUpdate({
    updateTo: '99.0.0',
    exec: (args) => calls.push(args),
    installInfo: fakeNpmGlobal(),
  });
  assert.deepEqual(r, { attempted: true, ok: true, reason: `updated ${PKG_VERSION} → 99.0.0` });
  assert.deepEqual(calls, [['install', '-g', 'attribut@99.0.0']]);
  assert.equal(readState().auto_update.target, '99.0.0');
  assert.equal(fs.existsSync(path.join(tmpDir, 'update.lock')), false, 'lock released');
});

test('maybeAutoUpdate converges DOWN too (server rollback pin)', { skip: IS_WIN }, async () => {
  const calls = [];
  const r = await update.maybeAutoUpdate({
    updateTo: '0.0.1',
    exec: (args) => calls.push(args),
    installInfo: fakeNpmGlobal(),
  });
  assert.equal(r.attempted, true);
  assert.deepEqual(calls, [['install', '-g', 'attribut@0.0.1']]);
});

test('maybeAutoUpdate backs off a recently attempted target but not a new one', { skip: IS_WIN }, async () => {
  const info = fakeNpmGlobal();
  const calls = [];
  const exec = (args) => calls.push(args);

  await update.maybeAutoUpdate({ updateTo: '99.0.0', exec, installInfo: info });
  const r2 = await update.maybeAutoUpdate({ updateTo: '99.0.0', exec, installInfo: info });
  assert.equal(r2.attempted, false);
  assert.match(r2.reason, /backoff/);

  const r3 = await update.maybeAutoUpdate({ updateTo: '99.0.1', exec, installInfo: info });
  assert.equal(r3.attempted, true, 'a different pin is not backed off');
  assert.equal(calls.length, 2);

  // A stale attempt (>4h) retries.
  writeState({ auto_update: { target: '99.0.1', attempted_at: new Date(Date.now() - 5 * 3600e3).toISOString() } });
  const r4 = await update.maybeAutoUpdate({ updateTo: '99.0.1', exec, installInfo: info });
  assert.equal(r4.attempted, true);
});

test('maybeAutoUpdate reports npm failure without throwing and keeps backoff', { skip: IS_WIN }, async () => {
  const boom = () => {
    throw new Error('EACCES');
  };
  const r = await update.maybeAutoUpdate({ updateTo: '99.0.0', exec: boom, installInfo: fakeNpmGlobal() });
  assert.deepEqual([r.attempted, r.ok], [true, false]);
  assert.match(r.reason, /EACCES/);
  assert.equal(readState().auto_update.target, '99.0.0', 'failed attempt still counts toward backoff');
  assert.equal(fs.existsSync(path.join(tmpDir, 'update.lock')), false, 'lock released on failure');
});

test('maybeAutoUpdate respects a fresh lock and steals a stale one', { skip: IS_WIN }, async () => {
  const info = fakeNpmGlobal();
  const lock = path.join(tmpDir, 'update.lock');
  fs.mkdirSync(lock);

  const r = await update.maybeAutoUpdate({ updateTo: '99.0.0', exec: () => {}, installInfo: info });
  assert.equal(r.attempted, false);
  assert.match(r.reason, /another update/);

  const old = new Date(Date.now() - 11 * 60e3);
  fs.utimesSync(lock, old, old);
  const r2 = await update.maybeAutoUpdate({ updateTo: '99.0.0', exec: () => {}, installInfo: info });
  assert.equal(r2.attempted, true, 'stale lock is stolen');
});

// ---- heartbeat update directive -------------------------------------------

test('handleUpdateDirective triggers auto-update only on a well-formed body', async () => {
  const seen = [];
  const autoUpdate = async ({ updateTo }) => {
    seen.push(updateTo);
    return { attempted: false, reason: 'test' };
  };
  await heartbeat.handleUpdateDirective('{"update_to":"1.2.3"}', { autoUpdate });
  await heartbeat.handleUpdateDirective('', { autoUpdate }); // empty body (old server)
  await heartbeat.handleUpdateDirective('not json', { autoUpdate });
  await heartbeat.handleUpdateDirective('{"ok":true}', { autoUpdate });
  await heartbeat.handleUpdateDirective('{"update_to":""}', { autoUpdate });
  await heartbeat.handleUpdateDirective('{"update_to":42}', { autoUpdate });
  await heartbeat.handleUpdateDirective('[1,2]', { autoUpdate });
  assert.deepEqual(seen, ['1.2.3']);
});

test('handleUpdateDirective never throws, even when the updater does', async () => {
  const boom = async () => {
    throw new Error('exploded');
  };
  const r = await heartbeat.handleUpdateDirective('{"update_to":"1.2.3"}', { autoUpdate: boom });
  assert.equal(r, null);
});

// ---- interactive nudge ----------------------------------------------------

test('maybeNotifyUpdate notifies on TTY when the registry is ahead, and caches', async () => {
  let fetches = 0;
  const fetchLatest = async () => {
    fetches += 1;
    return '99.0.0';
  };
  const msg = await update.maybeNotifyUpdate({ isTTY: true, fetchLatest });
  assert.match(msg, /update available/);
  assert.match(msg, /99\.0\.0/);

  // Second call inside the TTL: cached, no second fetch, same verdict.
  const msg2 = await update.maybeNotifyUpdate({ isTTY: true, fetchLatest });
  assert.match(msg2, /99\.0\.0/);
  assert.equal(fetches, 1);
});

test('maybeNotifyUpdate stays silent when current, non-TTY, CI, opted out, or failing', async () => {
  const ahead = async () => '99.0.0';
  assert.equal(await update.maybeNotifyUpdate({ isTTY: false, fetchLatest: ahead }), null);

  process.env.CI = 'true';
  assert.equal(await update.maybeNotifyUpdate({ isTTY: true, fetchLatest: ahead }), null);
  delete process.env.CI;

  process.env.NO_UPDATE_NOTIFIER = '1';
  assert.equal(await update.maybeNotifyUpdate({ isTTY: true, fetchLatest: ahead }), null);
  delete process.env.NO_UPDATE_NOTIFIER;

  const current = async () => PKG_VERSION;
  assert.equal(await update.maybeNotifyUpdate({ isTTY: true, fetchLatest: current }), null);

  const boom = async () => {
    throw new Error('registry down');
  };
  assert.equal(await update.maybeNotifyUpdate({ isTTY: true, fetchLatest: boom }), null);
});

// ---- runUpdate ------------------------------------------------------------

test('runUpdate --auto=off/on writes and removes the opt-out marker', async () => {
  assert.equal(await update.runUpdate(['--auto=off']), 0);
  assert.equal(fs.existsSync(update.autoUpdateOptOutPath()), true);
  assert.equal(await update.runUpdate(['--auto=on']), 0);
  assert.equal(fs.existsSync(update.autoUpdateOptOutPath()), false);
  assert.equal(await update.runUpdate(['--auto=sideways']), 2);
});

test('runUpdate refuses a source checkout and redirects pnpm/bun/yarn installs', async () => {
  const exec = () => {
    throw new Error('must not run npm');
  };
  assert.equal(
    await update.runUpdate([], { exec, installInfo: { kind: 'checkout', packageDir: null } }),
    2
  );
  for (const kind of ['pnpm', 'bun', 'yarn']) {
    assert.equal(await update.runUpdate([], { exec, installInfo: { kind, packageDir: null } }), 1, kind);
  }
});

test('runUpdate rejects a malformed --to', async () => {
  assert.equal(await update.runUpdate(['--to=latest']), 2);
});

// ---- install --rebake ------------------------------------------------------

test('install --rebake re-points stale npx-baked hooks at the current collector', () => {
  const settingsPath = process.env.CLAUDE_SETTINGS_PATH;
  tokenStore.writeToken('tok-rebake');

  const stale = '/Users/x/.npm/_npx/2e275b8c4d2849be/node_modules/attribut/src/collector.cjs';
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: `INGEST_BASE='https://custom.attribut.ai' node '${stale}' stop` }] },
          { hooks: [{ type: 'command', command: 'echo user-hook-untouched' }] },
        ],
      },
    })
  );

  assert.equal(installer.runInstall(['--rebake']), 0);

  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const commands = after.hooks.Stop.flatMap((e) => e.hooks.map((h) => h.command));
  assert.equal(commands.some((c) => c.includes(stale)), false, 'stale path replaced');
  assert.equal(commands.some((c) => c.includes(installer.collectorPath())), true, 'current path baked');
  assert.equal(commands.some((c) => c === 'echo user-hook-untouched'), true, 'unrelated hook preserved');
  const ours = commands.find((c) => c.includes(installer.collectorPath()));
  assert.match(ours, /INGEST_BASE='https:\/\/custom\.attribut\.ai'/, 'custom endpoint preserved');
});

test('install --rebake without a token fails loud; with no hooks is a no-op', () => {
  assert.equal(installer.runInstall(['--rebake']), 1, 'no token → exit 1');

  tokenStore.writeToken('tok-rebake');
  assert.equal(installer.runInstall(['--rebake']), 0, 'no hooks anywhere → still exit 0');
});
