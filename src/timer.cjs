'use strict';

// timer.cjs — the hourly heartbeat OS timer.
//
// `attribut connect` installs this once, after the capture hooks are already
// wired up, so the server can tell "connector went quiet because the agent
// stopped firing hooks" apart from "connector went quiet because the device
// is gone" — see heartbeat.cjs for the payload this timer fires.
//
// One mechanism per OS, each idempotent (re-running install overwrites the
// same named unit/task in place, never stacking duplicates):
//   macOS   — a launchd user LaunchAgent
//             (~/Library/LaunchAgents/ai.attribut.heartbeat.plist)
//   Linux   — a systemd --user service+timer
//             (~/.config/systemd/user/attribut-heartbeat.{service,timer})
//   Windows — a Task Scheduler task via `schtasks /create ... /sc hourly`
//
// FAILURE POLICY: best-effort. Unlike registerAgent's hook install (the part
// of `connect` that must fail loud — it's the actual token pairing), a
// sandbox/container/WSL box without a working scheduler backend must not fail
// `attribut connect` outright: the hooks are already live and doing the
// important work. Timer failures are logged to stderr and swallowed.
//
// `ATTRIBUT_SKIP_TIMER_ACTIVATION=1` writes the unit/task file(s) but skips
// the OS activation call (launchctl/systemctl/schtasks) — used by tests so
// they never touch the real scheduler on the dev machine or CI runner.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const installer = require('./install.cjs');

const LAUNCHD_LABEL = 'ai.attribut.heartbeat';
const SYSTEMD_UNIT = 'attribut-heartbeat';
const SCHTASKS_NAME = 'ATTRIBUT Heartbeat';

function out(msg) {
  process.stdout.write(`${msg}\n`);
}
function err(msg) {
  process.stderr.write(`[attribut] ${msg}\n`);
}

function skipActivation() {
  return process.env.ATTRIBUT_SKIP_TIMER_ACTIVATION === '1';
}

/** POSIX single-quote (mirrors install.cjs's shquote — small enough to not
 * warrant a cross-module dependency). */
function shquote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// npx (and pnpm/yarn dlx) resolve a package into an ephemeral, hash-named
// cache directory that is not guaranteed to exist — or hold this version — on
// the NEXT run. An absolute path into one baked into a persistent timer would
// silently go stale, so detect that case and fall back to re-resolving via
// npx on every fire instead.
function isEphemeralInstall(collectorPath) {
  return /[\\/](_npx|dlx-\d)[\\/]/.test(collectorPath);
}

/**
 * Resolve the argv (no shell) that invokes `attribut heartbeat`. Prefers an
 * absolute `<node> <installed collector.cjs> heartbeat` — the same pattern
 * install.cjs uses for hook commands, durable across the sparse PATH a
 * launchd/systemd/schtasks environment hands a job. Falls back to `npx -y
 * attribut@latest heartbeat` only when the running install is itself an
 * ephemeral npx cache (see isEphemeralInstall).
 *
 * Defaults to hookCollectorPath(), NOT collectorPath(): under `npx attribut
 * connect` the hooks have already been healed onto a durable install and the
 * timer must bake that same path. The raw path would leave the hourly job
 * re-resolving `attribut@latest` from the registry forever — drifting to a
 * different version than the hooks run, and needing npx on the sparse PATH
 * systemd hands a user unit. Memoized in update.cjs, so no second npm install.
 */
function resolveHeartbeatArgv(collectorPath = installer.hookCollectorPath()) {
  if (!isEphemeralInstall(collectorPath)) {
    return [process.execPath, collectorPath, 'heartbeat'];
  }
  return ['npx', '-y', 'attribut@latest', 'heartbeat'];
}

// ---- macOS: launchd ---------------------------------------------------

