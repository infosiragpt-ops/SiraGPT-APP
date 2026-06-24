'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { provisionWorkspace, gitCommitAll } = require('../src/services/codex/workspace');

function fakeRunner({ execResults = {} } = {}) {
  const calls = [];
  return {
    calls,
    initWorkspace: async (project) => { calls.push(['initWorkspace', project]); return { ok: true }; },
    writeFiles: async (project, files) => { calls.push(['writeFiles', project, files]); return { ok: true, written: files.length }; },
    exec: async (project, cmd) => {
      calls.push(['exec', project, cmd]);
      const key = cmd.join(' ');
      for (const [pattern, result] of Object.entries(execResults)) {
        if (key.includes(pattern)) return result;
      }
      if (key.includes('rev-parse')) return { ok: true, exitCode: 0, stdout: 'abc123\n', stderr: '' };
      return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

test('provisionWorkspace runs init → write starter → git add/commit → rev-parse', async () => {
  const runner = fakeRunner();
  const out = await provisionWorkspace({ project: 'p1', projectName: 'Demo', runner });
  assert.equal(out.workspacePath, 'projects/p1');
  assert.equal(out.commitSha, 'abc123');
  const kinds = runner.calls.map((c) => c[0]);
  assert.deepEqual(kinds, ['initWorkspace', 'writeFiles', 'exec', 'exec', 'exec']);
  const writtenPaths = runner.calls[1][2].map((f) => f.path);
  assert.ok(writtenPaths.includes('package.json'));
  const execCmds = runner.calls.filter((c) => c[0] === 'exec').map((c) => c[2].join(' '));
  assert.match(execCmds[0], /^git add -A$/);
  assert.match(execCmds[1], /git .*commit .*workspace inicial/);
  assert.match(execCmds[2], /git rev-parse HEAD/);
});

test('git commit failures throw with the failing label and stderr detail', async () => {
  const runner = fakeRunner({
    execResults: { 'commit': { ok: false, exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } },
  });
  await assert.rejects(
    () => provisionWorkspace({ project: 'p1', projectName: 'Demo', runner }),
    /git commit failed \(exit 128\).*not a git repository/,
  );
});

test('gitCommitAll returns the trimmed HEAD sha', async () => {
  const runner = fakeRunner();
  const sha = await gitCommitAll(runner, 'p9', 'feat: checkpoint');
  assert.equal(sha, 'abc123');
});
