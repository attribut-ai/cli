'use strict';

// `attribut update` + the self-update machinery.
//
// Three consumers:
//   1. `attribut update`      — explicit, FAIL-LOUD update to the latest (or
//                               --to=<version>) release, healing npx-ephemeral
//                               installs by re-baking hooks onto a durable path.
//   2. heartbeat auto-update  — the hourly timer's heartbeat response may carry
//                               an `update_to` version pinned by the server
//                               (rollout/rollback lever lives server-side, never
//                               a blind `@latest` pull). Guardrail-heavy and
//                               FAIL-SOFT: a background job must never spam or
//                               hang; a device that couldn't update is visible
//                               server-side as a stale cli_version.
//   3. interactive nudge      — connect/audit/backfill print a one-line stderr
//                               notice when the npm registry has a newer version
//                               (24h-cached, TTY-only, silent on any failure).
//
// AUTO-UPDATE POLICY: only when the running install is an unambiguous npm
// global install with a writable package dir. pnpm/bun/yarn/npx/source-checkout
// installs are never touched in the background (cross-manager `npm i -g` can
// duplicate or corrupt an install) — those get the interactive `attribut
// update`, which either runs the right manager's command or says what to run.
// Opt-outs: ATTRIBUT_NO_AUTO_UPDATE=1 (env) or `attribut update --auto=off`
// (marker file, survives launchd/systemd's sparse env).
//
// NPM PREFIX: a distro-packaged Node (apt/nodesource on Linux) puts the global
// root at a root-owned /usr/local/lib/node_modules, so `npm i -g` is EACCES for
// a normal user — the default path for anyone running `npx attribut connect` on
// a fresh box. Every install here therefore falls back to a user-owned prefix
// (~/.attribut/npm) rather than giving up, and detectInstall reports that prefix
// so later updates keep landing in the same root. Hooks and the heartbeat timer
// bake absolute paths, so capture works whether or not that bin dir is on PATH.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const { configDir } = require('./device.cjs');
const { readState, writeState } = require('./state.cjs');
const { version: PKG_VERSION } = require('../package.json');

const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/attribut/latest';
const NOTIFY_TTL_MS = 24 * 60 * 60 * 1000; // re-check the registry once a day
const AUTO_RETRY_MS = 4 * 60 * 60 * 1000; // one attempt per target per 4h
const LOCK_STALE_MS = 10 * 60 * 1000; // a lock older than this is a dead process

function out(msg) {
  process.stdout.write(`${msg}\n`);
}
function log(msg) {
  process.stderr.write(`[attribut] ${msg}\n`);
}

// ---- semver (hand-rolled: x.y.z with optional prerelease) ---------------

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Parse `x.y.z[-pre]` → { major, minor, patch, pre } or null. */
function parseSemver(v) {
  const m = SEMVER_RE.exec(typeof v === 'string' ? v.trim() : '');
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}

/**
 * Compare two version strings. Returns -1 / 0 / 1, or null when either side
 * is unparseable (callers treat null as "don't act"). A prerelease sorts
 * below its release (1.2.0-rc.1 < 1.2.0); two prereleases compare lexically —
 * exact enough for a CLI that only ever publishes plain x.y.z.
 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

// ---- install-shape detection ---------------------------------------------

/** Same shapes timer.cjs dodges: npx / pnpm+yarn dlx ephemeral caches. */
function isEphemeralInstall(p) {
  return /[\\/](_npx|dlx-\d)[\\/]/.test(p);
}

/**
 * Classify where this code is running from, by collector path. Returns
 * { kind, packageDir, prefix } where kind ∈ npm-global | pnpm | bun | yarn |
 * npx | checkout, packageDir is the `.../node_modules/attribut` root when the
 * path has one (null for a source checkout), and prefix is our user-owned npm
 * prefix when this install lives there (null otherwise) — every later
 * `npm i -g` must carry the same `--prefix` or it lands in the wrong root.
 */
