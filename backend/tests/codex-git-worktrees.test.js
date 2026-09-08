'use strict';

/**
 * Offline tests for run-scoped git worktrees (CODEX_RUN_WORKTREES, plan A1).
 * A fake runner records every exec argv; no network, no real git.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RUN_WORKTREES_DIRNAME,
  runWorktreesEnabled,
  runWorktreeRelPath,
  resolveRunCwd,
  startRunWorktree,
  removeRunWorktree,
} = require('../src/services/codex/git-workflow');
const { resolveToolPath } = require('../src/services/codex/build-tools');

const ENV_ON = { CODEX_RUN_WORKTREES: '1' };
const ENV_OFF = {};

/**
 * Fake runner: `script` maps a command prefix (joined argv) to a result or a
 * function of argv. First matching prefix wins; unmatched commands succeed
 * with empty output. Every call is recorded for argv assertions.
 */
function fakeRunner(script = {}, { withWriteFiles = true } = {}) {
  const calls = [];
  const writes = [];
  const runner = {
    calls,
    writes,
    async exec(projectId, argv) {
      calls.push({ projectId, argv });
      const joined = argv.join(' ');
      for (const [prefix, out] of Object.entries(script)) {
        if (joined.startsWith(prefix)) {
          return typeof out === 'function' ? out(argv) : out;
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  if (withWriteFiles) {
    runner.writeFiles = async (projectId, files) => {
      writes.push({ projectId, files });
      return { ok: true };
    };
  }
  return runner;
}

function execCommands(runner) {
  return runner.calls.map((c) => c.argv.join(' '));
}

test('flag gate: runWorktreesEnabled is explicit opt-in, default OFF', () => {
  assert.equal(runWorktreesEnabled(ENV_OFF), false);
  assert.equal(runWorktreesEnabled({ CODEX_RUN_WORKTREES: '' }), false);
  assert.equal(runWorktreesEnabled({ CODEX_RUN_WORKTREES: '0' }), false);
  assert.equal(runWorktreesEnabled({ CODEX_RUN_WORKTREES: 'off' }), false);
  // NODE_ENV=production alone must NOT flip it on (default OFF everywhere).
  assert.equal(runWorktreesEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(runWorktreesEnabled({ CODEX_RUN_WORKTREES: '1' }), true);
  assert.equal(runWorktreesEnabled({ CODEX_RUN_WORKTREES: 'true' }), true);
  assert.equal(runWorktreesEnabled({ CODEX_RUN_WORKTREES: 'on' }), true);
  assert.equal(runWorktreesEnabled({ CODEX_RUN_WORKTREES: 'YES' }), true);
});

test('startRunWorktree creates the worktree inside the workspace with -b run/<id>', async () => {
  const runner = fakeRunner({
    'git worktree list --porcelain': { exitCode: 0, stdout: 'worktree /work/p1\nHEAD abc\nbranch refs/heads/main\n', stderr: '' },
    'git show-ref --verify --quiet refs/heads/run/r1': { exitCode: 1, stdout: '', stderr: '' },
    'git worktree add': { exitCode: 0, stdout: '', stderr: '' },
  });

  const result = await startRunWorktree({
    runner,
    projectId: 'p1',
    runId: 'r1',
    baseBranch: 'main',
    env: ENV_ON,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.worktree, true);
  assert.equal(result.resumed, false);
  assert.equal(result.runBranch, 'run/r1');
  assert.equal(result.worktreeDir, `${RUN_WORKTREES_DIRNAME}/wt-r1`);

  const commands = execCommands(runner);
  assert.ok(commands.includes(`git worktree add ${RUN_WORKTREES_DIRNAME}/wt-r1 -b run/r1 main`),
    `expected worktree add, got: ${commands.join(' | ')}`);
  // The relative path keeps the worktree inside the project workspace.
  assert.ok(result.worktreeDir.startsWith('.sira-worktrees/'));
  assert.ok(!result.worktreeDir.includes('..'));
  // Self-ignore written so the base checkout's status stays clean.
  assert.equal(runner.writes.length, 1);
  assert.deepEqual(runner.writes[0].files, [{ path: `${RUN_WORKTREES_DIRNAME}/.gitignore`, content: '*\n' }]);
});

test('startRunWorktree reattaches an existing run branch without -b', async () => {
  const runner = fakeRunner({
    'git worktree list --porcelain': { exitCode: 0, stdout: 'worktree /work/p1\n', stderr: '' },
    'git show-ref --verify --quiet refs/heads/run/r2': { exitCode: 0, stdout: '', stderr: '' },
    'git worktree add': { exitCode: 0, stdout: '', stderr: '' },
  });

  const result = await startRunWorktree({ runner, projectId: 'p1', runId: 'r2', env: ENV_ON });
  assert.equal(result.ok, true);
  const commands = execCommands(runner);
  assert.ok(commands.includes(`git worktree add ${RUN_WORKTREES_DIRNAME}/wt-r2 run/r2`));
  assert.ok(!commands.some((c) => c.includes(' -b ')));
});

test('startRunWorktree resumes when the worktree is already registered', async () => {
  const runner = fakeRunner({
    'git worktree list --porcelain': {
      exitCode: 0,
      stdout: `worktree /work/p1\nbranch refs/heads/main\n\nworktree /work/p1/${RUN_WORKTREES_DIRNAME}/wt-r3\nbranch refs/heads/run/r3\n`,
      stderr: '',
    },
  });

  const result = await startRunWorktree({ runner, projectId: 'p1', runId: 'r3', env: ENV_ON });
  assert.equal(result.ok, true);
  assert.equal(result.resumed, true);
  assert.equal(result.worktreeDir, `${RUN_WORKTREES_DIRNAME}/wt-r3`);
  // No add attempted, nothing written.
  assert.ok(!execCommands(runner).some((c) => c.startsWith('git worktree add')));
  assert.equal(runner.writes.length, 0);
});

test('startRunWorktree rejects path-traversal and malformed run ids before any git call', async () => {
  for (const runId of ['../evil', 'a/../b', 'a/b', '.hidden', '-flag', 'wt id', '', null, 'x'.repeat(97)]) {
    const runner = fakeRunner();
    const result = await startRunWorktree({ runner, projectId: 'p1', runId, env: ENV_ON });
    assert.equal(result.ok, false, `runId ${JSON.stringify(runId)} must be rejected`);
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'invalid_run_id');
    assert.equal(runner.calls.length, 0, 'no runner.exec on rejected runId');
    assert.equal(runner.writes.length, 0);
  }
});

test('startRunWorktree rejects unsafe base branches', async () => {
  for (const baseBranch of ['../../etc', 'main..dev', '-x', 'refs/heads/main', 'a b']) {
    const runner = fakeRunner();
    const result = await startRunWorktree({ runner, projectId: 'p1', runId: 'r1', baseBranch, env: ENV_ON });
    assert.equal(result.ok, false, `baseBranch ${JSON.stringify(baseBranch)} must be rejected`);
    assert.equal(result.code, 'invalid_base_branch');
    assert.equal(runner.calls.length, 0);
  }
});

test('startRunWorktree surfaces git failures as data, redacted', async () => {
  const runner = fakeRunner({
    'git worktree list --porcelain': { exitCode: 0, stdout: 'worktree /work/p1\n', stderr: '' },
    'git show-ref': { exitCode: 1, stdout: '', stderr: '' },
    'git worktree add': {
      exitCode: 128,
      stdout: '',
      stderr: "fatal: could not push to https://user:ghp_secret123@github.com/x/y",
    },
  });

  const result = await startRunWorktree({ runner, projectId: 'p1', runId: 'r1', env: ENV_ON });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'worktree_add_failed');
  assert.ok(!result.detail.includes('ghp_secret123'), 'token must be redacted');
});

test('startRunWorktree with flag off is a pure no-op (zero runner calls)', async () => {
  const runner = fakeRunner();
  const result = await startRunWorktree({ runner, projectId: 'p1', runId: 'r1', env: ENV_OFF });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'skipped');
  assert.equal(result.worktree, false);
  assert.equal(runner.calls.length, 0);
  assert.equal(runner.writes.length, 0);
});

test('removeRunWorktree removes worktree, prunes, and deletes the branch', async () => {
  const runner = fakeRunner({
    'git worktree remove --force': { exitCode: 0, stdout: '', stderr: '' },
    'git worktree prune': { exitCode: 0, stdout: '', stderr: '' },
    'git branch -D run/r1': { exitCode: 0, stdout: 'Deleted branch run/r1', stderr: '' },
  });

  const result = await removeRunWorktree({ runner, projectId: 'p1', runId: 'r1', env: ENV_ON });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'removed');
  assert.equal(result.removed, true);
  assert.equal(result.branchDeleted, true);
  const commands = execCommands(runner);
  assert.ok(commands.includes(`git worktree remove --force ${RUN_WORKTREES_DIRNAME}/wt-r1`));
  assert.ok(commands.includes('git worktree prune'));
  assert.ok(commands.includes('git branch -D run/r1'));
});

test('removeRunWorktree is idempotent: missing worktree and branch are a clean no-op', async () => {
  const runner = fakeRunner({
    'git worktree remove --force': {
      exitCode: 128,
      stdout: '',
      stderr: `fatal: '${RUN_WORKTREES_DIRNAME}/wt-r1' is not a working tree`,
    },
    'git branch -D run/r1': { exitCode: 1, stdout: '', stderr: "error: branch 'run/r1' not found." },
  });

  const result = await removeRunWorktree({ runner, projectId: 'p1', runId: 'r1', env: ENV_ON });
  assert.equal(result.ok, true, 'second remove must not fail');
  assert.equal(result.status, 'not_found');
  assert.equal(result.removed, false);
  assert.equal(result.branchDeleted, false);
});

test('removeRunWorktree keeps the branch with deleteBranch:false', async () => {
  const runner = fakeRunner({
    'git worktree remove --force': { exitCode: 0, stdout: '', stderr: '' },
  });
  const result = await removeRunWorktree({
    runner,
    projectId: 'p1',
    runId: 'r1',
    env: ENV_ON,
    deleteBranch: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.branchDeleted, false);
  assert.ok(!execCommands(runner).some((c) => c.startsWith('git branch -D')));
});

test('removeRunWorktree surfaces unexpected git failures as errors', async () => {
  const runner = fakeRunner({
    'git worktree remove --force': {
      exitCode: 128,
      stdout: '',
      stderr: `fatal: '${RUN_WORKTREES_DIRNAME}/wt-r1' contains modified or untracked files, lock held`,
    },
  });
  const result = await removeRunWorktree({ runner, projectId: 'p1', runId: 'r1', env: ENV_ON });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'worktree_remove_failed');
});

test('removeRunWorktree with flag off is a pure no-op, and rejects bad run ids when on', async () => {
  const off = fakeRunner();
  const skipped = await removeRunWorktree({ runner: off, projectId: 'p1', runId: 'r1', env: ENV_OFF });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.status, 'skipped');
  assert.equal(off.calls.length, 0);

  const on = fakeRunner();
  const rejected = await removeRunWorktree({ runner: on, projectId: 'p1', runId: '../../evil', env: ENV_ON });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'invalid_run_id');
  assert.equal(on.calls.length, 0);
});

