'use strict';

// The minimal TOML array-of-tables emitter/merger (src/toml.cjs). Verifies we can
// emit `[[hooks.<Event>]]` with a nested `[[…​.hooks]]` command, upsert our own
// entries idempotently, and preserve user-authored blocks + the preamble verbatim.

const test = require('node:test');
const assert = require('node:assert');

const toml = require('../src/toml.cjs');

const SPEC = {
  keys: { matcher: '.*' },
  nested: { name: 'hooks', entries: [{ type: 'command', command: "node '/abs/collector.cjs' --provider openai posttooluse" }] },
};

test('emitArrayTable renders header, scalar keys, and nested array-of-tables', () => {
  const out = toml.emitArrayTable('hooks.PostToolUse', SPEC);
  assert.match(out, /^\[\[hooks\.PostToolUse\]\]$/m);
  assert.match(out, /^matcher = "\.\*"$/m);
  assert.match(out, /^\[\[hooks\.PostToolUse\.hooks\]\]$/m);
  assert.match(out, /^type = "command"$/m);
  assert.match(out, /--provider openai posttooluse/);
});

test('Stop entry with no scalar keys emits only the nested hook', () => {
  const stop = { nested: { name: 'hooks', entries: [{ type: 'command', command: 'X' }] } };
  const out = toml.emitArrayTable('hooks.Stop', stop);
  assert.match(out, /^\[\[hooks\.Stop\]\]$/m);
  assert.ok(!/matcher/.test(out));
  assert.match(out, /^\[\[hooks\.Stop\.hooks\]\]$/m);
});

test('upsert into empty source produces a valid, newline-terminated block', () => {
  const out = toml.upsertArrayTables('', 'hooks.PostToolUse', [SPEC], () => false);
  assert.match(out, /\[\[hooks\.PostToolUse\]\]/);
  assert.ok(out.endsWith('\n'));
});

test('upsert preserves preamble + user blocks, replaces only OUR entries', () => {
  const src = [
    'model = "gpt-5.5"',
    '',
    '[[hooks.PostToolUse]]',
    'matcher = "^Bash$"',
    '[[hooks.PostToolUse.hooks]]',
    'type = "command"',
    'command = "echo user-owned"',
  ].join('\n');
  const isOurs = (text) => text.includes('/abs/collector.cjs');

  const once = toml.upsertArrayTables(src, 'hooks.PostToolUse', [SPEC], isOurs);
  assert.match(once, /model = "gpt-5\.5"/); // preamble kept
  assert.match(once, /echo user-owned/); // user hook kept
  assert.match(once, /--provider openai posttooluse/); // ours added

  // Idempotency: re-upsert → exactly ONE of our entries (user hook still there).
  const twice = toml.upsertArrayTables(once, 'hooks.PostToolUse', [SPEC], isOurs);
  const ours = (twice.match(/--provider openai posttooluse/g) || []).length;
  assert.strictEqual(ours, 1);
  assert.match(twice, /echo user-owned/);
});

test('splitBlocks keeps nested [[a.b]] inside its parent array element', () => {
  const src = ['[[hooks.Stop]]', '[[hooks.Stop.hooks]]', 'type = "command"', 'command = "X"'].join('\n');
  const { blocks } = toml.splitBlocks(src);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].kind, 'array');
  assert.strictEqual(blocks[0].name, 'hooks.Stop');
  assert.match(blocks[0].text, /hooks\.Stop\.hooks/);
});

test('removeArrayTables drops only our elements and counts them', () => {
  const src = toml.upsertArrayTables(
    '[[hooks.Stop]]\nmatcher = "user"\n',
    'hooks.Stop',
    [{ nested: { name: 'hooks', entries: [{ type: 'command', command: "node '/abs/collector.cjs' stop" }] } }],
    () => false
  );
  const { text, removed } = toml.removeArrayTables(src, 'hooks.Stop', (t) => t.includes('/abs/collector.cjs'));
  assert.strictEqual(removed, 1);
  assert.match(text, /matcher = "user"/); // the user's Stop element survives
  assert.ok(!text.includes('/abs/collector.cjs'));
});

test('serializeValue handles strings, booleans, numbers, inline tables', () => {
  assert.strictEqual(toml.serializeValue('a"b'), '"a\\"b"');
  assert.strictEqual(toml.serializeValue(true), 'true');
  assert.strictEqual(toml.serializeValue(30), '30');
  assert.strictEqual(toml.serializeValue({ a: 1, b: 'x' }), '{ a = 1, b = "x" }');
  assert.throws(() => toml.serializeValue(undefined));
});
