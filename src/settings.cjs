'use strict';

// Pure + fs helpers for reading/merging/writing ~/.claude/settings.json.
//
// `install`/`uninstall` deep-merge ONLY our hook entries, preserving every
// existing key (other env vars, unrelated user hooks, settings), and back the
// file up before writing. We NEVER clobber a file we cannot parse.
//
// CJS port of the old cli's src/settings.js, trimmed to the hooks path and
// extended with removeHooks() for uninstall.

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Default settings.json path. Override via CLAUDE_SETTINGS_PATH (used in tests). */
function settingsPath() {
  return (
    process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json')
  );
}

/**
 * Deep-merge a Claude Code `hooks` map into an existing settings object WITHOUT
 * mutating the input. Returns a NEW object.
 *
 * Claude Code's hooks shape is:
 *   { hooks: { <Event>: [ { matcher?, hooks: [ { type:"command", command } ] } ] } }
 *
 * IDEMPOTENCY: each incoming entry carries a `_dedupeKey` — a substring that
 * uniquely identifies OUR hook (the absolute collector path). Before appending,
 * we drop any existing entry in the same event whose inner command contains that
 * key, so re-running install replaces in place instead of stacking duplicates.
 * The optional `isOurs(command)` predicate widens that match to LEGACY hook forms
 * (e.g. a pre-overhaul `attribut <mode>` bin invocation) whose command does not
 * contain the current collector path — without it, upgrading over an old install
 * stacks duplicates. Unrelated user hooks (matching neither) are preserved verbatim.
 *
 * Pure — no I/O.
 */
function mergeHooks(existing, hooksObj, isOurs) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const existingHooks =
    base.hooks && typeof base.hooks === 'object' && !Array.isArray(base.hooks)
      ? base.hooks
      : {};

  const mergedHooks = { ...existingHooks };

  for (const [event, incomingEntries] of Object.entries(hooksObj || {})) {
    const prior = Array.isArray(mergedHooks[event]) ? mergedHooks[event] : [];

    // The dedupe keys our incoming entries contribute for this event.
    const incomingKeys = incomingEntries
      .map((e) => e._dedupeKey)
      .filter((k) => typeof k === 'string' && k.length > 0);

    // Keep only prior entries that are neither one of our incoming collector
    // paths nor a legacy form recognized by `isOurs`.
    const kept = prior.filter(
      (entry) =>
        !entryMatchesAnyKey(entry, incomingKeys) &&
        !(typeof isOurs === 'function' && entryCommandMatches(entry, isOurs))
    );

    // Strip the private `_dedupeKey` marker from what we actually write out.
    const cleaned = incomingEntries.map(({ _dedupeKey, ...rest }) => rest);

    mergedHooks[event] = [...kept, ...cleaned];
  }

  return { ...base, hooks: mergedHooks };
}

/**
 * Remove every hook entry (across all events) whose inner command matches
 * `predicate(command)`. Empty event arrays are pruned, and an empty `hooks`
 * object is removed entirely. Returns { settings, removed } where `removed` is
 * the count of dropped entries. Does NOT mutate the input.
 *
 * Pure — no I/O.
 */
function removeHooks(existing, predicate) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const existingHooks =
    base.hooks && typeof base.hooks === 'object' && !Array.isArray(base.hooks)
      ? base.hooks
      : null;

  if (!existingHooks) return { settings: base, removed: 0 };

  const nextHooks = {};
  let removed = 0;

  for (const [event, entries] of Object.entries(existingHooks)) {
    if (!Array.isArray(entries)) {
      nextHooks[event] = entries;
      continue;
    }
    const kept = entries.filter((entry) => {
      const isOurs = entryCommandMatches(entry, predicate);
      if (isOurs) removed += 1;
      return !isOurs;
    });
    if (kept.length > 0) nextHooks[event] = kept;
  }

  const next = { ...base };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;

  return { settings: next, removed };
}

/** True if any inner command of `entry` contains one of `keys`. */
function entryMatchesAnyKey(entry, keys) {
  if (!entry || !Array.isArray(entry.hooks) || keys.length === 0) return false;
  return entry.hooks.some(
    (h) => h && typeof h.command === 'string' && keys.some((k) => h.command.includes(k))
  );
}

