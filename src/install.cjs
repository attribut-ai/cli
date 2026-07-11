'use strict';

// `attribut install` / `attribut uninstall` — register/deregister the ATTRIBUT
// capture collector as Claude Code hooks in ~/.claude/settings.json.
//
// REGISTER-IN-PLACE: unlike the old copy-based install (which copied two
// dependency-free files into ~/.claude/hooks/), this collector requires
// ajv/ajv-formats from this package's node_modules. So we DO NOT copy anything —
// the hooks invoke this package's own installed collector.cjs at its absolute
// path, where node_modules already resolves. That means the package must be
// durably installed (`npm i -g`), not run via ephemeral npx, for the baked path
// to stay valid.
//
// The ingest token is NEVER inlined into the hook command (that would land it
// cleartext in settings.json and expose it in `ps`). It is persisted to a 0600
// file (token.cjs) at install time and read back by the collector at POST time.
//
// FAILURE POLICY: opposite of the collector hot path — these are explicit user
// actions, so they fail LOUD (non-zero exit + stderr) on real errors.

const fs = require('fs');
const os = require('os');
const path = require('path');

const settings = require('./settings.cjs');
const settingsAgy = require('./settings_agy.cjs');
const settingsCodex = require('./settings_codex.cjs');
const settingsCursor = require('./settings_cursor.cjs');
const tokenStore = require('./token.cjs');
const updater = require('./update.cjs');

// Providers this installer can register. 'anthropic' = Claude Code (settings.json
// hooks); 'antigravity' = Google Antigravity (~/.gemini/config/hooks.json);
// 'openai' = Codex (~/.codex/config.toml array-of-tables hooks); 'cursor' =
// Cursor (~/.cursor/hooks.json event-keyed hooks).
const PROVIDERS = new Set(['anthropic', 'antigravity', 'openai', 'cursor']);
const DEFAULT_PROVIDER = 'anthropic';

// Map an agent slug (the device-flow / server vocabulary: claude_code, agy,
// codex, cursor, …) to the provider this installer knows how to wire up. Only
// agents with a hook installer appear here — `attribut connect` offers exactly these.
const AGENT_PROVIDER = { claude_code: 'anthropic', agy: 'antigravity', codex: 'openai', cursor: 'cursor' };

/** The agents `connect` can actually install hooks for, in display order. */
const INSTALLABLE_AGENTS = Object.keys(AGENT_PROVIDER);

/** Absolute path to the collector this command will register as the hook. */
function collectorPath() {
  return path.resolve(__dirname, 'collector.cjs');
}

/**
 * The collector path hooks are baked against. Normally collectorPath(); when
 * running from an ephemeral npx/dlx cache (`npx attribut connect`), first heal
 * onto a durable `npm i -g` install and bake THAT path — an npx cache path
 * can be pruned at any time, silently killing the hooks (timer.cjs dodges the
 * same trap for the timer). Falls back to the ephemeral path with a loud
 * warning when the global install fails. Memoized per process by update.cjs.
 */
function hookCollectorPath() {
  return updater.ensureDurableCollector(collectorPath());
}

/** The legacy copy-based install dir (old cli). Override via env for tests. */
function legacyHooksDir() {
  return process.env.ATTRIBUT_HOOKS_DIR || path.join(os.homedir(), '.claude', 'hooks');
}

function out(msg) {
  process.stdout.write(`${msg}\n`);
}
function err(msg) {
  process.stderr.write(`${msg}\n`);
}

/** POSIX single-quote a string for safe inlining into a shell command. */
function shquote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Parse `--key=<token>` / `--key <token>` (also a bare positional), an optional
 * `--endpoint=<origin>`, and `-h`/`--help`. Returns { key, endpoint, help }.
 */
