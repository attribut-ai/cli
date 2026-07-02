'use strict';

// Tests for `attribut audit` — the runnable privacy proof.
//
// The audit module is the ADVERSARY of the parser: it pulls the prohibited
// content out of the transcript and asserts none of it survives into the
// payload. These tests prove (1) it extracts real content (so a PASS is
// meaningful, not an empty scan), (2) it reports the clean golden fixture as
// leak-free, and (3) the leak scanner actually FAILS when a field carries
// content — including the title exclusion and the minimum-length floor.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const audit = require('../src/audit.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'synthetic.jsonl');

test('analyze() extracts real sensitive content from the transcript', () => {
  const { sensitive } = audit.analyze(FIXTURE);
  // The golden fixture plants secrets in prompts, responses, tool args, diffs,
  // subagent bodies and commit bodies. If extraction found nothing, a later
  // "0 leaks" result would be vacuous.
  assert.ok(sensitive.length > 0, 'expected sensitive strings to be extracted');
  const corpus = sensitive.join('\n');
  for (const s of ['SECRET_PROMPT_TEXT', 'ASSISTANT_RESPONSE_BODY', 'TOOL_INPUT_SECRET_ARG_NEW']) {
    assert.ok(corpus.includes(s), `expected extraction to capture ${s}`);
  }
});

test('the clean golden payload scans leak-free', () => {
  const { payload, sensitive } = audit.analyze(FIXTURE);
  const { leaks } = audit.scanForLeaks(payload, sensitive);
  assert.deepStrictEqual(leaks, [], 'golden payload must not leak any content');
});

test('scanForLeaks FLAGS a non-title field carrying verbatim content', () => {
  const leaked = 'this is a forty-plus character secret prompt body!!';
  assert.ok(leaked.length >= audit.MIN_LEAK_LEN);
  const payload = { repo: leaked, title: 'safe' };
  const { leaks } = audit.scanForLeaks(payload, [leaked]);
  assert.strictEqual(leaks.length, 1);
  assert.strictEqual(leaks[0].field, 'repo');
});

test('scanForLeaks does NOT flag a metadata label that merely appears inside content', () => {
  // Regression: `repo` (a cwd path), `branch`, and tool `name` are allowlisted
  // labels that naturally occur as substrings of prompts/tool inputs. A label
  // sitting inside content is expected, not a leak — only a field CONTAINING a
  // body slice is.
  const repo = '/Users/atc/Code/ATTRIBUT/app/.claude/worktrees/onboarding-page';
  const name = 'mcp__plugin_compound-engineering_context7__query-docs';
  const payload = { repo, tool_uses: [{ name }] };
  const sensitive = [
    `please cd into ${repo} and run the tests before pushing`,
    `I'll call ${name} to fetch the docs for that library now`,
  ];
  const { leaks } = audit.scanForLeaks(payload, sensitive);
  assert.deepStrictEqual(leaks, [], 'a label inside prose is not a content leak');
});

test('scanForLeaks EXCLUDES the content-derived title field', () => {
  const titleText = 'a forty-plus character title echoing content here';
  assert.ok(titleText.length >= audit.MIN_LEAK_LEN);
  const payload = { title: titleText };
  const { leaks } = audit.scanForLeaks(payload, [titleText]);
  assert.deepStrictEqual(leaks, [], 'title is the authorized content-derived exception');
});

test('scanForLeaks ignores short coincidental overlaps below the length floor', () => {
  const shortOverlap = 'claude-opus-4-8'; // a metadata value that also appears in text
  assert.ok(shortOverlap.length < audit.MIN_LEAK_LEN);
  const payload = { model: shortOverlap };
  const { leaks } = audit.scanForLeaks(payload, [`the model was ${shortOverlap} today`]);
  assert.deepStrictEqual(leaks, [], 'sub-floor overlaps are noise, not leaks');
});

test('sensitiveStringsFromRow reaches prompt text, tool inputs and results', () => {
  const sink = [];
  audit.sensitiveStringsFromRow(
    {
      message: {
        content: [
          { type: 'text', text: 'x'.repeat(50) },
          { type: 'tool_use', input: { cmd: 'y'.repeat(50) } },
          { type: 'tool_result', content: 'z'.repeat(50) },
        ],
      },
      toolUseResult: { stdout: 'w'.repeat(50) },
    },
    sink
  );
  assert.strictEqual(sink.length, 4, 'text, tool_use input, tool_result, toolUseResult');
});
