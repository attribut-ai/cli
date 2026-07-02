'use strict';

// Cursor parser: reads the state.vscdb composerData/bubbles (numbers + model id
// only) + the transcript (tool-use names only) into the frozen cursorPayload.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { buildCursorFixture } = require('./fixtures/cursor/build_db.cjs');

function withDb(fixture, fn) {
  const prev = process.env.CURSOR_STATE_DB;
  process.env.CURSOR_STATE_DB = fixture.dbPath;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CURSOR_STATE_DB;
    else process.env.CURSOR_STATE_DB = prev;
    try {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// require AFTER we can set env per-test; the module reads env lazily per call.
const cursor = require('../src/parser/cursor.cjs');

const CID = '11111111-1111-1111-1111-111111111111';

function baseSpec(over = {}) {
  return Object.assign(
    {
      composerId: CID,
      model: 'claude-4.5-sonnet-thinking',
      usageData: { 'claude-4.5-sonnet-thinking': { costInCents: 15, amount: 1 } },
      contextTokensUsed: 52357,
      contextTokenLimit: 200000,
      contextUsagePercent: 26.17,
      totalLinesAdded: 716,
      totalLinesRemoved: 197,
      filesChangedCount: 2,
      createdAt: 1762653135831,
      lastUpdatedAt: 1762656899770,
      bubbles: [
        { type: 1, inputTokens: 0, outputTokens: 0 },
        { type: 2, inputTokens: 12766, outputTokens: 1079 },
        { type: 2, inputTokens: 21223, outputTokens: 5810 },
      ],
      transcript: [
        { role: 'user', message: { content: [{ type: 'text', text: 'hi' }] } },
        {
          role: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'ok' },
              { type: 'tool_use', name: 'Shell', input: { command: 'ls' } },
              { type: 'tool_use', name: 'Read', input: {} },
            ],
          },
        },
      ],
    },
    over
  );
}

test('parses model, cost, context, tokens, LOC, turns, tools from a full session', () => {
  const fx = buildCursorFixture(baseSpec());
  withDb(fx, () => {
    const p = cursor.parseCursorSession({ composerId: CID, transcriptPath: fx.transcriptPath, repo: '/tmp/x' });
    assert.strictEqual(p.sessionId, CID);
    assert.strictEqual(p.model, 'claude-4.5-sonnet-thinking');
    assert.strictEqual(p.cursor.cost_cents, 15);
    assert.strictEqual(p.cursor.cost_amount, 1);
    assert.strictEqual(p.cursor.context_tokens, 52357);
    assert.strictEqual(p.cursor.context_token_limit, 200000);
    assert.strictEqual(p.cursor.output_tokens, 1079 + 5810);
    assert.strictEqual(p.cursor.input_tokens_cumulative, 12766 + 21223);
    assert.strictEqual(p.cursor.priced_turns, 2);
    assert.strictEqual(p.cursor.lines_added, 716);
    assert.strictEqual(p.cursor.lines_removed, 197);
    assert.strictEqual(p.cursor.files_changed, 2);
    assert.strictEqual(p.num_turns, 2); // two type-2 headers
    assert.deepStrictEqual(p.tool_uses, [{ name: 'Shell', count: 1 }, { name: 'Read', count: 1 }]);
    assert.strictEqual(p.num_tool_calls, 2);
    // billed in/out left null (server derives), classified structural fields null
    assert.strictEqual(p.tokens_in, null);
    assert.strictEqual(p.tokens_out, null);
    assert.strictEqual(p.lines_code_added, null);
    assert.strictEqual(p.started_at, new Date(1762653135831).toISOString());
    assert.strictEqual(p.duration_ms, 1762656899770 - 1762653135831);
  });
});