function detectInstall(collectorPath = defaultCollectorPath()) {
  const p = String(collectorPath);
  const marker = `${path.sep}node_modules${path.sep}attribut${path.sep}`;
  const i = p.lastIndexOf(marker);
  const packageDir = i === -1 ? null : p.slice(0, i + marker.length - 1);
  let kind;
  if (isEphemeralInstall(p)) kind = 'npx';
  else if (/[\\/]\.bun[\\/]/.test(p)) kind = 'bun';
  else if (/[\\/]pnpm[\\/]/.test(p) || /[\\/]\.pnpm[\\/]/.test(p)) kind = 'pnpm';
  else if (/[\\/]\.yarn[\\/]/.test(p) || /[\\/]yarn[\\/]global[\\/]/.test(p)) kind = 'yarn';
  else if (packageDir) kind = 'npm-global';
  else kind = 'checkout';
  const fallback = fallbackPrefixDir();
  const rel = packageDir ? path.relative(fallback, packageDir) : null;
  const prefix = rel !== null && !rel.startsWith('..') && !path.isAbsolute(rel) ? fallback : null;
  return { kind, packageDir, prefix };
}

function defaultCollectorPath() {
  return path.resolve(__dirname, 'collector.cjs');
}

// ---- npm plumbing ---------------------------------------------------------

/**
 * The npm executable to run. Prefer the one sitting next to the running node
 * (correct under nvm/asdf and the sparse PATH launchd/systemd hand a timer
 * job); fall back to PATH lookup.
 */
function npmBin() {
  const name = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const sibling = path.join(path.dirname(process.execPath), name);
  return fs.existsSync(sibling) ? sibling : name;
}

/** Default runner for `npm <args>`; swapped out by tests and callers. */
function execNpm(args, { stdio = 'pipe', timeoutMs = 120000 } = {}) {
  return execFileSync(npmBin(), args, {
    stdio,
    timeout: timeoutMs,
    encoding: 'utf8',
    // .cmd files need a shell on win32 (Node ≥18 refuses them otherwise).
    shell: process.platform === 'win32',
  });
}

/**
 * The npm prefix we fall back to when the system-wide one is root-owned — the
 * default on a distro-packaged Node (Ubuntu: /usr/local/lib/node_modules), where
 * a plain `npm i -g` dies with EACCES for a normal user. Self-contained under
 * the config dir so `attribut uninstall` semantics stay "delete ~/.attribut".
 */
function fallbackPrefixDir() {
  return path.join(configDir(), 'npm');
}

/**
 * Where a global install of `attribut` lands. With a known prefix the layout is
 * fixed, so compute it rather than shelling out — npm ≥10 REDACTS token-shaped
 * substrings (UUIDs included) from its own output, so `npm root -g --prefix p`
 * can hand back a path containing `***` for a perfectly valid p.
 */
function globalCollectorPath(exec = execNpm, prefix = null) {
  const root = prefix
    ? path.join(prefix, ...(process.platform === 'win32' ? ['node_modules'] : ['lib', 'node_modules']))
    : String(exec(['root', '-g'])).trim();
  return path.join(root, 'attribut', 'src', 'collector.cjs');
}

/**
 * Can this process create/replace `dir`? npm creates missing levels, so walk up
 * to the nearest existing ancestor and test that. Any surprise → false (assume
 * not writable and take the fallback, which is always safe).
 */
function isWritableTarget(dir) {
  let p = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(p)) {
      try {
        fs.accessSync(p, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    const parent = path.dirname(p);
    if (parent === p) return false;
    p = parent;
  }
}

function isPermissionError(e) {
  const text = `${(e && e.stderr) || ''}\n${(e && e.message) || ''}`;
  return /EACCES|EPERM|EROFS|permission denied/i.test(text);
}

/** npm's failure wall is ~35 lines; keep the signal, drop the boilerplate. */
function npmFailureReason(e) {
  const text = `${(e && e.stderr) || ''}`;
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^npm (?:ERR!|error)\s?/, '').trim())
    .filter((l) => l && !/^A complete log|^$/.test(l));
  const code = lines.find((l) => /^code /.test(l));
  const detail = lines.find((l) => /Error:|permission denied|ENOENT|EACCES|EPERM/i.test(l));
  const picked = [code, detail].filter(Boolean).join(' — ');
  return picked || (e && e.message ? String(e.message).split('\n')[0] : 'unknown npm failure');
}

