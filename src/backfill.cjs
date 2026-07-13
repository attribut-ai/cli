'use strict';

// ATTRIBUT backfill — send EXISTING local sessions through the live capture path.
//
// The CLI normally captures AI-coding sessions live via hooks: an event fires,
// the collector builds an envelope from the transcript, and POSTs it. That means
// everything BEFORE `attribut connect` was run is invisible to ATTRIBUT.
//
// Backfill closes that gap without inventing a second pipeline. For each
// connected tool it:
//   1. enumerates that tool's existing local sessions (audit.cjs / parser/*.cjs
//      — read-only, newest-first),
//   2. builds a synthetic "hook" payload pointing at each existing session, and
//   3. runs it through the SAME envelope-build + POST functions live capture
//      uses (collector.cjs) — so the payload shape, validation, and privacy
//      guarantees are identical to a live session.
//
// Re-sending is safe: the server reconciles by `sessionId` — "latest non-partial
// wins" — so a session that was already captured live, or backfilled twice, just
// overwrites in place. It never double-counts.
//
// Two entry points:
//   - runBackfillInteractive() — called by `connect` right after hooks install,
//     to offer backfilling pre-connect history in the same flow. Silent/no-op on
//     any non-interactive environment or error — connect must still succeed.
//   - runBackfill(argv) — the standalone `attribut backfill` command, for anyone
//     who skipped the offer or wants a wider/narrower window later.
//
// FAILURE POLICY: mirrors the collector's fail-safe philosophy on the hot path —
// a single session's build/post failure is logged to stderr and counted as
// failed, never fatal, never aborts the batch. Usage errors in the standalone
// command (bad flags, bad --since) fail loud with a non-zero exit, same as
// audit.cjs / connect.cjs.

const http = require('http');
const https = require('https');
const os = require('os');

const collector = require('./collector.cjs');
const { readToken } = require('./token.cjs');
const { allTranscripts } = require('./audit.cjs');
const ui = require('./ui.cjs');

// Replace the running user's home dir with `~` in a message before it hits
// stderr — fs error messages embed absolute paths that include the OS username.
// Keeps errors loud and diagnostic while not printing PII.
function redactHome(msg) {
  const home = os.homedir();
  return home ? String(msg).split(home).join('~') : String(msg);
}

const AGENT_SLUGS = ['claude_code', 'codex', 'agy', 'cursor'];
const AGENT_LABELS = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  agy: 'Antigravity',
  cursor: 'Cursor',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SINCE = '90d';

function out(msg) {
  process.stdout.write(`${msg}\n`);
}
function err(msg) {
  process.stderr.write(`${msg}\n`);
}

// ---------------------------------------------------------------------------
// since / window parsing
// ---------------------------------------------------------------------------

// Parse a --since spec into an epoch-ms cutoff, or null for "no cutoff".
//   "90d" / "30d"      -> N days ago
//   ISO date/datetime  -> Date.parse(arg)
//   null / "all"       -> null (no cutoff — full history)
//   undefined          -> defaults to "90d"
// Throws a clear Error on anything else (bad flag value = usage error).
function parseSince(arg) {
  if (arg === undefined) return parseSince(DEFAULT_SINCE);
  if (arg === null || arg === 'all') return null;
  const s = String(arg).trim();
  const days = /^(\d+)\s*d$/i.exec(s);
  if (days) return Date.now() - parseInt(days[1], 10) * DAY_MS;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  throw new Error(`invalid --since value: ${JSON.stringify(arg)} (expected "<N>d", an ISO date, or "all")`);
}

// ---------------------------------------------------------------------------
// enumeration — one entry point per agent, normalized to a common shape
// ---------------------------------------------------------------------------

