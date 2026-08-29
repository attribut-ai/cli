'use strict';

// Read/merge/write helpers for Grok Build's ATTRIBUT-owned hook file —
// ~/.grok/hooks/attribut.json. Sibling to settings.cjs (Claude) and
// settings_cursor.cjs, but a dedicated file: Grok scans ~/.grok/hooks/*.json
// and also Claude/Cursor settings, so merging into those would dual-fire and
// mis-tag Grok sessions as claude_code.
//
// Shape (Claude-compatible nested groups):
//   { "hooks": {
//       "Stop": [{ "hooks": [{ "type": "command", "command": "…", "timeout": 30 }] }],
//       "SessionEnd": [{ "hooks": [{ "type": "command", "command": "…", "timeout": 30 }] }] } }
//
// We own the whole attribut.json. Install upserts our Stop/SessionEnd entries
// (keyed on collector path) and preserves any other events already in the file.
// Uninstall removes attribut.json only — sibling files in ~/.grok/hooks/ stay.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { mergeHooks, readSettings, backupSettings, writeSettings } = require('./settings.cjs');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Default ~/.grok/hooks/attribut.json. Override via GROK_HOOKS_PATH (tests). */
function grokHooksPath() {
  if (process.env.GROK_HOOKS_PATH) return process.env.GROK_HOOKS_PATH;
  const home = process.env.GROK_HOME
    ? expandHome(process.env.GROK_HOME)
    : path.join(os.homedir(), '.grok');
  return path.join(home, 'hooks', 'attribut.json');
}

function countHookGroups(settings) {
  const hooks = settings && settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return 0;
  let n = 0;
  for (const v of Object.values(hooks)) {
    if (Array.isArray(v)) n += v.length;
  }
  return n;
}

/**
 * Full install apply: read → backup → merge our events → write. Returns
 * { backupPath, settingsPath, merged }.
 */
function applyGrokHooks(hooksObj, p = grokHooksPath(), isOurs) {
  const existing = readSettings(p);
  const backupPath = backupSettings(p);
  const merged = mergeHooks(existing, hooksObj, isOurs);
  writeSettings(merged, p);
  return { backupPath, settingsPath: p, merged };
}

/**
 * Full uninstall apply: backup + delete attribut.json when present.
 * Returns { backupPath, settingsPath, removed }. A no-op when the file is absent.
 */
function applyGrokUninstall(p = grokHooksPath()) {
  try {
    fs.accessSync(p);
  } catch {
    return { backupPath: null, settingsPath: p, removed: 0 };
  }
  const existing = readSettings(p);
  const removed = Math.max(1, countHookGroups(existing));
  const backupPath = backupSettings(p);
  fs.unlinkSync(p);
  return { backupPath, settingsPath: p, removed };
}

module.exports = {
  grokHooksPath,
  applyGrokHooks,
  applyGrokUninstall,
};