/**
 * Install `attribut@<version>` somewhere durable and return
 * { collector, prefix } — prefix is null for a true global install, otherwise
 * the user-owned prefix we fell back to.
 *
 * Order: an explicit `prefix` wins; otherwise try the system global root, but
 * only when it's actually writable (probing first keeps npm's EACCES wall out
 * of the connect UI in the common Linux case). A permission failure on the
 * global attempt still falls back — the probe can be wrong under weird mounts.
 * Throws with a one-line reason when nothing worked.
 */
function installDurably(version, exec = execNpm, { prefix = null } = {}) {
  const spec = `attribut@${version}`;
  const run = (p) => {
    const args = ['install', '-g'];
    if (p) args.push('--prefix', p);
    args.push(spec);
    exec(args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const collector = globalCollectorPath(exec, p);
    if (!fs.existsSync(collector)) throw new Error(`expected collector missing at ${collector}`);
    return { collector, prefix: p };
  };

  if (prefix) return run(prefix);

  let globalRootWritable = false;
  try {
    globalRootWritable = isWritableTarget(String(exec(['root', '-g'])).trim());
  } catch {
    // Couldn't ask npm where global lives — try it anyway and let the error talk.
    globalRootWritable = true;
  }

  if (globalRootWritable) {
    try {
      return run(null);
    } catch (e) {
      if (!isPermissionError(e)) throw new Error(npmFailureReason(e));
    }
  }
  try {
    return run(fallbackPrefixDir());
  } catch (e) {
    throw new Error(npmFailureReason(e));
  }
}

// ---- registry check -------------------------------------------------------

/**
 * GET the registry's `latest` dist-tag version. Rejects on any failure or
 * timeout; every caller treats a rejection as "skip quietly" or fails loud
 * itself. `url` is overridable for tests (http allowed only for localhost
 * testing, mirroring the collector's ATTRIBUT_ALLOW_INSECURE hatch).
 */
function fetchLatestVersion({ url = REGISTRY_LATEST_URL, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`not a valid URL: ${url}`));
    }
    if (u.protocol !== 'https:' && process.env.ATTRIBUT_ALLOW_INSECURE !== '1') {
      return reject(new Error(`refusing non-https registry URL ${u.href}`));
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`registry returned HTTP ${res.statusCode}`));
        }
        try {
          const version = JSON.parse(data).version;
          if (!parseSemver(version)) throw new Error(`unparseable version: ${version}`);
          resolve(version);
        } catch (e) {
          reject(new Error(`bad registry response: ${e.message}`));
        }
      });
    });
    req.on('error', (e) => reject(new Error(`registry check failed: ${e.message}`)));
    req.on('timeout', () => req.destroy(new Error(`registry check timed out after ${timeoutMs}ms`)));
  });
}

// ---- interactive nudge ----------------------------------------------------

/** Marker file for `attribut update --auto=off`. */
function autoUpdateOptOutPath() {
  return path.join(configDir(), 'auto-update.off');
}

/**
 * One-line stderr notice when a newer release exists. Silent no-op unless
 * stderr is a TTY and we're not in CI (a stray banner inside a hook or piped
 * output is corruption, not help). Registry hit at most once per NOTIFY_TTL_MS,
 * cached in state.json. NEVER throws and never fails the caller — this is
 * decoration on management commands, not part of their job.
 * Returns the printed message (or null) so tests can assert without capture.
 */
