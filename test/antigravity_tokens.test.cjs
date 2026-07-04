'use strict';

// The fail-safe Antigravity token reader: numbers-only extraction, graceful
// degradation, read-only, and the CONTENT-NEVER-LEAKS guarantee.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tokens = require('../src/parser/antigravity_tokens.cjs');
const { buildSyntheticDb } = require('./fixtures/agy/build_db.cjs');

let nodeSqlite = false;
try {
  const { getDatabaseClass } = require('../src/parser/antigravity_tokens.cjs');
  if (getDatabaseClass()) {
    nodeSqlite = true;
  }
} catch {
  nodeSqlite = false;
}

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tok-'));
  const prev = process.env.AGY_CONVERSATIONS_DIR;
  process.env.AGY_CONVERSATIONS_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.AGY_CONVERSATIONS_DIR;
    else process.env.AGY_CONVERSATIONS_DIR = prev;
  }
}

test('dbPathFor basename-guards against traversal', () => {
  // Pure traversal ids resolve to null.
  assert.strictEqual(tokens.dbPathFor('..'), null);
  assert.strictEqual(tokens.dbPathFor(''), null);
  // A traversal path is neutralized to its basename — never escapes the dir.
  const p = tokens.dbPathFor('../../etc/passwd');
  assert.ok(p.endsWith(path.sep + 'passwd.db'), p);
  assert.ok(!p.includes(`${path.sep}etc${path.sep}`), p);
  // A clean id resolves under the conversations dir.
  assert.ok(tokens.dbPathFor('abc').endsWith('abc.db'));
});

test('readUsageRaw returns null for a missing DB (fail-safe)', () => {
  withDir(() => {
    assert.strictEqual(tokens.readUsageRaw('does-not-exist'), null);
  });
});

test('readUsageRaw extracts per-generation token varints by dotted path', { skip: !nodeSqlite }, () => {
  withDir((dir) => {
    buildSyntheticDb(dir, 'conv-tok', { input: 1234, output: 567 });
    const u = tokens.readUsageRaw('conv-tok');
    assert.ok(u, 'expected a usage_raw object');
    assert.strictEqual(u['1.4.2'], 1234); // input/prompt
    assert.strictEqual(u['1.4.3'], 567); // output
  });
});

test('readUsageRaw SUMS usage across generation rows; skips the big embedding row', { skip: !nodeSqlite }, () => {
  withDir((dir) => {
    buildSyntheticDb(dir, 'conv-sum', {
      rows: [
        { input: 1000, output: 100 },
        { input: 2000, output: 250 },
      ],
      bigRow: true, // must be skipped — its values + sentinel must not appear
    });
    const u = tokens.readUsageRaw('conv-sum');
    assert.strictEqual(u['1.4.2'], 3000); // 1000 + 2000
    assert.strictEqual(u['1.4.3'], 350); // 100 + 250
    assert.ok(!JSON.stringify(u).includes('BIG_ROW_CONTENT_SECRET'));
    assert.ok(!Object.values(u).includes(9999999), 'big-row varint leaked');
  });
});

test('CONTENT NEVER LEAKS: the DB string sentinel is absent from usage_raw', { skip: !nodeSqlite }, () => {
  withDir((dir) => {
    buildSyntheticDb(dir, 'conv-priv', {
      input: 100,
      output: 9,
      contentSentinel: 'DB_CONTENT_SECRET_LEAK',
    });
    const u = tokens.readUsageRaw('conv-priv');
    const serialized = JSON.stringify(u);
    assert.ok(!serialized.includes('DB_CONTENT_SECRET_LEAK'), `LEAK: ${serialized}`);
    // every value is an integer; every key is a numeric dotted path
    for (const [k, v] of Object.entries(u)) {
      assert.match(k, /^[0-9]+(\.[0-9]+)*$/, `bad key ${k}`);
      assert.ok(Number.isInteger(v), `non-int value at ${k}: ${v}`);
    }
  });
});

test('readUsageRaw returns null on a corrupt DB (fail-safe)', { skip: !nodeSqlite }, () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'conv-bad.db'), 'not a sqlite file at all');
    assert.strictEqual(tokens.readUsageRaw('conv-bad'), null);
  });
});

test('looksLikeMessage rejects plain text (so strings are skipped)', () => {
  assert.strictEqual(tokens.looksLikeMessage(Buffer.from('hello world this is text')), false);
});

test('readModel returns the priced model id from gen_metadata', { skip: !nodeSqlite }, () => {
  withDir((dir) => {
    buildSyntheticDb(dir, 'conv-model', { input: 10, output: 2, model: 'gemini-3-flash-a' });
    assert.strictEqual(tokens.readModel('conv-model'), 'gemini-3-flash-a');
  });
});