test('runWorktreeRelPath / resolveRunCwd validate the run id and honour the flag', () => {
  assert.equal(runWorktreeRelPath('r1'), `${RUN_WORKTREES_DIRNAME}/wt-r1`);
  assert.equal(runWorktreeRelPath('../evil'), null);
  assert.equal(runWorktreeRelPath('a/b'), null);
  assert.equal(runWorktreeRelPath(''), null);

  assert.equal(resolveRunCwd({ runId: 'r1', env: ENV_OFF }), null, 'flag off → null');
  assert.equal(resolveRunCwd({ runId: 'r1', env: ENV_ON }), `${RUN_WORKTREES_DIRNAME}/wt-r1`);
  assert.equal(resolveRunCwd({ runId: '../evil', env: ENV_ON }), null, 'unsafe id → null even when on');
  assert.equal(resolveRunCwd({ env: ENV_ON }), null);
});

test('build-tools resolveToolPath: identity with flag off, prefixed with flag on', () => {
  const ctxOff = { run: { id: 'r1' }, env: ENV_OFF, runner: {} };
  assert.equal(resolveToolPath(ctxOff, 'src/App.tsx'), 'src/App.tsx');

  const ctxOn = { run: { id: 'r1' }, env: ENV_ON, runner: {} };
  assert.equal(resolveToolPath(ctxOn, 'src/App.tsx'), `${RUN_WORKTREES_DIRNAME}/wt-r1/src/App.tsx`);

  // Run-scoped runners already map the worktree runner-side — never re-prefix.
  const ctxScoped = { run: { id: 'r1' }, env: ENV_ON, runner: { scope: { run: 'r1' } } };
  assert.equal(resolveToolPath(ctxScoped, 'src/App.tsx'), 'src/App.tsx');

  // Unsafe paths are left for each tool's own validation to reject.
  assert.equal(resolveToolPath(ctxOn, '/etc/passwd'), '/etc/passwd');
  assert.equal(resolveToolPath(ctxOn, '../outside.txt'), '../outside.txt');
  assert.equal(resolveToolPath(ctxOn, 'a/../../b'), 'a/../../b');

  // No run in ctx → identity.
  assert.equal(resolveToolPath({ env: ENV_ON, runner: {} }, 'x.js'), 'x.js');
  assert.equal(resolveToolPath(ctxOn, ''), '');
  assert.equal(resolveToolPath(ctxOn, null), null);
});