function launchdDir() {
  return process.env.ATTRIBUT_LAUNCHD_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function launchdPlistPath() {
  return path.join(launchdDir(), `${LAUNCHD_LABEL}.plist`);
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Pure: the launchd plist XML that runs `argv` hourly (StartInterval 3600),
 * also once at load (RunAtLoad). */
function buildLaunchdPlist(argv) {
  const args = argv.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

function installLaunchd(argv) {
  const plistPath = launchdPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, buildLaunchdPlist(argv), { encoding: 'utf8', mode: 0o644 });
  if (skipActivation()) return { path: plistPath, activated: false };
  const uid = process.getuid ? process.getuid() : null;
  try {
    // Unload any previous copy first — bootstrap fails if already loaded.
    // Best-effort: not being loaded yet is the common case, not an error.
    try {
      execFileSync('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
    } catch {
      /* wasn't loaded — fine */
    }
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'ignore' });
    return { path: plistPath, activated: true };
  } catch (e) {
    err(
      `could not activate the launchd agent (file written at ${plistPath}; it will still ` +
        `load at next login): ${e.message}`
    );
    return { path: plistPath, activated: false };
  }
}

function removeLaunchd() {
  const plistPath = launchdPlistPath();
  const existed = fs.existsSync(plistPath);
  if (existed && !skipActivation()) {
    const uid = process.getuid ? process.getuid() : null;
    try {
      execFileSync('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
    } catch {
      /* not loaded — fine */
    }
  }
  if (existed) fs.unlinkSync(plistPath);
  return existed;
}

// ---- Linux: systemd --user ---------------------------------------------

function systemdUserDir() {
  return process.env.ATTRIBUT_SYSTEMD_USER_DIR || path.join(os.homedir(), '.config', 'systemd', 'user');
}

function systemdServicePath() {
  return path.join(systemdUserDir(), `${SYSTEMD_UNIT}.service`);
}
function systemdTimerPath() {
  return path.join(systemdUserDir(), `${SYSTEMD_UNIT}.timer`);
}

/** Pure: the oneshot .service unit that runs `argv`. */
function buildSystemdService(argv) {
  const execStart = argv.map(shquote).join(' ');
  return `[Unit]
Description=ATTRIBUT heartbeat (connector liveness signal)

[Service]
Type=oneshot
ExecStart=${execStart}
`;
}

/** Pure: the .timer unit — hourly, persistent (catches up a missed fire from
 * the machine being asleep/off, same intent as launchd's RunAtLoad). */
function buildSystemdTimer() {
  return `[Unit]
Description=Run the ATTRIBUT heartbeat hourly

[Timer]
OnUnitActiveSec=1h
OnBootSec=5m
Persistent=true
Unit=${SYSTEMD_UNIT}.service

[Install]
WantedBy=timers.target
`;
}

function installSystemd(argv) {
  const dir = systemdUserDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(systemdServicePath(), buildSystemdService(argv), 'utf8');
  fs.writeFileSync(systemdTimerPath(), buildSystemdTimer(), 'utf8');
  if (skipActivation()) {
    return { servicePath: systemdServicePath(), timerPath: systemdTimerPath(), activated: false };
  }
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'enable', '--now', `${SYSTEMD_UNIT}.timer`], { stdio: 'ignore' });
    return { servicePath: systemdServicePath(), timerPath: systemdTimerPath(), activated: true };
  } catch (e) {
    err(
      `could not activate the systemd timer (unit files written under ${dir}; enable manually ` +
        `with 'systemctl --user enable --now ${SYSTEMD_UNIT}.timer' once a user session/DBus is ` +
        `available): ${e.message}`
    );
    return { servicePath: systemdServicePath(), timerPath: systemdTimerPath(), activated: false };
  }
}

function removeSystemd() {
  const svc = systemdServicePath();
  const tmr = systemdTimerPath();
  const existed = fs.existsSync(svc) || fs.existsSync(tmr);
  if (existed && !skipActivation()) {
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', `${SYSTEMD_UNIT}.timer`], { stdio: 'ignore' });
    } catch {
      /* not enabled — fine */
    }
  }
  for (const p of [svc, tmr]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* absent — fine */
    }
  }
  if (existed && !skipActivation()) {
    try {
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    } catch {
      /* fine */
    }
  }
  return existed;
}

// ---- Windows: Task Scheduler --------------------------------------------

/** Pure: the `schtasks /create` argv for `argv` (the task's own command line —
 * schtasks wants ONE string, so it is double-quoted per Windows conventions). */
function buildSchtasksCreateArgs(argv) {
  const tr = argv.map((a) => `"${String(a).replace(/"/g, '""')}"`).join(' ');
  return ['/create', '/f', '/sc', 'hourly', '/tn', SCHTASKS_NAME, '/tr', tr];
}

function installSchtasks(argv) {
  if (skipActivation()) return { activated: false };
  try {
    execFileSync('schtasks', buildSchtasksCreateArgs(argv), { stdio: 'ignore' });
    return { activated: true };
  } catch (e) {
    err(`could not register the Task Scheduler heartbeat task: ${e.message}`);
    return { activated: false };
  }
}

function removeSchtasks() {
  if (skipActivation()) return false;
  try {
    execFileSync('schtasks', ['/delete', '/f', '/tn', SCHTASKS_NAME], { stdio: 'ignore' });
    return true;
  } catch {
    return false; // not registered — fine
  }
}

// ---- dispatch ------------------------------------------------------------

/**
 * Install the hourly heartbeat timer for the current OS. Idempotent — safe to
 * call on every `connect` (re-running overwrites the same named unit/task in
 * place). Never throws: activation failures are logged and swallowed, since
 * the hooks (the important part of `connect`) are already live regardless.
 */
function installTimer(platform = process.platform) {
  try {
    const argv = resolveHeartbeatArgv();
    if (platform === 'darwin') installLaunchd(argv);
    else if (platform === 'win32') installSchtasks(argv);
    else installSystemd(argv);
    out('✓ Installed hourly heartbeat timer (lets ATTRIBUT detect a stalled connector even between sessions).');
  } catch (e) {
    err(`could not install the heartbeat timer: ${e.message}`);
  }
}

/** Remove the heartbeat timer for the current OS, if present. Never throws. */
function removeTimer(platform = process.platform) {
  try {
    if (platform === 'darwin') return removeLaunchd();
    if (platform === 'win32') return removeSchtasks();
    return removeSystemd();
  } catch (e) {
    err(`could not remove the heartbeat timer: ${e.message}`);
    return false;
  }
}

module.exports = {
  resolveHeartbeatArgv,
  isEphemeralInstall,
  buildLaunchdPlist,
  buildSystemdService,
  buildSystemdTimer,
  buildSchtasksCreateArgs,
  launchdPlistPath,
  systemdServicePath,
  systemdTimerPath,
  installLaunchd,
  removeLaunchd,
  installSystemd,
  removeSystemd,
  installSchtasks,
  removeSchtasks,
  installTimer,
  removeTimer,
};