function parseArgs(argv) {
  // `providerExplicit` distinguishes "no --provider" (full, every-agent
  // disconnect on uninstall) from an explicit `--provider=anthropic` (scope to
  // Claude only). `provider` still defaults to anthropic so install's
  // Claude-first behaviour is unchanged.
  const result = {
    key: null,
    endpoint: null,
    provider: DEFAULT_PROVIDER,
    providerExplicit: false,
    help: false,
    rebake: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key') result.key = argv[++i];
    else if (a.startsWith('--key=')) result.key = a.slice('--key='.length);
    else if (a === '--endpoint') result.endpoint = argv[++i];
    else if (a.startsWith('--endpoint=')) result.endpoint = a.slice('--endpoint='.length);
    else if (a === '--provider') {
      result.provider = argv[++i];
      result.providerExplicit = true;
    } else if (a.startsWith('--provider=')) {
      result.provider = a.slice('--provider='.length);
      result.providerExplicit = true;
    } else if (a === '--rebake') result.rebake = true;
    else if (a === '-h' || a === '--help') result.help = true;
    else if (!a.startsWith('-')) positionals.push(a);
  }
  if (!result.key && positionals.length) result.key = positionals[0];
  return result;
}

/**
 * Build the shell command for one hook mode. The optional ingest base is inlined
 * as an env-var prefix (it is NOT a secret); the token is read from its 0600 file
 * by the collector and never appears here. `node` runs the installed collector.
 */
function buildHookCommand(mode, { collector, ingestBase, provider }) {
  const prefix = ingestBase ? `INGEST_BASE=${shquote(ingestBase)} ` : '';
  // Non-default providers carry an explicit --provider flag so the collector
  // selects the right parser + provider/tool tag. The default (anthropic) omits
  // it for byte-identical back-compat with existing Claude installs.
  const provFlag = provider && provider !== DEFAULT_PROVIDER ? `--provider ${provider} ` : '';
  return `${prefix}node ${shquote(collector)} ${provFlag}${mode}`;
}

/**
 * Build the agy hooks.json spec for our named hook (settings_agy merges it under
 * the AGY_HOOK_NAME key). v1 registers PostToolUse only — it is the one event
 * verified to fire AND pipe a JSON stdin payload (conversationId + transcriptPath)
 * in agy 1.0.8; Stop/SessionEnd fire but pipe nothing. The collector posts a
 * cumulative snapshot per fire and the server reconciles by sessionId.
 */
function buildAgyHookSpec({ collector, ingestBase }) {
  const command = buildHookCommand('posttooluse', {
    collector,
    ingestBase,
    provider: 'antigravity',
  });
  return {
    PostToolUse: [
      { matcher: '*', hooks: [{ type: 'command', command, timeout: 30 }] },
    ],
  };
}

/**
 * Build the Codex config.toml array-of-tables specs for our two hook events.
 * `hooks.PostToolUse` uses a catch-all matcher (".*") so EVERY tool produces a
 * per-tool signal; `hooks.Stop` has no matcher. Each is a nested `type="command"`
 * hook that runs the collector with `--provider openai <mode>` (no token — read
 * from the 0600 file at POST time). Keyed by array name for settings_codex.
 */
function buildCodexHookSpecs({ collector, ingestBase }) {
  const entry = (mode) => ({
    nested: {
      name: 'hooks',
      entries: [
        {
          type: 'command',
          command: buildHookCommand(mode, { collector, ingestBase, provider: 'openai' }),
        },
      ],
    },
  });
  return {
    'hooks.PostToolUse': [{ keys: { matcher: '.*' }, ...entry('posttooluse') }],
    'hooks.Stop': [{ keys: {}, ...entry('stop') }],
  };
}

/** Ownership predicate for Codex TOML upsert: an element is ours iff its command
 * runs our installed collector. Drops only our prior entries on re-run. */
function isOurCodexEntry(collector) {
  return (text) => typeof text === 'string' && text.includes(collector);
}

/**
 * Build the Cursor hooks.json specs, keyed by event for settings_cursor. Each is a
 * `type="command"` entry running the collector with `--provider cursor <mode>` (no
 * token — read from the 0600 file at POST time). `sessionEnd`/`stop` post the full
 * session snapshot; `afterShellExecution` runs the collector as `posttooluse`, whose
 * only job is to capture a `git commit` SHA into the sidecar (it never posts).
 */
