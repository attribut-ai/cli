'use strict';

// Collector hook→envelope path for Antigravity: maps agy's hook stdin
// (conversationId/transcriptPath/workspacePaths) into a validated
// google/antigravity envelope and injects usage_raw from the token store.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const collector = require('../src/collector.cjs');
const { buildSyntheticDb } = require('./fixtures/agy/build_db.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'agy', 'transcript_full.jsonl');

let nodeSqlite = false;
try {
  const { getDatabaseClass } = require('../src/parser/antigravity_tokens.cjs');
  if (getDatabaseClass()) {
    nodeSqlite = true;
  }
} catch {
  nodeSqlite = false;
}

test('buildAntigravityEnvelopeFromHook tags google/antigravity + maps hook fields', () => {
  const hook = {
    conversationId: 'conv-xyz',
    transcriptPath: FIXTURE,
    workspacePaths: ['/work/repo'],
    stepIdx: 7,
    toolCall: null,
    error: '',
  };
  const env = collector.buildAntigravityEnvelopeFromHook(hook, {
    trigger: 'posttooluse',
    source: 'cli',
  });
  assert.strictEqual(env.provider, 'google');
  assert.strictEqual(env.tool, 'antigravity');
  assert.strictEqual(env._trigger, 'posttooluse');
  assert.strictEqual(env.payload.sessionId, 'conv-xyz');
  assert.strictEqual(env.payload.repo, '/work/repo');
  assert.deepStrictEqual(env.payload.commitSHA, ['a1b2c3d']);
});

test('missing transcriptPath throws (caller swallows on the hot path)', () => {
  assert.throws(() =>
    collector.buildAntigravityEnvelopeFromHook(
      { conversationId: 'x' },
      { trigger: 'posttooluse', source: 'cli' }
    )
  );
});

test('usage_raw is injected from the token store when the DB exists', { skip: !nodeSqlite }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-coll-'));
  const prev = process.env.AGY_CONVERSATIONS_DIR;
  process.env.AGY_CONVERSATIONS_DIR = dir;
  try {
    buildSyntheticDb(dir, 'conv-coll', { input: 4321, output: 21 });
    const env = collector.buildAntigravityEnvelopeFromHook(
      { conversationId: 'conv-coll', transcriptPath: FIXTURE, workspacePaths: ['/r'] },
      { trigger: 'posttooluse', source: 'cli' }
    );
    assert.ok(env.payload.antigravity.usage_raw, 'usage_raw injected');
    assert.strictEqual(env.payload.antigravity.usage_raw['1.4.2'], 4321);
  } finally {
    if (prev === undefined) delete process.env.AGY_CONVERSATIONS_DIR;
    else process.env.AGY_CONVERSATIONS_DIR = prev;
  }
});

test('usage_raw is null (not fatal) when the DB is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-coll-none-'));
  const prev = process.env.AGY_CONVERSATIONS_DIR;
  process.env.AGY_CONVERSATIONS_DIR = dir;
  try {
    const env = collector.buildAntigravityEnvelopeFromHook(
      { conversationId: 'no-db', transcriptPath: FIXTURE, workspacePaths: ['/r'] },
      { trigger: 'posttooluse', source: 'cli' }
    );
    assert.strictEqual(env.payload.antigravity.usage_raw, null);
  } finally {
    if (prev === undefined) delete process.env.AGY_CONVERSATIONS_DIR;
    else process.env.AGY_CONVERSATIONS_DIR = prev;
  }
});