async function maybeNotifyUpdate({
  now = new Date(),
  fetchLatest = fetchLatestVersion,
  isTTY = process.stderr.isTTY,
  currentVersion = PKG_VERSION,
} = {}) {
  try {
    if (!isTTY || process.env.CI) return null;
    if (process.env.NO_UPDATE_NOTIFIER || process.env.ATTRIBUT_NO_UPDATE_NOTIFIER) return null;

    const state = readState();
    const cached = state.update_check || {};
    let latest = typeof cached.latest === 'string' ? cached.latest : null;
    const fresh =
      typeof cached.checked_at === 'string' &&
      now.getTime() - Date.parse(cached.checked_at) < NOTIFY_TTL_MS;

    if (!fresh) {
      latest = await fetchLatest({ timeoutMs: 2500 });
      try {
        state.update_check = { checked_at: now.toISOString(), latest };
        writeState(state);
      } catch {
        /* best-effort cache — a failed write just means we check again */
      }
    }

    if (compareSemver(latest, currentVersion) !== 1) return null;
    const msg = `update available: ${currentVersion} → ${latest} — run \`attribut update\``;
    log(msg);
    return msg;
  } catch {
    return null; // any failure (network, corrupt state) → stay silent
  }
}

// ---- heartbeat auto-update ------------------------------------------------

/**
 * Attempt the server-directed self-update. `updateTo` is the exact version the
 * heartbeat response pinned. Every early return is deliberate — see the policy
 * block at the top of this file. Returns { attempted, ok?, reason } for the
 * caller's single log line; NEVER throws.
 */
async function maybeAutoUpdate({
  updateTo,
  now = new Date(),
  exec = execNpm,
  installInfo = detectInstall(),
  currentVersion = PKG_VERSION,
} = {}) {
  try {
    const cmp = compareSemver(updateTo, currentVersion);
    if (cmp === null) return { attempted: false, reason: `invalid target "${updateTo}"` };
    // Converge on the pinned version in EITHER direction — a server-side
    // downgrade pin is the rollback lever for a bad release.
    if (cmp === 0) return { attempted: false, reason: 'already current' };

    if (process.env.ATTRIBUT_NO_AUTO_UPDATE) return { attempted: false, reason: 'disabled (env)' };
    if (fs.existsSync(autoUpdateOptOutPath())) {
      return { attempted: false, reason: 'disabled (attribut update --auto=off)' };
    }
    if (process.env.CI) return { attempted: false, reason: 'CI' };
    if (process.platform === 'win32') {
      // execFileSync+.cmd needs a shell and schtasks contexts are untested —
      // Windows users update explicitly. Honest skip, not silent.
      return { attempted: false, reason: 'windows — run `attribut update`' };
    }
    if (installInfo.kind !== 'npm-global') {
      return { attempted: false, reason: `install is ${installInfo.kind}, not npm-global — run \`attribut update\`` };
    }
    try {
      fs.accessSync(installInfo.packageDir, fs.constants.W_OK);
    } catch {
      return { attempted: false, reason: `${installInfo.packageDir} not writable` };
    }

    // Backoff: at most one attempt per target per AUTO_RETRY_MS, so a
    // persistently failing install doesn't churn npm every hour.
    const state = readState();
    const prev = state.auto_update || {};
    if (
      prev.target === updateTo &&
      typeof prev.attempted_at === 'string' &&
      now.getTime() - Date.parse(prev.attempted_at) < AUTO_RETRY_MS
    ) {
      return { attempted: false, reason: `backoff (tried ${updateTo} at ${prev.attempted_at})` };
    }

    // Cross-process lock: two timers (or a timer + manual update) must not run
    // npm concurrently. mkdir is atomic; a stale dir is a crashed holder.
    const lockDir = path.join(configDir(), 'update.lock');
    try {
      fs.mkdirSync(lockDir, { recursive: false });
    } catch (e) {
      if (e.code !== 'EEXIST') return { attempted: false, reason: `lock: ${e.message}` };
      let stale = false;
      try {
        stale = now.getTime() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS;
      } catch {
        /* raced away — treat as held */
      }
      if (!stale) return { attempted: false, reason: 'another update is running' };
      try {
        fs.rmdirSync(lockDir);
        fs.mkdirSync(lockDir, { recursive: false });
      } catch {
        return { attempted: false, reason: 'another update is running' };
      }
    }

    // Record the attempt BEFORE running npm — a crash mid-install must count
    // toward backoff, not retry hot every hour.
    try {
      state.auto_update = { target: updateTo, attempted_at: now.toISOString() };
      writeState(state);
    } catch {
      /* state write failure only weakens backoff — still proceed */
    }

    try {
      // Carry the same --prefix the install already lives under, or npm would
      // reinstall into the (unwritable, or simply different) system root.
      const args = ['install', '-g'];
      if (installInfo.prefix) args.push('--prefix', installInfo.prefix);
      args.push(`attribut@${updateTo}`);
      exec(args);
      return { attempted: true, ok: true, reason: `updated ${currentVersion} → ${updateTo}` };
    } catch (e) {
      return { attempted: true, ok: false, reason: `npm install failed: ${e.message}` };
    } finally {
      try {
        fs.rmdirSync(lockDir);
      } catch {
        /* already gone — fine */
      }
    }
  } catch (e) {
    return { attempted: false, reason: `unexpected: ${e && e.message ? e.message : e}` };
  }
}