test('readModel returns null when no model id is present / DB missing', { skip: !nodeSqlite }, () => {
  withDir((dir) => {
    // model value has no gemini-/claude- token, so nothing matches.
    buildSyntheticDb(dir, 'conv-nomodel', { input: 1, output: 1, model: 'xx-not-a-model' });
    assert.strictEqual(tokens.readModel('conv-nomodel'), null);
    assert.strictEqual(tokens.readModel('does-not-exist'), null);
  });
});

test('readTitle returns the generated title (path 30.4) and NEVER the prompt', { skip: !nodeSqlite }, () => {
  withDir((dir) => {
    buildSyntheticDb(dir, 'conv-title', {
      input: 1,
      output: 1,
      title: 'Create Hello World Script',
      prompt: 'SECRET_PROMPT_AT_30_5 do a thing with secrets',
    });
    assert.strictEqual(tokens.readTitle('conv-title'), 'Create Hello World Script');
    // The adjacent prompt (path 30.5) must never be emitted.
    assert.ok(!String(tokens.readTitle('conv-title')).includes('SECRET_PROMPT'));
  });
});

test('readTitle returns null when absent / DB missing', { skip: !nodeSqlite }, () => {
  withDir((dir) => {
    buildSyntheticDb(dir, 'conv-notitle', { input: 1, output: 1 });
    assert.strictEqual(tokens.readTitle('conv-notitle'), null);
    assert.strictEqual(tokens.readTitle('nope'), null);
  });
});

// readParentId requires a real UUID at path 5 (guards against false positives).
const PARENT = '11111111-1111-1111-1111-111111111111';
const KID_A = '22222222-2222-2222-2222-222222222222';
const KID_B = '33333333-3333-3333-3333-333333333333';
const OTHER = '44444444-4444-4444-4444-444444444444';

test('readParentId: child returns parent; parent/normal return null', { skip: !nodeSqlite }, () => {
  withDir((dir) => {
    buildSyntheticDb(dir, PARENT, { input: 1, output: 1 });
    buildSyntheticDb(dir, KID_A, { input: 1, output: 1, parentId: PARENT });
    assert.strictEqual(tokens.readParentId(KID_A), PARENT);
    assert.strictEqual(tokens.readParentId(PARENT), null);
    assert.strictEqual(tokens.readParentId('missing'), null);
  });
});

test('findChildren reverse-scans the conversations dir', { skip: !nodeSqlite }, () => {
  withDir((dir) => {
    buildSyntheticDb(dir, PARENT, { input: 1, output: 1 });
    buildSyntheticDb(dir, KID_A, { input: 1, output: 1, parentId: PARENT });
    buildSyntheticDb(dir, KID_B, { input: 1, output: 1, parentId: PARENT });
    buildSyntheticDb(dir, OTHER, { input: 1, output: 1 });
    assert.deepStrictEqual(tokens.findChildren(PARENT).sort(), [KID_A, KID_B].sort());
    assert.deepStrictEqual(tokens.findChildren(OTHER), []);
  });
});

test('readUsageInputOutput maps the semantic token paths', { skip: !nodeSqlite }, () => {
  withDir((dir) => {
    buildSyntheticDb(dir, 'u', { input: 1234, output: 567 });
    assert.deepStrictEqual(tokens.readUsageInputOutput('u'), { input: 1234, output: 567 });
  });
});

test('readAgentType matches a known candidate name in the child', { skip: !nodeSqlite }, () => {
  withDir((dir) => {
    buildSyntheticDb(dir, 'c', { input: 1, output: 1, agentType: 'security-reviewer' });
    assert.strictEqual(
      tokens.readAgentType('c', ['performance-reviewer', 'security-reviewer']),
      'security-reviewer'
    );
    // an unknown candidate set → null (never returns free text)
    assert.strictEqual(tokens.readAgentType('c', ['nope']), null);
  });
});

// Title shape-guard: the title is the ONE agy field emitting arbitrary UTF-8 read
// from a fixed protobuf path. If an upstream field renumber ever pointed that path
// at prompt/response/code body text, the guard must reject it (multi-line / control
// chars) so body text never leaves the machine.
test('looksLikeTitle accepts single-line summaries, rejects body-text shapes', () => {
  assert.strictEqual(tokens.looksLikeTitle('Refactor the auth module'), true);
  assert.strictEqual(tokens.looksLikeTitle('Fix bug (edge case)'), true);
  assert.strictEqual(tokens.looksLikeTitle(''), false);
  assert.strictEqual(tokens.looksLikeTitle('line one\nline two'), false); // multi-line prompt/response
  assert.strictEqual(tokens.looksLikeTitle('const x = 1;\nfoo();'), false); // code body
  assert.strictEqual(tokens.looksLikeTitle('has\ttab'), false); // control char
  assert.strictEqual(tokens.looksLikeTitle(null), false);
});
