'use strict';

const { execSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  resolveCommit,
  applyGitCommitFromDeployedTree,
} = require('../src/utils/deployed-tree-commit');

test('resolveCommit ignores malformed env when git is absent', () => {
  const commit = resolveCommit({ GIT_COMMIT: 'not-a-git-sha' }, { gitSha: null });
  assert.notEqual(commit, 'not-a-git-sha');
  assert.match(commit, /^(unknown|[0-9a-f]{40})$/i);
});

test('resolveCommit uses a valid build-injected SHA when git is absent', () => {
  const commit = 'a4f15ce9a4f15ce9a4f15ce9a4f15ce9a4f15ce9';
  assert.equal(resolveCommit({ GIT_COMMIT: commit }, { gitSha: null }), commit);
});

test('resolveCommit prefers the deployed tree SHA over a stale GIT_COMMIT', () => {
  const stale = 'a4f15ce9a4f15ce9a4f15ce9a4f15ce9a4f15ce9';
  const live = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.equal(resolveCommit({ GIT_COMMIT: stale }, { gitSha: live }), live);
});

test('resolveCommit rejects short commit identifiers', () => {
  const commit = resolveCommit({ GIT_COMMIT: 'a4f15ce' }, { gitSha: null });
  assert.notEqual(commit, 'a4f15ce');
  assert.equal(commit, 'unknown');
});

test('boot overwrites leftover GIT_COMMIT with the deployed tree SHA', () => {
  const stale = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const env = { GIT_COMMIT: stale };
  const missing = applyGitCommitFromDeployedTree({
    env,
    roots: [path.join(os.tmpdir(), 'siragpt-no-git-' + Date.now())],
  });
  assert.equal(missing, null);
  assert.equal(env.GIT_COMMIT, stale);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-git-'));
  try {
    execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', {
      cwd: repo,
      stdio: 'ignore',
    });
    const head = execSync('git rev-parse HEAD', { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .toLowerCase();
    const applied = applyGitCommitFromDeployedTree({ env, root: repo });
    assert.equal(applied, head);
    assert.equal(env.GIT_COMMIT, head);
    assert.notEqual(env.GIT_COMMIT, stale);
    assert.match(head, /^[0-9a-f]{40}$/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('version route and env loader call the live deployed-tree helper', () => {
  const version = fs.readFileSync(path.join(__dirname, '../src/routes/version.js'), 'utf8');
  const loadEnv = fs.readFileSync(path.join(__dirname, '../src/config/load-env.js'), 'utf8');
  assert.match(version, /utils\/deployed-tree-commit/);
  assert.match(version, /resolveCommit\(/);
  assert.match(loadEnv, /applyGitCommitFromDeployedTree\(/);
});