// List agentSlug's existing local sessions, normalized to `{ ...raw, whenMs }`.
// Never throws — a missing/broken enumerator (tool not installed, parser error,
// db locked, ...) just yields an empty list, logged to stderr.
function enumerate(agentSlug) {
  try {
    switch (agentSlug) {
      case 'claude_code': {
        const fs = require('fs');
        return allTranscripts().map((p) => {
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(p).mtimeMs;
          } catch {
            /* file vanished between listing and stat — mtimeMs stays 0 */
          }
          return { path: p, mtimeMs, whenMs: mtimeMs };
        });
      }
      case 'codex': {
        const { listSessionRollouts } = require('./parser/codex.cjs');
        return listSessionRollouts().map((d) => ({ ...d, whenMs: d.mtimeMs }));
      }
      case 'agy': {
        const { listConversationIds } = require('./parser/antigravity_tokens.cjs');
        return listConversationIds().map((d) => ({ ...d, whenMs: d.mtimeMs }));
      }
      case 'cursor': {
        const { openStateDb, listComposerIds } = require('./parser/cursor.cjs');
        const db = openStateDb();
        if (!db) return [];
        try {
          return listComposerIds(db).map((d) => ({ ...d, whenMs: d.lastUpdatedAt || d.createdAt || 0 }));
        } finally {
          if (db && typeof db.close === 'function') db.close();
        }
      }
      default:
        return [];
    }
  } catch (e) {
    err(`  (backfill: could not enumerate ${agentSlug} sessions: ${redactHome(e.message)})`);
    return [];
  }
}

// Scan agentSlugs and window each agent's descriptors to sinceMs (null = all
// history). Returns { perAgent: [{ agent, count, oldestMs, newestMs,
// descriptors }], total }.
function scan(agentSlugs, { sinceMs } = {}) {
  const perAgent = [];
  let total = 0;
  for (const agent of agentSlugs) {
    const all = enumerate(agent);
    const kept = sinceMs == null ? all : all.filter((d) => d.whenMs >= sinceMs);
    const oldestMs = kept.length ? Math.min(...kept.map((d) => d.whenMs)) : null;
    const newestMs = kept.length ? Math.max(...kept.map((d) => d.whenMs)) : null;
    perAgent.push({ agent, count: kept.length, oldestMs, newestMs, descriptors: kept });
    total += kept.length;
  }
  return { perAgent, total };
}

// ---------------------------------------------------------------------------
// concurrency helper
// ---------------------------------------------------------------------------

// Run worker(item, index) over items with at most `concurrency` in flight.
// Resolves an array of { ok, error? } — one entry per item, in item order. A
// worker rejection is captured as { ok:false, error }; it never aborts the pool.
function asyncPool(concurrency, items, worker) {
  return new Promise((resolve) => {
    const results = new Array(items.length);
    if (items.length === 0) return resolve(results);
    const n = Math.max(1, Number.isFinite(concurrency) ? concurrency : 1);
    let nextIndex = 0;
    let completed = 0;

    const launchNext = () => {
      if (nextIndex >= items.length) return;
      const idx = nextIndex++;
      Promise.resolve()
        .then(() => worker(items[idx], idx))
        .then(() => {
          results[idx] = { ok: true };
        })
        .catch((error) => {
          results[idx] = { ok: false, error };
        })
        .finally(() => {
          completed++;
          if (completed === items.length) resolve(results);
          else launchNext();
        });
    };

    for (let i = 0; i < n && i < items.length; i++) launchNext();
  });
}

// ---------------------------------------------------------------------------
// synthetic hook + builder wiring per agent
// ---------------------------------------------------------------------------

function builderFor(agentSlug) {
  switch (agentSlug) {
    case 'claude_code':
      return collector.buildEnvelopeFromHook;
    case 'codex':
      return collector.buildCodexEnvelopeFromHook;
    case 'agy':
      return collector.buildAntigravityEnvelopeFromHook;
    case 'cursor':
      return collector.buildCursorEnvelopeFromHook;
    default:
      throw new Error(`unknown agent: ${agentSlug}`);
  }
}

function syntheticHook(agentSlug, d) {
  switch (agentSlug) {
    case 'claude_code':
      return { transcript_path: d.path, session_id: null, cwd: null, reason: 'backfill' };
    case 'codex':
      return { transcript_path: d.path, session_id: d.sessionId || null, cwd: null, reason: 'backfill' };
    case 'agy': {
      const { brainTranscriptPath } = require('./parser/antigravity_cli.cjs');
      return { transcriptPath: brainTranscriptPath(d.id), conversationId: d.id, workspacePaths: [] };
    }
    case 'cursor':
      return {
        conversation_id: d.composerId,
        transcript_path: null,
        workspace_roots: [],
        user_email: null,
        cursor_version: null,
        reason: 'backfill',
        duration_ms: null,
      };
    default:
      throw new Error(`unknown agent: ${agentSlug}`);
  }
}