// ---- durable-install healing (used by `attribut install`) -----------------

/**
 * If the running collector lives in an ephemeral npx/dlx cache, installing
 * hooks against its path would bake a path that npx can prune at any time —
 * the hooks then die silently. Heal by installing this same version durably
 * and returning the durable collector path for hook baking. On ANY failure,
 * warn loudly and return the original path (degraded but working-for-now — the
 * old behavior).
 */
const durableCache = new Map(); // memo: multi-agent connect heals (or fails) once, not per agent
function ensureDurableCollector(collectorPath = defaultCollectorPath(), exec = execNpm) {
  if (!isEphemeralInstall(collectorPath)) return collectorPath;
  if (durableCache.has(collectorPath)) return durableCache.get(collectorPath);
  log('running from an ephemeral npx cache — installing durably so hooks survive cache pruning…');
  try {
    const { collector, prefix } = installDurably(PKG_VERSION, exec);
    if (prefix) {
      // The system npm prefix was root-owned; we installed under ~/.attribut
      // instead. Hooks and the timer use absolute paths so capture works
      // either way — PATH only matters for typing `attribut` yourself.
      log(`the system npm prefix isn't writable — installed under ${prefix} instead.`);
      log(`add ${path.join(prefix, 'bin')} to PATH to run \`attribut\` directly.`);
    }
    log(`installed durably — hooks will use ${collector}`);
    durableCache.set(collectorPath, collector);
    return collector;
  } catch (e) {
    log(`WARNING: could not install durably (${e.message}).`);
    log('WARNING: hooks will reference the npx cache, which npx may prune — they can');
    log('WARNING: stop firing without notice. Re-run `npx attribut connect` to retry,');
    log('WARNING: or install with `sudo npm install -g attribut` and run `attribut update`.');
    durableCache.set(collectorPath, collectorPath);
    return collectorPath;
  }
}

// ---- `attribut update` ----------------------------------------------------

const UPDATE_HELP = `
attribut update — update this CLI to the latest (or a pinned) release

Usage:
  attribut update [--to=<version>]
  attribut update --auto=on|off

  --to=<version>   Install this exact version instead of the registry's latest.
  --auto=on|off    Enable/disable background auto-update (the hourly heartbeat
                   applies server-pinned versions; 'off' writes a marker file
                   under ~/.attribut). Env ATTRIBUT_NO_AUTO_UPDATE=1 also
                   disables it.
  -h, --help       Show this help.

npm global installs are updated in place (hooks already point at the stable
global path). npx-ephemeral installs are healed onto a durable global install
and the hooks re-baked. pnpm/bun/yarn installs print the right command for
that package manager instead — cross-manager updates corrupt installs.
`;

/**
 * `attribut update`. Explicit user action — FAIL LOUD (non-zero) on real
 * errors. Returns an exit code.
 */