test('no usageData → cost fields null, never fabricated', () => {
  const spec = baseSpec({ usageData: {} });
  const fx = buildCursorFixture(spec);
  withDb(fx, () => {
    const p = cursor.parseCursorSession({ composerId: CID, transcriptPath: fx.transcriptPath });
    assert.strictEqual(p.cursor.cost_cents, null);
    assert.strictEqual(p.cursor.cost_amount, null);
    // other signal still present
    assert.strictEqual(p.cursor.context_tokens, 52357);
    assert.strictEqual(p.model, 'claude-4.5-sonnet-thinking');
  });
});

test('"default" model resolves to null (not free text)', () => {
  const fx = buildCursorFixture(baseSpec({ model: 'default' }));
  withDb(fx, () => {
    const p = cursor.parseCursorSession({ composerId: CID, transcriptPath: fx.transcriptPath });
    assert.strictEqual(p.model, null);
  });
});

test('context-compaction reset (cumulative input drops) is summed per-turn, not as a delta', () => {
  // b2=100000, b3 resets to 5000 after compaction. Per-turn sum = 105000 (not a
  // negative delta, not the pre-reset peak).
  const spec = baseSpec({
    bubbles: [
      { type: 2, inputTokens: 100000, outputTokens: 10 },
      { type: 2, inputTokens: 5000, outputTokens: 20 },
    ],
  });
  const fx = buildCursorFixture(spec);
  withDb(fx, () => {
    const p = cursor.parseCursorSession({ composerId: CID, transcriptPath: fx.transcriptPath });
    assert.strictEqual(p.cursor.input_tokens_cumulative, 105000);
    assert.strictEqual(p.cursor.output_tokens, 30);
    assert.strictEqual(p.cursor.priced_turns, 2);
  });
});

test('subagents from subComposerIds are nested (numbers + model only)', () => {
  const spec = baseSpec({
    subagents: [
      {
        composerId: 'sub-aaaa',
        model: 'composer-2.5',
        usageData: {},
        contextTokensUsed: 8000,
        totalLinesAdded: 10,
        totalLinesRemoved: 1,
        createdAt: 1762653135831,
        lastUpdatedAt: 1762653200000,
        bubbles: [{ type: 2, inputTokens: 3000, outputTokens: 400 }],
      },
    ],
  });
  const fx = buildCursorFixture(spec);
  withDb(fx, () => {
    const p = cursor.parseCursorSession({ composerId: CID, transcriptPath: fx.transcriptPath });
    assert.strictEqual(p.cursor.subagents.length, 1);
    const s = p.cursor.subagents[0];
    assert.strictEqual(s.composer_id, 'sub-aaaa');
    assert.strictEqual(s.model, 'composer-2.5');
    assert.strictEqual(s.output_tokens, 400);
    assert.strictEqual(s.input_tokens_cumulative, 3000);
    assert.strictEqual(s.context_tokens, 8000);
    assert.strictEqual(s.lines_added, 10);
  });
});

test('missing DB / unknown composer degrades to a minimal payload (never throws)', () => {
  const prev = process.env.CURSOR_STATE_DB;
  process.env.CURSOR_STATE_DB = '/nonexistent/state.vscdb';
  try {
    const p = cursor.parseCursorSession({ composerId: CID, transcriptPath: null });
    assert.strictEqual(p.sessionId, CID);
    assert.strictEqual(p.model, null);
    assert.strictEqual(p.cursor.context_tokens, null);
    assert.deepStrictEqual(p.tool_uses, []);
  } finally {
    if (prev === undefined) delete process.env.CURSOR_STATE_DB;
    else process.env.CURSOR_STATE_DB = prev;
  }
});

test('resolveComposerId prefers conversation_id, falls back to transcript basename', () => {
  assert.strictEqual(cursor.resolveComposerId({ conversationId: 'abc' }), 'abc');
  assert.strictEqual(
    cursor.resolveComposerId({ transcriptPath: '/x/y/deadbeef.jsonl' }),
    'deadbeef'
  );
  assert.strictEqual(cursor.resolveComposerId({}), null);
});