// ---------------------------------------------------------------------------
// upload core
// ---------------------------------------------------------------------------

// Build + send every descriptor in perAgent (the `scan()` shape). dryRun
// collects the built envelopes instead of posting them. Calls
// onProgress({ agent, done, total }) after each session (success or failure).
// Returns { summary: [{ agent, total, sent, failed }], envelopes }. A single
// session's build/post failure is logged and counted as failed — never fatal.
// Concurrent HTTP POSTs per agent. Default concurrency is 16 (these are small
// gzipped metadata POSTs); override with ATTRIBUT_BACKFILL_CONCURRENCY. There is
// no server-side retry/backoff yet, so we don't push this arbitrarily high.
function defaultConcurrency() {
  const n = Number.parseInt(process.env.ATTRIBUT_BACKFILL_CONCURRENCY, 10);
  return Number.isInteger(n) && n > 0 ? Math.min(64, n) : 16;
}

// Backfill each provider in three phases (enumerate → preprocess → transmit),
// one provider fully before the next:
//
//   • PREPROCESS builds every envelope up front — CPU/IO-bound (transcript reads,
//     SQLite, JSON parsing). It runs UNTHROTTLED: it must not be gated by the
//     transmit concurrency, since a fast local machine can prepare far more than
//     16 at a time.
//   • TRANSMIT POSTs the built envelopes at `concurrency` (default 16) — the
//     network-bound, rate-limited phase.
//
// Separating them keeps a heavy preprocess (e.g. a big Cursor DB) from starving
// the network pipe and vice-versa. onProgress fires TWICE per session — once in
// PREPROCESS (phase:'prepare') and once in TRANSMIT (phase:'transmit'), each with
// the provider's cumulative done/total for that phase — so a bar sized to 2×total
// fills across both. Failures are counted + collected (never re-thrown, never
// printed inline — the caller summarizes them after the bar). dryRun collects
// built envelopes instead of POSTing.
async function uploadAll(perAgent, { concurrency = defaultConcurrency(), dryRun = false, onProgress } = {}) {
  const summary = [];
  const envelopes = [];
  const failures = []; // { agent, message } — surfaced as a summary by the caller

  // Keep-alive agents so the many concurrent POSTs reuse connections rather than
  // re-handshaking TCP+TLS each time (Node 18's globalAgent has keepAlive off).
  // Destroyed in the finally so their idle sockets don't delay CLI exit. Skipped
  // for dry-run (no POSTs).
  const agents = dryRun
    ? null
    : {
        http: new http.Agent({ keepAlive: true, maxSockets: concurrency }),
        https: new https.Agent({ keepAlive: true, maxSockets: concurrency }),
      };

  try {
    for (const entry of perAgent) {
      summary.push(
        await uploadProvider(entry, { concurrency, dryRun, onProgress, agents, envelopes, failures })
      );
    }
  } finally {
    if (agents) {
      agents.http.destroy();
      agents.https.destroy();
    }
  }

  return { summary, envelopes, failures };
}

// Number of PREPROCESS builds between event-loop yields. The build phase is
// synchronous and IO-heavy (full transcript reads, SQLite, JSON parse); without a
// periodic yield it blocks the single Node thread for the whole phase, freezing
// the progress bar's paint. Yielding every N keeps the UI live at negligible cost.
const PREPARE_YIELD_EVERY = 20;