/** True if any inner command of `entry` satisfies `predicate(command)`. */
function entryCommandMatches(entry, predicate) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => h && typeof h.command === 'string' && predicate(h.command));
}

/** Does a file exist and is it readable? */
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and JSON-parse settings.json. Returns {} when the file is absent.
 * Throws (loudly) on a malformed file — we will not silently clobber a file we
 * cannot understand.
 */
function readSettings(p = settingsPath()) {
  if (!exists(p)) return {};
  const raw = fs.readFileSync(p, 'utf8');
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `Existing ${p} is not valid JSON (${err.message}). Fix or remove it, then ` +
        `re-run — refusing to overwrite a file we cannot parse.`
    );
  }
}

// Keep at most this many timestamped backups per settings file; older ones are
// pruned so they don't accumulate forever.
const MAX_BACKUPS = 3;

/** Remove all but the newest MAX_BACKUPS `<p>.bak.*` files. Best-effort. */
function pruneBackups(p) {
  try {
    const dir = path.dirname(p);
    const prefix = `${path.basename(p)}.bak.`;
    const backups = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort(); // ISO timestamps sort lexicographically == chronologically
    for (const name of backups.slice(0, -MAX_BACKUPS)) {
      fs.unlinkSync(path.join(dir, name));
    }
  } catch {
    /* nothing to prune / dir gone — fine */
  }
}

/**
 * Back up the existing settings.json to settings.json.bak.<timestamp> (mode
 * 0600), returning the backup path (or null if there was nothing to back up).
 * Prunes older backups to MAX_BACKUPS.
 */
function backupSettings(p = settingsPath()) {
  if (!exists(p)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${p}.bak.${ts}`;
  fs.copyFileSync(p, backup);
  fs.chmodSync(backup, 0o600);
  pruneBackups(p);
  return backup;
}

/**
 * Atomically write `data` to `file` with the given mode: write a sibling temp
 * file (same dir → same filesystem, so rename is atomic), chmod it to defeat the
 * umask (mode-on-create is masked), then rename over the live file. A crash/kill
 * mid-write can only ever leave the temp behind — never a truncated real file.
 * Cleans up the temp on failure.
 */
function writeFileAtomic(file, data, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { encoding: 'utf8', mode });
    fs.chmodSync(tmp, mode); // mode-on-create is masked by umask; force it
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp may not exist — fine */
    }
    throw err;
  }
}

/**
 * Write a settings object as pretty JSON (mode 0600 — it sits beside secrets),
 * creating parent dirs as needed. Atomic (temp + rename) so a crash mid-write
 * can never truncate the live settings.json.
 */
function writeSettings(settings, p = settingsPath()) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomic(p, JSON.stringify(settings, null, 2) + '\n', 0o600);
}

/**
 * Full install apply: read → backup → merge hooks → write. The optional `isOurs`
 * predicate is forwarded to mergeHooks to also evict legacy ATTRIBUT hook forms.
 * Returns { backupPath, settingsPath, merged }.
 */
function applyHooks(hooksObj, p = settingsPath(), isOurs) {
  const existing = readSettings(p);
  const backupPath = backupSettings(p);
  const merged = mergeHooks(existing, hooksObj, isOurs);
  writeSettings(merged, p);
  return { backupPath, settingsPath: p, merged };
}

/**
 * Full uninstall apply: read → (backup + write only if something matched).
 * Returns { backupPath, settingsPath, removed, settings }. When nothing matches
 * (or the file is absent) we do not back up or rewrite — uninstall is a no-op.
 */
function applyUninstall(predicate, p = settingsPath()) {
  const existing = readSettings(p);
  const { settings, removed } = removeHooks(existing, predicate);
  if (removed === 0) {
    return { backupPath: null, settingsPath: p, removed: 0, settings: existing };
  }
  const backupPath = backupSettings(p);
  writeSettings(settings, p);
  return { backupPath, settingsPath: p, removed, settings };
}

module.exports = {
  settingsPath,
  mergeHooks,
  removeHooks,
  readSettings,
  backupSettings,
  writeSettings,
  applyHooks,
  applyUninstall,
};
