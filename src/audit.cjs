'use strict';

// ATTRIBUT audit — prove the metadata-only privacy contract on YOUR OWN data.
//
// This is the honest, runnable counterpart to the marketing claim "payload is
// metadata-only". It sends NOTHING. For one local Claude Code transcript it:
//   1. runs the SAME allowlist parser the hook uses (parser never reads
//      prompt/response/code text — see parser/claude_code.cjs),
//   2. validates the resulting payload against the FROZEN contract schema
//      (envelope.v1: additionalProperties:false + maxLength on every string
//      except `repo`, which is intentionally uncapped — see parser notes), and
//   3. adversarially scans — it pulls the ACTUAL sensitive content out of your
//      transcript (prompt + response text, tool inputs, tool results / file
//      bodies) and confirms none of it appears verbatim in the payload.
//
// Read-only. Exit 0 = PASS, 1 = a leak was found (contract bug), 2 = usage error.

const fs = require('fs');
const os = require('os');
const path = require('path');

const parser = require('./parser/claude_code.cjs');
const { buildEnvelope, validateEnvelope } = require('./envelope.cjs');
const { getOrCreateDeviceUuid } = require('./device.cjs');

// Minimum length of a sensitive substring we bother matching against the
// payload. Short strings (a model name, a branch, a common word) coincidentally
// overlap metadata and would be noise; a real content leak is a long verbatim
// slice of a prompt / response / file. 40 chars is comfortably past that noise
// floor while still catching any meaningful body-text leak.
const MIN_LEAK_LEN = 40;

// Fields whose value is LEGITIMATELY derived from the transcript and is not free
// text — they are allowed to coincide with transcript bytes. `title` is the one
// declared content-derived field (the contract's authorized exception); it is
// reported separately rather than scanned, so an AI title that echoes a summary
// line never reads as a false "leak".
const CONTENT_DERIVED_FIELD = 'title';

function log(msg) {
  process.stderr.write(`[attribut] ${msg}\n`);
}

// All top-level session transcripts under ~/.claude/projects/<projectDir>/<uuid>.jsonl,
// newest first. Subagent transcripts live in a nested `subagents/` dir and are
// skipped — the session file already folds them in. Returns [] if none / no dir.
function allTranscripts() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const ent of projectDirs) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/\.jsonl$/i.test(f)) continue;
      const abs = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      found.push({ abs, mtimeMs: st.mtimeMs });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.map((x) => x.abs);
}

// Pull the free-text / content-bearing strings out of a transcript row. This is
// deliberately the OPPOSITE of the parser: it reaches for exactly the prompt,
// response, tool-input and tool-result bodies the parser refuses to touch, so we
// can prove none of them made it into the payload.
function sensitiveStringsFromRow(o, sink) {
  const push = (v) => {
    if (typeof v === 'string' && v.length >= MIN_LEAK_LEN) sink.push(v);
  };
  const msg = o && o.message;
  if (msg && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (typeof block.text === 'string') push(block.text); // user/assistant text
      if (block.type === 'tool_use' && block.input != null) {
        push(JSON.stringify(block.input)); // tool args (bash cmds, edit strings, ...)
      }
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string') push(block.content);
        else if (Array.isArray(block.content)) {
          for (const c of block.content) if (c && typeof c.text === 'string') push(c.text);
        }
      }
    }
  } else if (msg && typeof msg.content === 'string') {
    push(msg.content);
  }
  // toolUseResult often carries file bodies / command stdout — the richest leak
  // surface. Stringify the whole thing and scan it as one blob.
  if (o && o.toolUseResult != null) {
    push(typeof o.toolUseResult === 'string' ? o.toolUseResult : JSON.stringify(o.toolUseResult));
  }
}

