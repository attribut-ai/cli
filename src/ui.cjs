'use strict';

const readline = require('readline');

// Polished terminal UI for the user-facing `attribut connect` flow, backed by
// @clack/prompts. Two hard rules:
//
//   1. clack is ESM-only; these files are CommonJS. We load it via a cached
//      dynamic import() — never a top-level require — so it stays off the module
//      graph of the collector HOT PATH (the hook invocations). Only `connect`,
//      an explicit interactive user action, ever pulls clack in.
//   2. Everything degrades. If the clack import fails, every helper falls back to
//      plain stdout / readline; clack's own renderers already no-op their
//      animation when stdout isn't a TTY (CI, pipes), so output stays clean there
//      too. selectAgents() throws on import failure so the caller can use its own
//      numbered-prompt fallback. Polish is never load-bearing.

// ── ASCII wordmark ──────────────────────────────────────────────────────────
// Two widths so the banner never wraps: ANSI Shadow (needs ~62 cols) and a
// compact Small font (~40 cols). Below that we print a plain label. String.raw
// keeps the Small font's backslashes intact.
const BANNER_WIDE = String.raw`
 █████╗ ████████╗████████╗██████╗ ██╗██████╗ ██╗   ██╗████████╗
██╔══██╗╚══██╔══╝╚══██╔══╝██╔══██╗██║██╔══██╗██║   ██║╚══██╔══╝
███████║   ██║      ██║   ██████╔╝██║██████╔╝██║   ██║   ██║
██╔══██║   ██║      ██║   ██╔══██╗██║██╔══██╗██║   ██║   ██║
██║  ██║   ██║      ██║   ██║  ██║██║██████╔╝╚██████╔╝   ██║
╚═╝  ╚═╝   ╚═╝      ╚═╝   ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝    ╚═╝
`;
const BANNER_NARROW = String.raw`
    _ _____ _____ ___ ___ ___ _   _ _____
   /_\_   _|_   _| _ \_ _| _ ) | | |_   _|
  / _ \| |   | | |   /| || _ \ |_| | | |
 /_/ \_\_|   |_| |_|_\___|___/\___/  |_|
`;

const TAGLINE = 'thin, auditable telemetry for AI coding agents';

// ── color ───────────────────────────────────────────────────────────────────
// Honor NO_COLOR / non-TTY. Accent is a calm cyan; dim for secondary text.
function colorOn() {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}
function paint(code, s) {
  return colorOn() ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const accent = (s) => paint('38;5;44', s); // cyan
const dim = (s) => paint('2', s);

// ── clack loader ─────────────────────────────────────────────────────────────
let clackPromise = null;
function loadClack() {
  if (!clackPromise) clackPromise = import('@clack/prompts');
  return clackPromise;
}

// True only when we can drive an interactive prompt at all.
function interactive() {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

function write(msg) {
  process.stdout.write(`${msg}\n`);
}

// ── public helpers ───────────────────────────────────────────────────────────

// Render the wordmark + tagline, sized to the current terminal. No-op cost is
// trivial; safe to call unconditionally at the top of `connect`.
function showBanner() {
  const cols = process.stdout.columns || 80;
  const art = cols >= 64 ? BANNER_WIDE : cols >= 42 ? BANNER_NARROW : null;
  write('');
  if (art) write(accent(art.replace(/^\n|\n$/g, '')));
  else write(accent('  A T T R I B U T'));
  write(dim(`  ${TAGLINE}`));
  write('');
}

// clack intro/outro framing — plain fallback when clack is unavailable.
async function intro(message) {
  try {
    const p = await loadClack();
    p.intro(message);
  } catch {
    write(message);
  }
}

async function outro(message) {
  try {
    const p = await loadClack();
    p.outro(message);
  } catch {
    write(`\n${message}`);
  }
}

// A boxed note (used for the Open/Code approval details).
async function note(body, title) {
  try {
    const p = await loadClack();
    p.note(body, title);
  } catch {
    if (title) write(`\n${title}`);
    write(body);
  }
}

const log = {
  async success(msg) {
    try {
      (await loadClack()).log.success(msg);
    } catch {
      write(`✓ ${msg}`);
    }
  },
  async info(msg) {
    try {
      (await loadClack()).log.info(msg);
    } catch {
      write(msg);
    }
  },
  async step(msg) {
    try {
      (await loadClack()).log.step(msg);
    } catch {
      write(msg);
    }
  },
  async warn(msg) {
    try {
      (await loadClack()).log.warn(msg);
    } catch {
      process.stderr.write(`! ${msg}\n`);
    }
  },
  async error(msg) {
    try {
      (await loadClack()).log.error(msg);
    } catch {
      process.stderr.write(`✗ ${msg}\n`);
    }
  },
};

// A spinner wrapper that no-ops cleanly when clack is unavailable, so callers
// can always call start()/stop() without guarding.
async function spinner() {
  try {
    const p = await loadClack();
    const s = p.spinner();
    return {
      start: (m) => s.start(m),
      message: (m) => s.message(m),
      stop: (m) => s.stop(m), // clack's stop() always renders the success symbol
      error: (m) => s.error(m), // red ✗ for a failure stop
    };
  } catch {
    return {
      start: (m) => m && write(m),
      message: (m) => m && write(m),
      stop: (m) => m && write(m),
      error: (m) => m && process.stderr.write(`${m}\n`),
    };
  }
}

// One-line readline question (fallback when clack is unavailable).
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    });
  });
}