async function runUpdate(argv, { exec = execNpm, fetchLatest = fetchLatestVersion, installInfo } = {}) {
  const args = argv || [];
  if (args.includes('-h') || args.includes('--help')) {
    out(UPDATE_HELP.trimStart());
    return 0;
  }

  // --auto=on|off toggles the background auto-update marker and exits.
  const autoArg = args.find((a) => a === '--auto' || a.startsWith('--auto='));
  if (autoArg) {
    const val = autoArg.includes('=') ? autoArg.split('=')[1] : args[args.indexOf(autoArg) + 1];
    if (val !== 'on' && val !== 'off') {
      log(`--auto expects on|off (got: ${val}).`);
      return 2;
    }
    if (val === 'off') {
      fs.mkdirSync(configDir(), { recursive: true });
      fs.writeFileSync(autoUpdateOptOutPath(), 'created by `attribut update --auto=off`\n', {
        mode: 0o600,
      });
      out('Background auto-update disabled. Re-enable with `attribut update --auto=on`.');
    } else {
      try {
        fs.unlinkSync(autoUpdateOptOutPath());
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      out('Background auto-update enabled.');
    }
    return 0;
  }

  const toArg = args.find((a) => a.startsWith('--to='));
  let target = toArg ? toArg.slice('--to='.length) : null;
  if (target && !parseSemver(target)) {
    log(`--to expects an exact version like 1.2.3 (got: ${target}).`);
    return 2;
  }

  const info = installInfo || detectInstall();

  if (info.kind === 'checkout') {
    log('this is a source checkout, not an installed package — update it with git.');
    return 2;
  }
  if (info.kind === 'pnpm' || info.kind === 'bun' || info.kind === 'yarn') {
    const cmd = {
      pnpm: `pnpm add -g attribut@${target || 'latest'}`,
      bun: `bun add -g attribut@${target || 'latest'}`,
      yarn: `yarn global add attribut@${target || 'latest'}`,
    }[info.kind];
    log(`this install is managed by ${info.kind} — updating it with npm would corrupt it.`);
    log(`Run:  ${cmd}`);
    return 1;
  }

  if (!target) {
    try {
      target = await fetchLatest({ timeoutMs: 5000 });
    } catch (e) {
      log(`could not resolve the latest version: ${e.message}`);
      return 1;
    }
  }
  if (compareSemver(target, PKG_VERSION) === 0 && info.kind === 'npm-global') {
    out(`Already on ${PKG_VERSION} — nothing to do.`);
    return 0;
  }

  out(`Updating attribut ${PKG_VERSION} → ${target}…`);
  // installDurably falls back to a user-owned prefix when the system one is
  // root-owned, and reuses this install's own prefix when it already is one.
  let durable;
  let usedPrefix;
  try {
    ({ collector: durable, prefix: usedPrefix } = installDurably(target, exec, { prefix: info.prefix }));
  } catch (e) {
    log(`npm install failed: ${e.message}`);
    return 1;
  }
  if (usedPrefix && !info.prefix) {
    out(`The system npm prefix isn't writable — installed under ${usedPrefix}.`);
    out(`Add ${path.join(usedPrefix, 'bin')} to PATH to run \`attribut\` directly.`);
  }

  // If the running collector isn't the durable one (npx heal, manager
  // migration), the hooks still point at the OLD path — re-bake them from the
  // freshly installed package so they reference the durable location.
  if (durable !== defaultCollectorPath()) {
    out('Re-pointing hooks at the durable install…');
    try {
      execFileSync(process.execPath, [durable, 'install', '--rebake'], {
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: 60000,
      });
    } catch (e) {
      log(`hook re-bake failed: ${e.message}`);
      log(`run \`node ${durable} install --rebake\` to finish.`);
      return 1;
    }
  }

  out(`Updated to attribut ${target}.`);
  return 0;
}

module.exports = {
  parseSemver,
  compareSemver,
  detectInstall,
  isEphemeralInstall,
  fetchLatestVersion,
  maybeNotifyUpdate,
  maybeAutoUpdate,
  ensureDurableCollector,
  installDurably,
  fallbackPrefixDir,
  isWritableTarget,
  globalCollectorPath,
  autoUpdateOptOutPath,
  runUpdate,
  UPDATE_HELP,
};