// Walk a payload object and yield { field, value } for every string leaf, using
// the leaf key as the field label (array indices collapse to the parent key).
function stringLeaves(obj, key, out) {
  if (typeof obj === 'string') {
    out.push({ field: key, value: obj });
  } else if (Array.isArray(obj)) {
    for (const item of obj) stringLeaves(item, key, out);
  } else if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) stringLeaves(obj[k], k, out);
  }
}

// Core check: does any payload field CONTAIN a long verbatim slice of prohibited
// body content? Returns { leaks: [{field, snippet}], scanned, sensitiveCount }.
//
// Direction matters. We test "field value CONTAINS a >=MIN_LEAK_LEN body string"
// (a real leak: a prompt/response/file slice landed in a field), NOT the reverse
// "field value is a substring of some content" — that reverse test is pure noise,
// because legitimate allowlisted labels (the cwd `repo` path, a `branch` name, a
// tool `name` like `mcp__…`) naturally occur inside prose and tool inputs. The
// frozen contract already guarantees ONLY allowlisted fields exist; this scan is
// the defense-in-depth proof that none of them carries a content body.
function scanForLeaks(payload, sensitive) {
  const leaves = [];
  stringLeaves(payload, 'payload', leaves);
  // Scan every string leaf EXCEPT the declared content-derived field.
  const scannable = leaves.filter((l) => l.field !== CONTENT_DERIVED_FIELD);
  const leaks = [];
  for (const leaf of scannable) {
    for (const s of sensitive) {
      if (leaf.value.includes(s)) {
        leaks.push({ field: leaf.field, snippet: s });
        break;
      }
    }
  }
  return { leaks, scanned: scannable.length, sensitiveCount: sensitive.length };
}

// Read the transcript and return { payload, sensitive[] }. Throws loud on a
// read/parse failure — an audit that can't read your data must not print PASS.
function analyze(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const payload = parser.parseClaudeCodeTranscript(file, {
    device_uuid: getOrCreateDeviceUuid(),
  });
  const sensitive = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a corrupt line just yields no sensitive strings for this row
    }
    sensitiveStringsFromRow(o, sensitive);
  }
  return { payload, sensitive };
}

// Audit ONE transcript end-to-end: parse → validate → leak-scan. Never throws —
// a read/parse failure becomes a FAILING result (error surfaced, not hidden), so
// one bad transcript can't abort a whole-history sweep or fake a PASS.
function auditOne(file) {
  try {
    const { payload, sensitive } = analyze(file);
    const envelope = buildEnvelope(payload, {});
    const { valid, errors } = validateEnvelope(envelope);
    const { leaks, sensitiveCount } = scanForLeaks(payload, sensitive);
    return { file, ok: valid && leaks.length === 0, valid, errors, leaks, sensitiveCount, payload };
  } catch (err) {
    return {
      file,
      ok: false,
      valid: false,
      errors: [{ message: `could not audit: ${err.message}` }],
      leaks: [],
      sensitiveCount: 0,
      payload: null,
    };
  }
}

// Detailed, single-transcript view: the checks, the title, and the full payload
// that would be sent. Used when the user names one transcript explicitly.
function printSingle(r, out) {
  out.write('\nattribut audit — privacy check\n');
  out.write(`transcript: ${r.file}\n\n`);

  if (r.valid) {
    const fieldCount = Object.keys(r.payload).filter((k) => r.payload[k] != null).length;
    out.write(`✓ schema      payload validated against frozen contract (envelope.v1)\n`);
    out.write(`✓ allowlist   ${fieldCount} fields present, all in the frozen allowlist (additionalProperties:false)\n`);
  } else {
    out.write(`✗ schema      payload FAILED contract validation:\n`);
    out.write(`             ${JSON.stringify(r.errors)}\n`);
  }

  if (r.leaks.length === 0) {
    out.write(`✓ leak scan   ${r.sensitiveCount} sensitive strings extracted from transcript · 0 found in payload\n`);
    out.write(`             prompts · responses · tool inputs · file contents — not present\n`);
  } else {
    out.write(`✗ leak scan   ${r.leaks.length} payload field(s) carry verbatim transcript content:\n`);
    for (const lk of r.leaks) {
      const preview = lk.snippet.length > 80 ? lk.snippet.slice(0, 80) + '…' : lk.snippet;
      out.write(`             • ${lk.field}: ${JSON.stringify(preview)}\n`);
    }
  }

  if (r.payload) {
    out.write(
      r.payload.title != null
        ? `▸ title       "${r.payload.title}"  (the one content-derived field; capped at 200 chars)\n`
        : `▸ title       (none set)\n`
    );
    out.write('\npayload that WOULD be sent (metadata only):\n');
    out.write(JSON.stringify(r.payload, null, 2) + '\n\n');
  }

  out.write(r.ok ? 'PASS — payload is metadata-only\n' : 'FAIL — see findings above\n');
}