// Yes/no prompt. Returns true/false, or null if the user cancelled (clack only).
// `initialValue` sets the default (Enter / empty input).
async function confirm(message, initialValue = true) {
  try {
    const p = await loadClack();
    const v = await p.confirm({ message, initialValue });
    return p.isCancel(v) ? null : v;
  } catch {
    const hint = initialValue ? 'Y/n' : 'y/N';
    const a = (await ask(`${message} [${hint}]: `)).trim().toLowerCase();
    if (a === '') return initialValue;
    return a[0] === 'y';
  }
}

// Single-choice prompt. `options` is [{ value, label, hint? }]. Returns the
// chosen value, or null if cancelled. `initialValue` is the pre-highlighted /
// default option value.
async function select(message, options, initialValue) {
  try {
    const p = await loadClack();
    const v = await p.select({ message, options, initialValue });
    return p.isCancel(v) ? null : v;
  } catch {
    write(message);
    options.forEach((o, i) => {
      const def = o.value === initialValue ? ' (default)' : '';
      write(`  ${i + 1}) ${o.label}${def}`);
    });
    const defIdx = Math.max(0, options.findIndex((o) => o.value === initialValue)) + 1;
    const a = (await ask(`Enter a number [default ${defIdx}]: `)).trim();
    if (a === '') return options[defIdx - 1].value;
    const n = parseInt(a, 10);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
    return options[defIdx - 1].value;
  }
}

// A determinate progress bar over `max` steps. Returns { start, advance, stop }.
// Falls back to a single \r-updated line (TTY) or silence (piped).
async function progressBar({ max }) {
  try {
    const p = await loadClack();
    const bar = p.progress({ max });
    return {
      start: (m) => bar.start(m),
      advance: (n, m) => bar.advance(n, m),
      stop: (m) => bar.stop(m),
    };
  } catch {
    let cur = 0;
    return {
      start: (m) => m && write(m),
      advance: (n, m) => {
        cur += n;
        if (process.stdout.isTTY) process.stdout.write(`\r  ${m || 'Working'} — ${cur}/${max}`);
      },
      stop: (m) => {
        if (process.stdout.isTTY) process.stdout.write('\n');
        if (m) write(m);
      },
    };
  }
}

// Interactive multi-select of installable agents. Returns the chosen slugs, or
// null if the user cancelled (Ctrl-C / Esc). THROWS if clack cannot be loaded so
// the caller can fall back to its numbered prompt. `agents` is [{slug,label}].
async function selectAgents(agents) {
  const p = await loadClack(); // throws on failure → caller falls back
  const selected = await p.multiselect({
    message: 'Which tools on this device should ATTRIBUT capture?',
    options: agents.map((a) => ({ value: a.slug, label: a.label, hint: a.slug })),
    initialValues: agents.map((a) => a.slug), // default: capture all
    required: true,
  });
  if (p.isCancel(selected)) {
    p.cancel('Connect cancelled — nothing was changed.');
    return null;
  }
  return selected;
}

module.exports = {
  showBanner,
  intro,
  outro,
  note,
  log,
  spinner,
  confirm,
  select,
  progressBar,
  selectAgents,
  interactive,
  ask,
};
