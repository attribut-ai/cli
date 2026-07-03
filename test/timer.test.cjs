'use strict';

// HEARTBEAT TIMER TEST — argv/command resolution and the pure unit-file
// builders for all three OS mechanisms, plus a file-lifecycle check with the
// real scheduler activation skipped (ATTRIBUT_SKIP_TIMER_ACTIVATION=1) so the
// suite never touches launchd/systemd/schtasks on the dev machine or CI.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const timer = require('../src/timer.cjs');

let tmpDir;
let prevLaunchdDir;
let prevSystemdDir;
let prevSkip;

beforeEach(() => {
  prevLaunchdDir = process.env.ATTRIBUT_LAUNCHD_DIR;
  prevSystemdDir = process.env.ATTRIBUT_SYSTEMD_USER_DIR;
  prevSkip = process.env.ATTRIBUT_SKIP_TIMER_ACTIVATION;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-timer-'));
  process.env.ATTRIBUT_LAUNCHD_DIR = path.join(tmpDir, 'LaunchAgents');
  process.env.ATTRIBUT_SYSTEMD_USER_DIR = path.join(tmpDir, 'systemd-user');
  process.env.ATTRIBUT_SKIP_TIMER_ACTIVATION = '1';
});

afterEach(() => {
  const restore = (env, prev) => {
    if (prev === undefined) delete process.env[env];
    else process.env[env] = prev;
  };
  restore('ATTRIBUT_LAUNCHD_DIR', prevLaunchdDir);
  restore('ATTRIBUT_SYSTEMD_USER_DIR', prevSystemdDir);
  restore('ATTRIBUT_SKIP_TIMER_ACTIVATION', prevSkip);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('resolveHeartbeatArgv for a durable install runs node + absolute collector path', () => {
  const argv = timer.resolveHeartbeatArgv('/usr/local/lib/node_modules/attribut/src/collector.cjs');
  assert.deepEqual(argv, [process.execPath, '/usr/local/lib/node_modules/attribut/src/collector.cjs', 'heartbeat']);
});

test('resolveHeartbeatArgv for an ephemeral npx cache falls back to `npx -y attribut@latest heartbeat`', () => {
  const npxPath = path.join(os.homedir(), '.npm', '_npx', 'abc123', 'node_modules', 'attribut', 'src', 'collector.cjs');
  const argv = timer.resolveHeartbeatArgv(npxPath);
  assert.deepEqual(argv, ['npx', '-y', 'attribut@latest', 'heartbeat']);
});

test('isEphemeralInstall recognizes an npx cache path but not a normal global install', () => {
  assert.equal(
    timer.isEphemeralInstall('/home/u/.npm/_npx/deadbeef/node_modules/attribut/src/collector.cjs'),
    true
  );
  assert.equal(timer.isEphemeralInstall('/usr/local/lib/node_modules/attribut/src/collector.cjs'), false);
  assert.equal(timer.isEphemeralInstall('/home/u/.nvm/versions/node/v22/bin/attribut'), false);
});

test('buildLaunchdPlist embeds the label, hourly interval, RunAtLoad, and every argv entry', () => {
  const xml = timer.buildLaunchdPlist([process.execPath, '/abs/collector.cjs', 'heartbeat']);
  assert.ok(xml.includes('<string>ai.attribut.heartbeat</string>'));
  assert.ok(xml.includes('<integer>3600</integer>'));
  assert.ok(xml.includes('<true/>')); // RunAtLoad
  assert.ok(xml.includes(`<string>${process.execPath}</string>`));
  assert.ok(xml.includes('<string>/abs/collector.cjs</string>'));
  assert.ok(xml.includes('<string>heartbeat</string>'));
});

test('buildLaunchdPlist XML-escapes argv entries', () => {
  const xml = timer.buildLaunchdPlist(['echo', 'a & b < c']);
  assert.ok(xml.includes('a &amp; b &lt; c'));
  assert.ok(!xml.includes('a & b < c'));
});

test('buildSystemdService quotes ExecStart and buildSystemdTimer is hourly + persistent', () => {
  const svc = timer.buildSystemdService([process.execPath, '/abs/collector.cjs', 'heartbeat']);
  assert.ok(svc.includes('Type=oneshot'));
  assert.ok(svc.includes(`ExecStart='${process.execPath}' '/abs/collector.cjs' 'heartbeat'`));

  const tmr = timer.buildSystemdTimer();
  assert.ok(tmr.includes('OnUnitActiveSec=1h'));
  assert.ok(tmr.includes('Persistent=true'));
  assert.ok(tmr.includes('Unit=attribut-heartbeat.service'));
});

test('buildSchtasksCreateArgs registers hourly and quotes the command line', () => {
  const args = timer.buildSchtasksCreateArgs(['C:\\node.exe', 'C:\\collector.cjs', 'heartbeat']);
  assert.ok(args.includes('/sc'));
  assert.ok(args.includes('hourly'));
  assert.ok(args.includes('/tn'));
  assert.ok(args.includes('ATTRIBUT Heartbeat'));
  const tr = args[args.indexOf('/tr') + 1];
  assert.equal(tr, '"C:\\node.exe" "C:\\collector.cjs" "heartbeat"');
});

test('installLaunchd writes the plist file to the overridden dir (activation skipped)', () => {
  const argv = [process.execPath, '/abs/collector.cjs', 'heartbeat'];
  const result = timer.installLaunchd(argv);
  assert.equal(result.activated, false);
  assert.equal(result.path, timer.launchdPlistPath());
  assert.ok(fs.existsSync(timer.launchdPlistPath()));
  assert.ok(fs.readFileSync(timer.launchdPlistPath(), 'utf8').includes('ai.attribut.heartbeat'));
});

test('installLaunchd then removeLaunchd is idempotent and cleans up', () => {
  const argv = [process.execPath, '/abs/collector.cjs', 'heartbeat'];
  timer.installLaunchd(argv);
  timer.installLaunchd(argv); // re-run must not throw or duplicate anything
  assert.ok(fs.existsSync(timer.launchdPlistPath()));
  const removed = timer.removeLaunchd();
  assert.equal(removed, true);
  assert.ok(!fs.existsSync(timer.launchdPlistPath()));
  assert.equal(timer.removeLaunchd(), false); // second removal is a no-op
});

test('installSystemd writes both unit files to the overridden dir (activation skipped)', () => {
  const argv = [process.execPath, '/abs/collector.cjs', 'heartbeat'];
  const result = timer.installSystemd(argv);
  assert.equal(result.activated, false);
  assert.ok(fs.existsSync(timer.systemdServicePath()));
  assert.ok(fs.existsSync(timer.systemdTimerPath()));
});

test('installSystemd then removeSystemd is idempotent and cleans up both files', () => {
  const argv = [process.execPath, '/abs/collector.cjs', 'heartbeat'];
  timer.installSystemd(argv);
  timer.installSystemd(argv); // re-run must not throw
  const removed = timer.removeSystemd();
  assert.equal(removed, true);
  assert.ok(!fs.existsSync(timer.systemdServicePath()));
  assert.ok(!fs.existsSync(timer.systemdTimerPath()));
  assert.equal(timer.removeSystemd(), false);
});

test('installTimer/removeTimer dispatch by platform and never throw with activation skipped', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.doesNotThrow(() => timer.installTimer(platform));
    assert.doesNotThrow(() => timer.removeTimer(platform));
  }
});