function buildCursorHookSpecs({ collector, ingestBase }) {
  const cmd = (mode) => ({
    type: 'command',
    command: buildHookCommand(mode, { collector, ingestBase, provider: 'cursor' }),
  });
  return {
    sessionEnd: [cmd('sessionend')],
    stop: [cmd('stop')],
    afterShellExecution: [cmd('posttooluse')],
  };
}

/** Ownership predicate for Cursor hooks.json: an entry is ours iff its command
 * runs our installed collector. Drops only our prior entries on re-run. */
function isOurCursorEntry(collector) {
  return (command) => typeof command === 'string' && command.includes(collector);
}

/**
 * Build the hooks map merged into settings.json. Each entry carries a private
 * `_dedupeKey` (the collector path) so mergeHooks replaces our own entries in
 * place without disturbing unrelated user hooks.
 */
function buildHooksMap({ collector, ingestBase }) {
  const mk = (mode) => ({
    type: 'command',
    command: buildHookCommand(mode, { collector, ingestBase }),
  });
  return {
    PostToolUse: [{ matcher: 'Bash', hooks: [mk('posttooluse')], _dedupeKey: collector }],
    SessionEnd: [{ hooks: [mk('sessionend')], _dedupeKey: collector }],
    Stop: [{ hooks: [mk('stop')], _dedupeKey: collector }],
  };
}

