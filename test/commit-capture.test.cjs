'use strict';

// COMMIT-SHA CAPTURE TEST — the collector must learn a commit's SHA from git
// plumbing (`git rev-parse HEAD`) even when `git commit -q` leaves NO `[branch
// sha]` line in the transcript for the parser to scrape. Covers the command
// classifier, the commit-directory resolver, the per-session sidecar, the merge,
// and a real end-to-end quiet commit in a throwaway repo.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.ATTRIBUT_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-commit-'));
const collector = require('../src/collector.cjs');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function freshRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribut-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t.com');
  git(dir, 'config', 'user.name', 't');
  return dir;
}

test('isGitCommitCommand: matches real commits, rejects look-alikes', () => {
  const yes = [
    'git commit -m x',
    'git commit -q -F - <<EOF',
    'git add -A && git commit -m "msg"',
    'cd /tmp/x && git commit --amend --no-edit',
    "git -C /tmp/x commit -m 'y'",
  ];
  const no = [
    'git commit-graph write', // plumbing subcommand, not a commit
    'git commit --dry-run', // produces no commit
    'git commit --help',
    'gh pr create',
    'echo "remember to git push"',
    'git log --oneline',
  ];
  for (const c of yes) assert.equal(collector.isGitCommitCommand(c), true, c);
  for (const c of no) assert.equal(collector.isGitCommitCommand(c), false, c);
});

test('commitDirFromCommand: -C wins, single cd wins, multi-cd is ambiguous', () => {
  assert.equal(collector.commitDirFromCommand('git -C /a/b commit -m x', '/home'), '/a/b');
  assert.equal(
    collector.commitDirFromCommand('cd /repo && git add -A && git commit -m x', '/home'),
    '/repo'
  );
  assert.equal(collector.commitDirFromCommand('git commit -m x', '/home/cwd'), '/home/cwd');
  // relative cd resolves against the hook cwd
  assert.equal(collector.commitDirFromCommand('cd sub && git commit', '/home/cwd'), '/home/cwd/sub');
  // two cds → can't pin the commit's dir → null (caller skips capture)
  assert.equal(collector.commitDirFromCommand('cd /a && git commit; cd /b', '/home'), null);
});

test('mergeShas dedups short vs full form of the same commit', () => {
  const full = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  assert.deepEqual(collector.mergeShas(['a1b2c3d'], [full]), ['a1b2c3d']);
  assert.deepEqual(collector.mergeShas([], [full]), [full]);
  assert.deepEqual(collector.mergeShas(['deadbee'], [full]), ['deadbee', full]);
});

test('revParseHead reads HEAD; null on a non-repo', () => {
  const repo = freshRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'first');
  const head = git(repo, 'rev-parse', 'HEAD');
  assert.equal(collector.revParseHead(repo), head);
  assert.equal(collector.revParseHead(fs.mkdtempSync(path.join(os.tmpdir(), 'notrepo-'))), null);
});

test('captureCommitSha records a -q commit the parser would miss', () => {
  const repo = freshRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hi');
  // The agent pattern that broke attribution: cd into a sibling repo, quiet commit.
  const hook = {
    session_id: 'sess-capture',
    tool_name: 'Bash',
    cwd: '/some/other/session/cwd',
    tool_input: { command: `cd ${repo} && git add -A && git commit -q -m "quiet"` },
  };
  // Stage+commit happens for real here (the collector only reads HEAD, so do the
  // commit first to mirror PostToolUse firing AFTER the command completed).
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'quiet');
  const head = git(repo, 'rev-parse', 'HEAD');

  assert.equal(collector.captureCommitSha(hook), true); // new SHA recorded
  assert.deepEqual(collector.readCapturedShas('sess-capture'), [head]);
  assert.equal(collector.captureCommitSha(hook), false); // same HEAD → not re-recorded

  collector.clearCapturedShas('sess-capture');
  assert.deepEqual(collector.readCapturedShas('sess-capture'), []);
});

test('captureCommitSha ignores non-Bash and non-commit commands', () => {
  assert.equal(
    collector.captureCommitSha({ session_id: 's', tool_name: 'Read', tool_input: {} }),
    false
  );
  assert.equal(
    collector.captureCommitSha({
      session_id: 's',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    }),
    false
  );
});