// Backfill one provider in two visible phases so the progress bar never stalls:
//
//   PREPARE  — build every envelope (unthrottled CPU/IO). Emits an onProgress
//              tick per session with phase:'prepare', and yields to the event loop
//              every PREPARE_YIELD_EVERY builds so the bar actually repaints
//              instead of freezing until the phase ends.
//   TRANSMIT — POST the built envelopes at `concurrency` (or collect for dry-run).
//              Emits a tick per session with phase:'transmit'.
//
// Each session contributes EXACTLY TWO ticks total (one prepare, one transmit), so
// a caller sizing its bar to 2×total fills smoothly across both phases. A build
// failure is the one asymmetry: it can never transmit, so its transmit tick is
// emitted immediately alongside its prepare tick — keeping the 2-per-session count
// exact. Build/POST failures are counted + collected into `failures`, never thrown.
// Holds all of this provider's built envelopes in memory (~2KB each) — fine at
// realistic session counts; a multi-year `--all` on a heavy user is the only case
// that could grow large.
async function uploadProvider(entry, { concurrency, dryRun, onProgress, agents, envelopes, failures }) {
  const { agent, descriptors } = entry;
  const total = descriptors.length;
  const build = builderFor(agent);
  let prepared = 0;
  let done = 0;
  let sent = 0;
  let failed = 0;
  const tickPrepare = () => {
    prepared += 1;
    if (onProgress) onProgress({ agent, phase: 'prepare', done: prepared, total });
  };
  const tickTransmit = () => {
    done += 1;
    if (onProgress) onProgress({ agent, phase: 'transmit', done, total });
  };

  // PHASE 2 — PREPARE (unthrottled, but yields periodically so the bar repaints).
  const ready = [];
  for (let i = 0; i < descriptors.length; i++) {
    try {
      ready.push(build(syntheticHook(agent, descriptors[i]), { trigger: 'backfill', source: 'cli' }));
      tickPrepare();
    } catch (e) {
      failed += 1;
      failures.push({ agent, message: e.message });
      tickPrepare();
      tickTransmit(); // never reaches transmit — spend its transmit tick now
    }
    if ((i + 1) % PREPARE_YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
  }

  if (dryRun) {
    for (const envelope of ready) {
      envelopes.push({ agent, envelope });
      sent += 1;
      tickTransmit();
    }
    return { agent, total, sent, failed };
  }

  // PHASE 3 — TRANSMIT (rate-limited to `concurrency`).
  await asyncPool(concurrency, ready, async (envelope) => {
    try {
      await collector.postEnvelope(envelope, agent, { agents });
      sent += 1;
    } catch (e) {
      failed += 1;
      failures.push({ agent, message: e.message });
    } finally {
      tickTransmit();
    }
  });

  return { agent, total, sent, failed };
}

// ---------------------------------------------------------------------------
// shared presentation helpers
// ---------------------------------------------------------------------------

function dateStr(ms) {
  if (!ms) return '?'; // null/0 (a session with no usable timestamp) — don't print 1970
  return new Date(ms).toISOString().slice(0, 10);
}

// Per-connector session counts as a single block — used both for the clack note
// box (interactive) and printed line-by-line for the scripted path.
function scanSummaryText(result) {
  return result.perAgent
    .filter((p) => p.count > 0)
    .map(
      (p) =>
        `${AGENT_LABELS[p.agent] || p.agent}:  ${p.count} sessions  (${dateStr(p.oldestMs)} → ${dateStr(p.newestMs)})`
    )
    .join('\n');
}

function printScanSummary(result) {
  const s = scanSummaryText(result);
  if (s) out(s);
}

// Friendly, one-line note about skipped sessions — shown AFTER the success line
// so a couple of skips never read as "the whole thing failed". Categorized by
// cause; no raw errno or filesystem paths. Failures stay observable (count +
// plain-language reason) without the mess.
function failureSummary(failures) {
  if (!failures || failures.length === 0) return null;
  const n = failures.length;
  const missing = failures.filter((f) => /ENOENT|no such file/i.test(f.message || '')).length;
  const reason =
    missing === n
      ? `${n === 1 ? 'its local file was' : 'their local files were'} no longer on disk`
      : 'they could not be read locally';
  const these = n === 1 ? 'session was' : 'sessions were';
  return `${n} ${these} skipped because ${reason}. This is harmless — everything else imported, and you can re-run anytime to retry.`;
}

// Positive, no-scare summary of the run. The count of skipped sessions (if any)
// is conveyed separately by failureSummary(), so this line never says "failed".
function finalLine(summary) {
  const totalSent = summary.reduce((n, s) => n + s.sent, 0);
  const total = summary.reduce((n, s) => n + s.total, 0);
  const agentsList = summary
    .filter((s) => s.total > 0)
    .map((s) => AGENT_LABELS[s.agent] || s.agent)
    .join(', ');
  return totalSent === total
    ? `Imported all ${totalSent} sessions across ${agentsList}`
    : `Imported ${totalSent} of ${total} sessions across ${agentsList}`;
}


// ---------------------------------------------------------------------------
// interactive entry point — called by `connect` after hooks install
// ---------------------------------------------------------------------------

// Backfill pre-connect history automatically right after `connect` installs
// hooks. `connected` is [{ agent, token, endpoint }] (connect.cjs's normalized
// configs). Runs unattended over a fixed 90-day window — no opt-in prompt, no
// period picker: it announces itself in one line, then scans and imports. Silent
// no-op when not interactive, when there's nothing to backfill, or on any
// internal error — connect's success must never depend on this. `ingestBase`,
// if given, temporarily overrides INGEST_BASE for the duration of this call.
async function runBackfillInteractive({ connected, ingestBase } = {}) {
  try {
    if (!process.stdout.isTTY || !process.stdin.isTTY) return; // non-interactive / cloud — skip silently

    const agentSlugs = (connected || [])
      .map((c) => c.agent)
      .filter((a) => AGENT_SLUGS.includes(a));
    if (agentSlugs.length === 0) return;

    const prevIngestBase = process.env.INGEST_BASE;
    if (ingestBase) process.env.INGEST_BASE = ingestBase;
    try {
      // 1) Announce (no prompt). Backfill now runs automatically over the last
      // 90 days — one non-blocking line telling the user what's happening and
      // why it's safe (server dedupes by session ID), then straight into it.
      await ui.log.info(
        'Importing your last 90 days of prior local sessions — same path as live ' +
          'capture, and safe to re-run (deduplicated by session ID).'
      );
      const sinceMs = parseSince(DEFAULT_SINCE);

      // 2) Gather the docs and show the tally per connector. Scan one connector
      // at a time, updating the spinner message and yielding between each, so the
      // (synchronous, file/DB-bound) scan can't freeze the UI — the user sees
      // "Scanning Cursor…" etc. rather than a stalled spinner.
      const spin = await ui.spinner();
      spin.start('Scanning local sessions…');
      const result = { perAgent: [], total: 0 };
      for (const agent of agentSlugs) {
        spin.message(`Scanning ${AGENT_LABELS[agent] || agent}…`);
        await new Promise((r) => setImmediate(r)); // let the frame paint first
        const one = scan([agent], { sinceMs });
        result.perAgent.push(...one.perAgent);
        result.total += one.total;
      }
      spin.stop(result.total ? `Found ${result.total} sessions` : 'No prior sessions found');
      if (result.total === 0) return;
      await ui.note(scanSummaryText(result), 'Sessions to backfill');

      // 3) Upload behind a single progress bar spanning every connector's docs.
      // Each session ticks twice (prepare + transmit), so the bar is sized to
      // 2×total and the label names the current phase — otherwise the bar would
      // sit frozen at 0 through the (synchronous, IO-heavy) prepare phase.
      const bar = await ui.progressBar({ max: result.total * 2 });
      bar.start('Preparing sessions…');
      const { summary, failures } = await uploadAll(result.perAgent, {
        // Label shows the CURRENT connector's own progress (agentDone/agentTotal)
        // and phase; the bar itself fills over the global 2×total. +1 per tick.
        onProgress: ({ agent, phase, done: agentDone, total: agentTotal }) => {
          const verb = phase === 'prepare' ? 'Preparing' : 'Importing';
          bar.advance(1, `${verb} ${AGENT_LABELS[agent] || agent} — ${agentDone}/${agentTotal}`);
        },
      });
      bar.stop(finalLine(summary));
      const skipped = failureSummary(failures);
      if (skipped) await ui.log.info(skipped);
    } finally {
      if (ingestBase) {
        if (prevIngestBase === undefined) delete process.env.INGEST_BASE;
        else process.env.INGEST_BASE = prevIngestBase;
      }
    }
  } catch (e) {
    err(`  (backfill: skipped due to error: ${redactHome(e.message)})`);
  }
}

// Non-interactive backfill for the `connect --key --backfill` path. Unlike
// runBackfillInteractive it does NOT require a TTY and prints plain lines instead
// of spinners/progress bars, so it works in a scripted cloud Setup step. It only
// runs when the caller explicitly opts in (connect --backfill), so the
// ephemeral-reboot re-import concern is a deliberate choice, not a default.
// Mirrors the interactive path's INGEST_BASE handling (so --endpoint overrides
// reach the upload) and its token model (collector.postEnvelope reads the
// just-installed on-disk token). Never throws for an empty scan; a transport
// failure surfaces via the returned failure summary, not an exception.
async function runBackfillHeadless({ agents, ingestBase, sinceMs = parseSince(DEFAULT_SINCE) } = {}) {
  const agentSlugs = (agents || []).filter((a) => AGENT_SLUGS.includes(a));
  if (agentSlugs.length === 0) return;

  const prevIngestBase = process.env.INGEST_BASE;
  if (ingestBase) process.env.INGEST_BASE = ingestBase;
  try {
    const { perAgent, total } = scan(agentSlugs, { sinceMs });
    if (total === 0) {
      out('  No prior local sessions to import.');
      return;
    }
    out(`  Importing your last 90 days — ${total} prior session${total === 1 ? '' : 's'} (safe to re-run; deduplicated by session ID)…`);
    const { summary, failures } = await uploadAll(perAgent, {});
    const sent = summary.reduce((n, s) => n + s.sent, 0);
    out(`  ✓ Imported ${sent}/${total} session${total === 1 ? '' : 's'}.`);
    const skipped = failureSummary(failures);
    if (skipped) out(`  ${skipped}`);
  } finally {
    if (ingestBase) {
      if (prevIngestBase === undefined) delete process.env.INGEST_BASE;
      else process.env.INGEST_BASE = prevIngestBase;
    }
  }
}

// ---------------------------------------------------------------------------
// standalone command — `attribut backfill`
// ---------------------------------------------------------------------------

const BACKFILL_HELP = `
attribut backfill — send existing local sessions through the live capture path

Enumerates your existing local sessions for each connected tool and re-sends
them through the same envelope-build + POST path live capture uses, so
pre-connect history shows up in ATTRIBUT. Safe to re-run: the server reconciles
by sessionId (latest non-partial wins) — duplicates overwrite, never double-count.

Usage: attribut backfill [--agents=a,b] [--since=90d|<ISO>] [--all] [--yes] [--dry-run]

Options:
  --agents=<a,b>   Agents to backfill (default: every connected agent — has a
                   stored token). One or more of: ${AGENT_SLUGS.join(', ')}.
  --since=<spec>   Only sessions at/after this cutoff: "<N>d" (N days ago) or an
                   ISO date. Default: 90d.
  --all            No cutoff — backfill full history. Overrides --since.
  -y, --yes        Skip the confirmation prompt.
  --dry-run        Print the scan summary and the envelopes that WOULD be sent
                   (pretty JSON) — sends nothing.
  -h, --help       Show this help.
`;

function splitList(s) {
  if (!s) return [];
  return String(s)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseBackfillArgs(argv) {
  const r = { agents: null, since: DEFAULT_SINCE, sinceExplicit: false, all: false, yes: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agents') r.agents = splitList(argv[++i]);
    else if (a.startsWith('--agents=')) r.agents = splitList(a.slice('--agents='.length));
    else if (a === '--since') { r.since = argv[++i]; r.sinceExplicit = true; }
    else if (a.startsWith('--since=')) { r.since = a.slice('--since='.length); r.sinceExplicit = true; }
    else if (a === '--all') r.all = true;
    else if (a === '--yes' || a === '-y') r.yes = true;
    else if (a === '--dry-run') r.dryRun = true;
    else if (a === '-h' || a === '--help') r.help = true;
  }
  return r;
}

// `attribut backfill [...]`. Returns an exit code (0 ok, 2 usage error).
async function runBackfill(argv) {
  const opts = parseBackfillArgs(argv || []);
  if (opts.help) {
    out(BACKFILL_HELP.trimStart());
    return 0;
  }

  let agents;
  if (opts.agents) {
    if (opts.agents.length === 0) {
      err('--agents given with no value.');
      return 2;
    }
    agents = [];
    for (const a of opts.agents) {
      if (!AGENT_SLUGS.includes(a)) {
        err(`Unknown agent "${a}" — valid: ${AGENT_SLUGS.join(', ')}.`);
        return 2;
      }
      agents.push(a);
    }
    agents = [...new Set(agents)];
  } else {
    agents = AGENT_SLUGS.filter((slug) => !!readToken(slug));
  }
  if (agents.length === 0) {
    err('No connected agents to backfill (nothing has a stored token). Run `attribut connect` first, or pass --agents.');
    return 2;
  }

  // Interactive invocation (`attribut backfill` on a TTY without non-interactive
  // intent) → the automatic flow: announce → per-connector tally → progress bar,
  // fixed to the last 90 days (same as the post-connect run). To pick a different
  // window, pass a period flag (--since/--all), which opts into the scripted path
  // below along with the non-interactive flags (--yes/--dry-run); --agents just
  // scopes which tools and still gets the automatic flow. Tests run non-TTY, so
  // they never take this branch.
  const scripted = opts.all || opts.sinceExplicit || opts.yes || opts.dryRun;
  if (!scripted && ui.interactive()) {
    await runBackfillInteractive({ connected: agents.map((a) => ({ agent: a })) });
    return 0;
  }

  // `--since` consumed with no following value → r.since is undefined. Treat that
  // as a usage error (fail loud), consistent with `--agents`, rather than silently
  // falling back to the 90d default and backfilling the wrong window.
  if (!opts.all && opts.since === undefined) {
    err('--since given with no value (expected "<N>d", an ISO date, or use --all).');
    return 2;
  }

  let sinceMs;
  try {
    sinceMs = opts.all ? null : parseSince(opts.since);
  } catch (e) {
    err(e.message);
    return 2;
  }

  const result = scan(agents, { sinceMs });
  if (result.total === 0) {
    out('No prior sessions found to backfill.');
    return 0;
  }
  printScanSummary(result);

  if (opts.dryRun) {
    const { envelopes } = await uploadAll(result.perAgent, { dryRun: true });
    out('');
    out('Envelopes that WOULD be sent (dry run — nothing was posted):');
    out(JSON.stringify(envelopes, null, 2));
    return 0;
  }

  if (!opts.yes) {
    // Deliberately a plain Y/n line, not the polished ui.confirm flow: reaching
    // here means a scripting flag (--since/--all) was passed, i.e. a script-
    // adjacent invocation. The bare `attribut backfill` gets the polished flow.
    if (process.stdout.isTTY && process.stdin.isTTY) {
      const answer = (await ui.ask(`Backfill ${result.total} sessions to ATTRIBUT? [Y/n]: `))
        .trim()
        .toLowerCase();
      if (answer === 'n' || answer === 'no') {
        out('Skipped.');
        return 0;
      }
    } else {
      out('(non-interactive: proceeding without confirmation — pass --yes to silence this notice)');
    }
  }

  // Each session ticks twice (prepare + transmit) — bar sized to 2×total, label
  // names the phase, so the (synchronous) prepare phase shows movement too.
  const bar = await ui.progressBar({ max: result.total * 2 });
  bar.start('Preparing sessions…');
  const { summary, failures } = await uploadAll(result.perAgent, {
    onProgress: ({ agent, phase, done: agentDone, total: agentTotal }) => {
      const verb = phase === 'prepare' ? 'Preparing' : 'Importing';
      bar.advance(1, `${verb} ${AGENT_LABELS[agent] || agent} — ${agentDone}/${agentTotal}`);
    },
  });
  bar.stop(finalLine(summary));
  const skipped = failureSummary(failures);
  if (skipped) await ui.log.info(skipped);
  return 0;
}

module.exports = {
  runBackfill,
  runBackfillInteractive,
  runBackfillHeadless,
  scan,
  enumerate,
  parseSince,
  asyncPool,
  uploadAll,
  failureSummary,
  defaultConcurrency,
  AGENT_SLUGS,
};
