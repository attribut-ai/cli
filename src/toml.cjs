'use strict';

// Minimal hand-written TOML emitter/merger — JUST enough to upsert our own
// `[[hooks.<Event>]]` array-of-tables into ~/.codex/config.toml while preserving
// every other section (and the user's own hooks) byte-for-byte. Zero deps (no
// toml library anywhere in this package).
//
// We deliberately do NOT implement a general TOML parser. The strategy is to
// split the file into top-level BLOCKS (each `[section]` or `[[array]]` element,
// with its nested `[[a.b]]` children kept inside the element), drop only the
// blocks WE own, and append freshly-emitted ones. Comments and formatting inside
// every other block survive untouched.

/**
 * Serialize a JS value to a TOML value literal. Supports the subset we emit:
 * string, boolean, finite number, and nested inline tables (plain objects).
 * Throws loudly on anything unsupported rather than emitting garbage.
 */
function serializeValue(v) {
  if (typeof v === 'string') return JSON.stringify(v); // TOML basic string == JSON string for our keys
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const inner = Object.entries(v)
      .map(([k, val]) => `${serializeKey(k)} = ${serializeValue(val)}`)
      .join(', ');
    return `{ ${inner} }`;
  }
  throw new Error(`Cannot serialize TOML value of type ${typeof v}: ${String(v)}`);
}

/**
 * Serialize a TOML key. Bare keys (letters, digits, `_`, `-`) are written as-is;
 * anything else is quoted.
 */
function serializeKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

const HEADER_RE = /^\s*\[\s*([^\]]+?)\s*\]\s*$/;
const ARRAY_HEADER_RE = /^\s*\[\[\s*([^\]]+?)\s*\]\]\s*$/;

/**
 * Emit one `[[<arrayName>]]` table element from a spec describing its top-level
 * scalar keys plus an optional nested array-of-tables. Shape:
 *   { keys: { matcher: ".*" }, nested: { name: "hooks", entries: [ {type, command} ] } }
 * Returns the block text WITHOUT a trailing newline.
 */
function emitArrayTable(arrayName, spec) {
  const lines = [`[[${arrayName}]]`];
  for (const [k, v] of Object.entries(spec.keys || {})) {
    lines.push(`${serializeKey(k)} = ${serializeValue(v)}`);
  }
  if (spec.nested && Array.isArray(spec.nested.entries)) {
    const nestedName = `${arrayName}.${spec.nested.name}`;
    for (const entry of spec.nested.entries) {
      lines.push(`[[${nestedName}]]`);
      for (const [k, v] of Object.entries(entry)) {
        lines.push(`${serializeKey(k)} = ${serializeValue(v)}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Split TOML source into a preamble (text before the first header) plus an
 * ordered list of `{ kind, name, text }` BLOCKS, where each block is either a
 * single `[section]` (kind:"table") or a `[[array]]` element (kind:"array"). A
 * block's text runs from its header line up to (but not including) the next
 * top-level header. A nested `[[a.b]]` header that belongs to the current array
 * element is kept inside that element (detected by the dotted-prefix match).
 */
function splitBlocks(src) {
  const lines = String(src).split('\n');
  const preamble = [];
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const am = line.match(ARRAY_HEADER_RE);
    const tm = line.match(HEADER_RE);
    // A nested array header (`[[parent.child]]`) continues the current array block.
    if (
      am &&
      current &&
      current.kind === 'array' &&
      am[1].trim().startsWith(current.name + '.')
    ) {
      current.lines.push(line);
      continue;
    }
    if (am) {
      if (current) blocks.push(current);
      current = { kind: 'array', name: am[1].trim(), lines: [line] };
    } else if (tm) {
      if (current) blocks.push(current);
      current = { kind: 'table', name: tm[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) blocks.push(current);
  return {
    preamble: preamble.join('\n'),
    blocks: blocks.map((b) => ({ kind: b.kind, name: b.name, text: b.lines.join('\n') })),
  };
}

/**
 * Replace ALL existing `[[<arrayName>]]` elements that we own with a fresh set,
 * preserving every other block (and the preamble) verbatim. Ownership is decided
 * by `isOurs(text)` — a predicate run on each existing array element's full text
 * (so we drop only OUR prior hook entries and keep user-authored ones).
 *
 * @param {string}   src        existing file contents ("" when absent)
 * @param {string}   arrayName  e.g. "hooks.PostToolUse"
 * @param {object[]} specs      one spec per element (see emitArrayTable)
 * @param {(text:string)=>boolean} isOurs  identifies our prior elements to drop
 * @returns {string} new file contents, newline-terminated
 */
function upsertArrayTables(src, arrayName, specs, isOurs) {
  const { preamble, blocks } = splitBlocks(src);

  // Drop our prior elements of this exact array; keep everything else.
  const kept = blocks.filter((b) => {
    if (b.kind === 'array' && b.name === arrayName && isOurs(b.text)) return false;
    return true;
  });

  const fresh = specs.map((s) => emitArrayTable(arrayName, s));

  const parts = [];
  const pre = preamble.replace(/\s+$/, '');
  if (pre !== '') parts.push(pre);
  for (const b of kept) parts.push(b.text.replace(/\s+$/, ''));
  for (const f of fresh) parts.push(f);

  return parts.join('\n\n') + '\n';
}

/**
 * Remove ALL `[[<arrayName>]]` elements we own, preserving everything else.
 * Returns { text, removed } where `removed` counts the dropped elements.
 */
function removeArrayTables(src, arrayName, isOurs) {
  const { preamble, blocks } = splitBlocks(src);
  let removed = 0;
  const kept = blocks.filter((b) => {
    if (b.kind === 'array' && b.name === arrayName && isOurs(b.text)) {
      removed += 1;
      return false;
    }
    return true;
  });
  const parts = [];
  const pre = preamble.replace(/\s+$/, '');
  if (pre !== '') parts.push(pre);
  for (const b of kept) parts.push(b.text.replace(/\s+$/, ''));
  const text = parts.length ? parts.join('\n\n') + '\n' : '';
  return { text, removed };
}

module.exports = {
  serializeValue,
  serializeKey,
  emitArrayTable,
  splitBlocks,
  upsertArrayTables,
  removeArrayTables,
};