// Legacy bin-based hook: the `attribut` executable invoked directly with a mode
// (`attribut posttooluse`), as written by pre-overhaul installs. Anchored on a
// command boundary (start / whitespace / quote / `=` from an env prefix) so it
// matches the invoked bin, not an unrelated path that happens to end in
// "attribut". The current node-based command (`node '…/collector.cjs' <mode>`)
// does not contain this adjacency, so it is never caught here.
const LEGACY_BIN_HOOK_RE = /(?:^|[\s'"=])attribut\s+(?:posttooluse|sessionend|stop)\b/;

/**
 * Predicate: does a hook command belong to ATTRIBUT? Recognizes every form we
 * have ever written:
 *   - the current register-in-place collector (absolute collector.cjs path),
 *   - LEGACY copy-based installs (attribut-collector.cjs),
 *   - LEGACY bin invocations (`attribut <mode>`), and
 *   - LEGACY env-token installs (the ATTRIBUT_HOOK_TOKEN prefix).
 * Without the last two, upgrading over a pre-overhaul install would leave the old
 * hooks in place — stacking duplicates on install and orphaning them on
 * uninstall. Still conservative: no bare `attribut` match that could strip an
 * unrelated user hook merely mentioning the word.
 */
function isOurCommand(command) {
  if (typeof command !== 'string') return false;
  return (
    command.includes(collectorPath()) ||
    command.includes('attribut-collector.cjs') ||
    command.includes('ATTRIBUT_HOOK_TOKEN') ||
    LEGACY_BIN_HOOK_RE.test(command)
  );
}

const INSTALL_HELP = `
attribut install — register the ATTRIBUT capture hook (Claude Code by default)

Usage:
  attribut install --key=<ingest-token> [--endpoint=<origin>] [--provider <agent>]

  --key=<token>        The ATTRIBUT ingest token (also accepted as a bare arg).
  --endpoint=<origin>  Override the ingest origin (default: https://ingest.attribut.ai).
                       The collector posts to <origin>/v1/hook.
  --provider <agent>   Which agent to install for: anthropic (Claude Code, default),
                       openai (Codex), cursor (Cursor), antigravity (Antigravity).
  -h, --help           Show this help.

For Claude Code, registers PostToolUse(Bash) + SessionEnd + Stop hooks in
~/.claude/settings.json; other agents register the equivalent hooks in their own
config. The token is stored separately in a 0600 file (never in settings.json).
Re-running is idempotent — it replaces our hooks in place and never duplicates.
Most users should run \`attribut connect\` instead, which installs every chosen
agent in one browser-approved step.
`;

const UNINSTALL_HELP = `
attribut uninstall — remove ATTRIBUT capture hooks

Usage:
  attribut uninstall                    full disconnect: every agent
  attribut uninstall --provider <agent> just one agent

With NO --provider, this fully disconnects the device: it strips ATTRIBUT's hooks
from EVERY agent (Claude Code, Codex, Cursor, Antigravity), deletes legacy collector
files, drops the stored token(s), and removes the hourly heartbeat timer.

With --provider <agent> (anthropic | openai | cursor | antigravity), it scopes to
that one agent — removing just its hooks and revoking just its token, leaving the
other agents and the heartbeat timer connected.

Unrelated hooks are always preserved, and each touched config is backed up first.
`;

/**
 * `attribut install [--key=<token>] [--endpoint=<origin>]`. Returns an exit code.
 */
function runInstall(argv) {
  const { key, endpoint, provider, help, rebake } = parseArgs(argv || []);
  if (help) {
    out(INSTALL_HELP.trimStart());
    return 0;
  }
  // --rebake re-points every existing ATTRIBUT hook at THIS collector without
  // touching tokens — used by `attribut update` after healing an install onto
  // a new path. No provider/key args apply.
  if (rebake) return runRebake();
  if (!PROVIDERS.has(provider)) {
    err(`Unknown --provider "${provider}". Expected one of: ${[...PROVIDERS].join(', ')}.`);
    return 2;
  }
  if (!key) {
    err('Missing required ingest token. Pass --key=<token>.');
    out(INSTALL_HELP.trimStart());
    return 2;
  }

  const collector = hookCollectorPath();
  const ingestBase = endpoint ? String(endpoint).replace(/\/+$/, '') : null;

  // A custom endpoint must be https (the token would otherwise travel cleartext).
  // ATTRIBUT_ALLOW_INSECURE=1 is the only escape hatch, for localhost testing.
  if (ingestBase && process.env.ATTRIBUT_ALLOW_INSECURE !== '1') {
    let ok = false;
    try {
      ok = new URL(ingestBase).protocol === 'https:';
    } catch {
      ok = false;
    }
    if (!ok) {
      err(`--endpoint must be a valid https origin (got: ${endpoint}).`);
      return 2;
    }
  }

  // Persist the token to its 0600 file FIRST, then register the hooks. If the
  // token can't be written we fail loud and don't touch any settings file. The
  // token store is provider-agnostic (shared 0600 file).
  let tokenFile;
  try {
    tokenFile = tokenStore.writeToken(key);
  } catch (e) {
    err(`Could not write token file: ${e.message}`);
    return 1;
  }

  if (provider === 'antigravity') {
    let applied;
    try {
      const spec = buildAgyHookSpec({ collector, ingestBase });
      applied = settingsAgy.applyAgyHooks(spec);
    } catch (e) {
      err(`Could not write hooks to ${settingsAgy.agyHooksPath()}: ${e.message}`);
      return 1;
    }
    if (applied.backupPath) out(`  Backed up previous hooks → ${applied.backupPath}`);
    out(`Registered PostToolUse hook in ${applied.settingsPath}`);
    out(`  collector → ${collector}`);
    out(`  token     → ${tokenFile} (mode 0600)`);
    out('');
    out('Google Antigravity will now capture commit + session attribution to ATTRIBUT.');
    out('  (Restart any running agy sessions / the Antigravity IDE to pick up the hook.)');
    return 0;
  }

  if (provider === 'openai') {
    let applied;
    try {
      const specs = buildCodexHookSpecs({ collector, ingestBase });
      applied = settingsCodex.applyCodexHooks(specs, isOurCodexEntry(collector));
    } catch (e) {
      err(`Could not write hooks to ${settingsCodex.codexConfigPath()}: ${e.message}`);
      return 1;
    }
    if (applied.backupPath) out(`  Backed up previous config → ${applied.backupPath}`);
    out(`Registered PostToolUse + Stop hooks in ${applied.settingsPath}`);
    out(`  collector → ${collector}`);
    out(`  token     → ${tokenFile} (mode 0600)`);
    out('');
    out('Codex will now capture commit + session attribution to ATTRIBUT.');
    out('  (Run `codex` once and accept the one-time /hooks trust prompt to enable them.)');
    return 0;
  }

  if (provider === 'cursor') {
    let applied;
    try {
      const specs = buildCursorHookSpecs({ collector, ingestBase });
      applied = settingsCursor.applyCursorHooks(specs, isOurCursorEntry(collector));
    } catch (e) {
      err(`Could not write hooks to ${settingsCursor.cursorHooksPath()}: ${e.message}`);
      return 1;
    }
    if (applied.backupPath) out(`  Backed up previous hooks → ${applied.backupPath}`);
    out(`Registered sessionEnd + stop + afterShellExecution hooks in ${applied.settingsPath}`);
    out(`  collector → ${collector}`);
    out(`  token     → ${tokenFile} (mode 0600)`);
    out('');
    out('Cursor will now capture session attribution to ATTRIBUT.');
    out('  (Restart Cursor and accept the one-time hooks trust prompt to enable them.)');
    return 0;
  }

  const p = settings.settingsPath();
  let applied;
  try {
    const hooksMap = buildHooksMap({ collector, ingestBase });
    applied = settings.applyHooks(hooksMap, p, isOurCommand);
  } catch (e) {
    err(`Could not write hooks to ${p}: ${e.message}`);
    return 1;
  }

  if (applied.backupPath) out(`  Backed up previous settings → ${applied.backupPath}`);
  out(`Registered PostToolUse, SessionEnd, and Stop hooks in ${applied.settingsPath}`);
  out(`  collector → ${collector}`);
  out(`  token     → ${tokenFile} (mode 0600)`);
  out('');
  out('Claude Code will now capture commit + session attribution to ATTRIBUT.');
  out('  (Restart any running Claude Code sessions to pick up the hook.)');
  return 0;
}

/** Delete a file if it exists. Returns true if it was removed. */
function rmIfExists(p) {
  try {
    fs.unlinkSync(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/** Remove legacy copy-based collector files; prune the hooks dir if it empties. */
function cleanupLegacyFiles() {
  const dir = legacyHooksDir();
  let removed = 0;
  for (const name of ['attribut-collector.cjs', 'parser.cjs']) {
    if (rmIfExists(path.join(dir, name))) removed += 1;
  }
  if (removed > 0) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      /* dir missing or not empty — leave it */
    }
  }
  return removed;
}

/**
 * Uninstall descriptors — one per agent we can register. Each knows how to strip
 * its own hooks (via the matching settings module) and which per-agent token
 * slug to revoke. Ownership predicates match hooks baked by ANY install of this
 * package (durable global OR ephemeral npx), so a removal never orphans a hook
 * merely because it was baked from a different collector path — the same
 * broad-match reasoning `runRebake` uses.
 */
function uninstallProviders() {
  const collector = collectorPath();
  const codexOurs = (text) =>
    typeof text === 'string' && (text.includes(collector) || ANY_COLLECTOR_RE.test(text));
  const cursorOurs = (cmd) =>
    typeof cmd === 'string' && (cmd.includes(collector) || ANY_COLLECTOR_RE.test(cmd));
  return [
    {
      provider: 'anthropic',
      name: 'Claude Code',
      agent: 'claude_code',
      path: () => settings.settingsPath(),
      remove: () => settings.applyUninstall(isOurCommandAnyInstall, settings.settingsPath()),
    },
    {
      provider: 'openai',
      name: 'Codex',
      agent: 'codex',
      path: () => settingsCodex.codexConfigPath(),
      remove: () => settingsCodex.applyCodexUninstall(codexOurs),
    },
    {
      provider: 'cursor',
      name: 'Cursor',
      agent: 'cursor',
      path: () => settingsCursor.cursorHooksPath(),
      remove: () => settingsCursor.applyCursorUninstall(cursorOurs),
    },
    {
      provider: 'antigravity',
      name: 'Antigravity',
      agent: 'agy',
      path: () => settingsAgy.agyHooksPath(),
      remove: () => settingsAgy.applyAgyUninstall(),
    },
  ];
}

/**
 * `attribut uninstall [--provider <agent>]`. Returns an exit code.
 *
 * With NO `--provider`, this is a FULL disconnect: it strips ATTRIBUT's hooks
 * from EVERY agent (Claude Code, Codex, Cursor, Antigravity), removes legacy
 * collector files, drops the whole token store, and removes the device-level
 * heartbeat timer. (Previously the no-flag path removed only Claude's hooks
 * while still dropping every agent's token and the timer — leaving the other
 * agents' hooks orphaned and firing without a token.)
 *
 * With `--provider <agent>`, it scopes to that one agent: strips just its hooks
 * and revokes just its token. The timer and the other agents stay put, since
 * the device may still be connected through them.
 */
function runUninstall(argv) {
  const { provider, providerExplicit, help } = parseArgs(argv || []);
  if (help) {
    out(UNINSTALL_HELP.trimStart());
    return 0;
  }
  if (providerExplicit && !PROVIDERS.has(provider)) {
    err(`Unknown --provider "${provider}". Expected one of: ${[...PROVIDERS].join(', ')}.`);
    return 2;
  }

  const descriptors = uninstallProviders();

  // Scoped uninstall: one agent's hooks + one agent's token only.
  if (providerExplicit) {
    const target = descriptors.find((d) => d.provider === provider);
    let result;
    try {
      result = target.remove();
    } catch (e) {
      err(`Could not update ${target.path()}: ${e.message}`);
      return 1;
    }
    // Legacy copy-based files are Claude-only, so clean them on the anthropic scope.
    let legacyRemoved = 0;
    if (provider === 'anthropic') {
      try {
        legacyRemoved = cleanupLegacyFiles();
      } catch (e) {
        err(`Could not remove legacy collector files: ${e.message}`);
        return 1;
      }
    }
    let tokenRemoved = false;
    try {
      tokenRemoved = tokenStore.removeToken(target.agent);
    } catch (e) {
      err(`Could not remove ${target.name} token: ${e.message}`);
      return 1;
    }
    if (result.removed === 0 && legacyRemoved === 0 && !tokenRemoved) {
      out(`No ATTRIBUT ${target.name} hook found — nothing to do.`);
      return 0;
    }
    if (result.backupPath) out(`  Backed up previous config → ${result.backupPath}`);
    if (result.removed > 0) {
      out(`Removed ${result.removed} ATTRIBUT hook entr${result.removed === 1 ? 'y' : 'ies'} from ${result.settingsPath}`);
    }
    if (legacyRemoved > 0) out(`Deleted ${legacyRemoved} legacy collector file(s) from ${legacyHooksDir()}`);
    if (tokenRemoved) out(`Revoked the stored ${target.name} token.`);
    out(`ATTRIBUT capture hook removed (${target.name}). Other agents (if any) are still connected.`);
    return 0;
  }

  // Full disconnect (no --provider): every agent's hooks, every token, the timer.
  // One agent's corrupt/unwritable config must not strand the others, so failures
  // are collected and reflected in the exit code rather than aborting the sweep.
  let hadError = false;
  let totalRemoved = 0;
  const removedAgents = [];
  for (const d of descriptors) {
    let result;
    try {
      result = d.remove();
    } catch (e) {
      err(`Could not update ${d.path()} (${d.name}): ${e.message}`);
      hadError = true;
      continue;
    }
    if (result.backupPath) out(`  Backed up previous ${d.name} config → ${result.backupPath}`);
    if (result.removed > 0) {
      out(`Removed ${result.removed} ATTRIBUT hook entr${result.removed === 1 ? 'y' : 'ies'} from ${result.settingsPath} (${d.name})`);
      totalRemoved += result.removed;
      removedAgents.push(d.name);
    }
  }

  let legacyRemoved = 0;
  try {
    legacyRemoved = cleanupLegacyFiles();
  } catch (e) {
    err(`Could not remove legacy collector files: ${e.message}`);
    hadError = true;
  }
  if (legacyRemoved > 0) out(`Deleted ${legacyRemoved} legacy collector file(s) from ${legacyHooksDir()}`);

  // Drop the whole token store regardless of whether hooks were present.
  let tokenRemoved = false;
  try {
    tokenRemoved = tokenStore.removeToken();
  } catch (e) {
    err(`Could not remove token file: ${e.message}`);
    hadError = true;
  }
  if (tokenRemoved) out('Removed stored ingest token(s).');

  // The heartbeat timer is device-level, so it only comes out on a full
  // disconnect. Required lazily — see timer.cjs, which itself requires this
  // module for collectorPath().
  let timerRemoved = false;
  try {
    timerRemoved = require('./timer.cjs').removeTimer();
  } catch (e) {
    err(`Could not remove the heartbeat timer: ${e.message}`);
    hadError = true;
  }
  if (timerRemoved) out('Removed the heartbeat timer.');

  if (hadError) {
    err('ATTRIBUT uninstall finished with errors — see above.');
    return 1;
  }
  if (totalRemoved === 0 && legacyRemoved === 0 && !tokenRemoved && !timerRemoved) {
    out('No ATTRIBUT hooks found — nothing to do.');
    return 0;
  }
  out('ATTRIBUT capture hook removed (all agents).');
  return 0;
}

/**
 * Register the capture hook for ONE agent and persist its (per-agent) token.
 * Used by `attribut connect` after the device flow returns a token per agent.
 * Maps the agent slug to the provider this installer supports, writes the token
 * into the per-agent store, and merges the hooks in place (idempotent — same
 * dedupe path as runInstall). Throws (loud) for an agent we can't install or on
 * any settings/token write failure. Returns the `applyHooks`/`applyAgyHooks`
 * result ({ settingsPath, backupPath, ... }).
 */
function registerAgent({ agent, token, ingestBase }) {
  const provider = AGENT_PROVIDER[agent];
  if (!provider) {
    throw new Error(
      `connect: no hook installer for agent "${agent}" ` +
        `(installable: ${INSTALLABLE_AGENTS.join(', ')}).`
    );
  }
  if (!token) throw new Error(`connect: empty token for agent "${agent}".`);

  // Persist this agent's token into the per-agent map (token.cjs migrates a
  // legacy bare token to claude_code on first per-agent write).
  tokenStore.writeToken(token, agent);

  const collector = hookCollectorPath();
  const base = ingestBase ? String(ingestBase).replace(/\/+$/, '') : null;

  if (provider === 'antigravity') {
    const spec = buildAgyHookSpec({ collector, ingestBase: base });
    return settingsAgy.applyAgyHooks(spec);
  }
  if (provider === 'openai') {
    const specs = buildCodexHookSpecs({ collector, ingestBase: base });
    return settingsCodex.applyCodexHooks(specs, isOurCodexEntry(collector));
  }
  if (provider === 'cursor') {
    const specs = buildCursorHookSpecs({ collector, ingestBase: base });
    return settingsCursor.applyCursorHooks(specs, isOurCursorEntry(collector));
  }
  const hooksMap = buildHooksMap({ collector, ingestBase: base });
  return settings.applyHooks(hooksMap, settings.settingsPath(), isOurCommand);
}

// A baked collector command from ANY prior install of this package — durable
// global (`…/node_modules/attribut/src/collector.cjs`) or npx-ephemeral
// (`…/_npx/<hash>/node_modules/attribut/src/collector.cjs`). Rebake must match
// these even though they are not THIS process's collectorPath().
const ANY_COLLECTOR_RE = /attribut[\\/]src[\\/]collector\.cjs/;

/** isOurCommand widened to collector paths baked by OTHER installs of this
 * package — exactly what a rebake exists to replace. */
function isOurCommandAnyInstall(command) {
  if (typeof command !== 'string') return false;
  return isOurCommand(command) || ANY_COLLECTOR_RE.test(command);
}

/** First INGEST_BASE='…' baked into existing hook commands, or null. Rebake
 * preserves a custom endpoint instead of silently resetting it. */
function extractIngestBase(rawText) {
  const m = /INGEST_BASE='([^']+)'/.exec(rawText);
  return m ? m[1] : null;
}

function readRawIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * `attribut install --rebake` — re-point every EXISTING ATTRIBUT hook (all
 * providers) plus the heartbeat timer at THIS process's collector path.
 * Tokens are untouched (must already exist); providers without our hooks are
 * left alone. Run by `attribut update` from the freshly installed package
 * after a path-changing update (npx→durable heal). Fail-loud per policy, but
 * one provider's corrupt settings file must not strand the others — errors
 * are reported and the exit code reflects any failure.
 */
function runRebake() {
  if (!tokenStore.readToken()) {
    err('No ingest token found — run `attribut connect` (or `attribut install --key=…`) first.');
    return 1;
  }
  const collector = collectorPath();
  let rebaked = 0;
  let failed = 0;

  const providers = [
    {
      name: 'claude code',
      file: settings.settingsPath(),
      apply: (ingestBase) =>
        settings.applyHooks(
          buildHooksMap({ collector, ingestBase }),
          settings.settingsPath(),
          isOurCommandAnyInstall
        ),
    },
    {
      name: 'antigravity',
      file: settingsAgy.agyHooksPath(),
      apply: (ingestBase) => settingsAgy.applyAgyHooks(buildAgyHookSpec({ collector, ingestBase })),
    },
    {
      name: 'codex',
      file: settingsCodex.codexConfigPath(),
      apply: (ingestBase) =>
        settingsCodex.applyCodexHooks(
          buildCodexHookSpecs({ collector, ingestBase }),
          isOurCommandAnyInstall
        ),
    },
    {
      name: 'cursor',
      file: settingsCursor.cursorHooksPath(),
      apply: (ingestBase) =>
        settingsCursor.applyCursorHooks(
          buildCursorHookSpecs({ collector, ingestBase }),
          isOurCommandAnyInstall
        ),
    },
  ];

  for (const p of providers) {
    const raw = readRawIfExists(p.file);
    if (!raw || !isOurCommandAnyInstall(raw)) continue;
    try {
      p.apply(extractIngestBase(raw));
      out(`Re-baked ${p.name} hooks in ${p.file}`);
      rebaked += 1;
    } catch (e) {
      err(`Could not re-bake ${p.name} hooks in ${p.file}: ${e.message}`);
      failed += 1;
    }
  }

  // The heartbeat timer bakes its own argv — refresh it too if one is
  // installed. Required lazily (timer.cjs requires this module).
  const timer = require('./timer.cjs');
  const timerFile = process.platform === 'darwin' ? timer.launchdPlistPath() : timer.systemdTimerPath();
  if (process.platform !== 'win32' && fs.existsSync(timerFile)) {
    timer.installTimer(); // best-effort; reports its own errors
  }

  if (rebaked === 0 && failed === 0) out('No ATTRIBUT hooks found to re-bake.');
  else out(`Hooks now run ${collector}`);
  return failed > 0 ? 1 : 0;
}

module.exports = {
  collectorPath,
  parseArgs,
  shquote,
  buildHookCommand,
  buildHooksMap,
  buildAgyHookSpec,
  buildCodexHookSpecs,
  buildCursorHookSpecs,
  isOurCodexEntry,
  isOurCursorEntry,
  isOurCommand,
  isOurCommandAnyInstall,
  runInstall,
  runUninstall,
  runRebake,
  registerAgent,
  AGENT_PROVIDER,
  INSTALLABLE_AGENTS,
};
