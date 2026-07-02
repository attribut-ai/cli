'use strict';

// CLASSIFY TEST — the line-anchored comment state machine has the subtlest logic
// in the parser. Cover block open/close across lines, unterminated blocks, line
// comments, code, and blanks.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classify, syntaxForPath } = require('../src/parser/claude_code.cjs');

const JS = syntaxForPath('file.js'); // { l: ['//'], b: [['/*','*/']] }

test('single-line block comment opens and closes on the same line', () => {
  const state = { open: null };
  assert.equal(classify('/* one liner */', JS, state), 'comment');
  assert.equal(state.open, null); // closed
});

test('multi-line block: open line, interior lines, and the closing line', () => {
  const state = { open: null };
  assert.equal(classify('/* start', JS, state), 'comment');
  assert.equal(state.open, '*/'); // still open
  assert.equal(classify('   still inside', JS, state), 'comment');
  assert.equal(classify('end */ const x = 1;', JS, state), 'comment'); // closes here
  assert.equal(state.open, null);
  assert.equal(classify('const y = 2;', JS, state), 'code'); // back to code
});

test('an unterminated block keeps subsequent lines as comments', () => {
  const state = { open: null };
  assert.equal(classify('/* never closed', JS, state), 'comment');
  assert.equal(classify('a', JS, state), 'comment');
  assert.equal(classify('b', JS, state), 'comment');
  assert.equal(state.open, '*/');
});

test('line comments, code, and blanks', () => {
  const state = { open: null };
  assert.equal(classify('// just a comment', JS, state), 'comment');
  assert.equal(classify('const x = 1; // trailing', JS, state), 'code'); // // not first token
  assert.equal(classify('   ', JS, state), 'blank');
  assert.equal(classify('', JS, state), 'blank');
  assert.equal(classify('return 42;', JS, state), 'code');
});

test('unknown extension treats every non-blank line as code', () => {
  const NONE = syntaxForPath('data.bin');
  const state = { open: null };
  assert.equal(classify('# not a comment here', NONE, state), 'code');
  assert.equal(classify('', NONE, state), 'blank');
});