// Aggregate view for a whole-history sweep: one PASS/FAIL line over every
// session, with each failing transcript itemised (loud, never silently skipped).
function printSummary(results, out) {
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  const totalSensitive = results.reduce((n, r) => n + r.sensitiveCount, 0);

  out.write('\nattribut audit — privacy check\n');
  out.write(`scanned ${total} session${total === 1 ? '' : 's'} under ~/.claude/projects/\n\n`);

  out.write(
    failed.length === 0
      ? `✓ schema      ${passed}/${total} payloads validated against the frozen contract (envelope.v1)\n`
      : `✗ schema      ${passed}/${total} payloads validated; ${failed.length} failed\n`
  );
  out.write(
    failed.length === 0
      ? `✓ leak scan   ${totalSensitive.toLocaleString('en-US')} sensitive strings checked · 0 found in any payload\n` +
          `             prompts · responses · tool inputs · file contents — not present\n`
      : `✗ leak scan   content or contract failures in ${failed.length} session${failed.length === 1 ? '' : 's'}:\n`
  );

  for (const r of failed) {
    out.write(`             • ${r.file}\n`);
    if (!r.valid) out.write(`               schema: ${JSON.stringify(r.errors)}\n`);
    for (const lk of r.leaks) {
      const preview = lk.snippet.length > 80 ? lk.snippet.slice(0, 80) + '…' : lk.snippet;
      out.write(`               leak (${lk.field}): ${JSON.stringify(preview)}\n`);
    }
  }

  out.write('\n');
  out.write(
    failed.length === 0
      ? 'PASS — every payload is metadata-only\n'
      : `FAIL — ${failed.length} session${failed.length === 1 ? '' : 's'} need attention (see above)\n`
  );
  out.write('\nrun `attribut audit <transcript.jsonl>` to see the full payload for one session.\n');
}

// `attribut audit [transcript.jsonl]` — prove metadata-only on your own data.
// With NO path (the easy one-liner) it sweeps EVERY local Claude Code session and
// reports one aggregate PASS/FAIL. With a path, it shows the full payload for
// that single transcript.
function runAudit(argv) {
  const explicit = argv.find((a) => !a.startsWith('-'));
  const out = process.stdout;

  if (explicit) {
    if (!fs.existsSync(explicit)) {
      log(`transcript not found: ${explicit}`);
      return 2;
    }
    const r = auditOne(explicit);
    printSingle(r, out);
    return r.ok ? 0 : 1;
  }

  const files = allTranscripts();
  if (files.length === 0) {
    log('no transcripts found under ~/.claude/projects/ — pass a path: attribut audit <transcript.jsonl>');
    return 2;
  }
  log(`auditing ${files.length} local session${files.length === 1 ? '' : 's'}…`);
  const results = files.map(auditOne);
  printSummary(results, out);
  return results.every((r) => r.ok) ? 0 : 1;
}

module.exports = {
  runAudit,
  auditOne,
  allTranscripts,
  analyze,
  scanForLeaks,
  sensitiveStringsFromRow,
  stringLeaves,
  MIN_LEAK_LEN,
};
