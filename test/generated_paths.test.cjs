'use strict';

// GENERATED-PATH EXCLUSION — machine-generated / vendored files must not count
// toward the structural line metrics (they otherwise inflate the downstream
// human-equivalent value estimate). Covers the predicate and the accumulator
// skip it gates.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isGeneratedPath,
  accumulateStructural,
  newStructAccumulator,
} = require('../src/parser/claude_code.cjs');

test('isGeneratedPath: lockfiles by basename', () => {
  for (const p of [
    '/home/u/proj/package-lock.json',
    '/home/u/proj/pnpm-lock.yaml',
    '/home/u/proj/yarn.lock',
    '/home/u/proj/poetry.lock',
    '/home/u/proj/Cargo.lock', // case-insensitive
    '/home/u/proj/go.sum',
  ]) {
    assert.equal(isGeneratedPath(p), true, p);
  }
});

test('isGeneratedPath: vendored / build directory segments', () => {
  for (const p of [
    '/home/u/proj/node_modules/left-pad/index.js',
    '/home/u/proj/dist/bundle.js',
    '/home/u/proj/build/out.css',
    '/home/u/proj/.next/server/chunk.js',
    '/home/u/proj/vendor/pkg/x.go',
    '/home/u/proj/__pycache__/mod.cpython-312.pyc',
    '/home/u/proj/__snapshots__/Comp.test.js.snap',
  ]) {
    assert.equal(isGeneratedPath(p), true, p);
  }
});

test('isGeneratedPath: generated suffixes', () => {
  for (const p of [
    '/p/app.min.js',
    '/p/styles.min.css',
    '/p/bundle.js.map',
    '/p/Comp.test.tsx.snap',
    '/p/schema_pb2.py',
    '/p/api.pb.go',
    '/p/types.generated.ts',
  ]) {
    assert.equal(isGeneratedPath(p), true, p);
  }
});

test('isGeneratedPath: genuine source is NOT excluded', () => {
  for (const p of [
    '/home/u/proj/src/app.ts',
    '/home/u/proj/lib/data/real.ts',
    '/home/u/proj/build.sh', // file named build*, not a build/ dir
    '/home/u/proj/out.txt', // file named out*, not an out/ dir
    '/home/u/proj/distance.py', // not dist/
    '/home/u/proj/package.json', // manifest, not the lockfile
    '',
    null,
  ]) {
    assert.equal(isGeneratedPath(p), false, String(p));
  }
});

test('accumulateStructural: a generated file contributes ZERO lines', () => {
  const struct = newStructAccumulator();
  accumulateStructural(
    {
      filePath: '/home/u/proj/package-lock.json',
      structuredPatch: [{ lines: ['+  "x": 1,', '+  "y": 2,', '-  "z": 3,'] }],
    },
    struct,
  );
  assert.equal(struct.lines_code_added, 0);
  assert.equal(struct.lines_code_removed, 0);
  assert.equal(struct.added_char_n, 0);
});

test('accumulateStructural: a genuine source file still counts', () => {
  const struct = newStructAccumulator();
  accumulateStructural(
    {
      filePath: '/home/u/proj/src/app.js',
      structuredPatch: [{ lines: ['+const x = 1;', '+const y = 2;', '-const z = 3;'] }],
    },
    struct,
  );
  assert.equal(struct.lines_code_added, 2);
  assert.equal(struct.lines_code_removed, 1);
});
