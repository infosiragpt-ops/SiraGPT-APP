'use strict';

// codex/workspace-changes — vista «Cambios» + preparación de rama para «Crear
// PR» desde un chat de /agentes (Etapa 7 paridad Claude Code). Runner falso
// con salidas git guionizadas: cero red, cero git real.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DIFF_CAP,
  WorkspaceChangesError,
  parseNameStatus,
  parseNumstat,
  parsePorcelain,
  countDiffLines,
  getWorkspaceChanges,
  workspaceRunId,
  prepareWorkspaceBranch,
} = require('../src/services/codex/workspace-changes');
const { runBranchName } = require('../src/services/codex/git-workflow');

function fakeRunner(script = {}) {
  const calls = [];
  return {
    calls,
    async exec(projectId, argv) {
      assert.ok(Array.isArray(argv), 'argv must be an array (never a shell string)');
      const joined = argv.join(' ');
      calls.push(joined);
      for (const [prefix, reply] of Object.entries(script)) {
        if (joined.startsWith(prefix)) {
          return typeof reply === 'function' ? reply(argv) : { exitCode: 0, stdout: '', stderr: '', ...reply };
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

const NS = ['M', 'src/a.ts', 'A', 'src/new.ts', 'D', 'old.txt', 'R100', 'src/b.ts', 'src/c.ts'].join('\0') + '\0';
const NUM = ['3\t1\tsrc/a.ts', '10\t0\tsrc/new.ts', '0\t4\told.txt', '-\t-\tassets/logo.png', '1\t1\t', 'src/b.ts', 'src/c.ts'].join('\0') + '\0';
const PORCELAIN = [' M src/a.ts', '?? notes.md', '?? bin/blob.dat'].join('\0') + '\0';
const TRACKED_DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,3 @@\n-old\n+new\n+more\n+lines\n';

function baseScript(overrides = {}) {
  return {
    'git rev-parse --verify --quiet production-main^{commit}': { stdout: 'basesha1\n' },
    'git rev-parse --abbrev-ref HEAD': { stdout: 'production-main\n' },
    'git rev-parse HEAD': { stdout: 'headsha2\n' },
    'git rev-list --count production-main..HEAD': { stdout: '0\n' },
    'git diff --name-status -z production-main': { stdout: NS },
    'git diff --numstat -z production-main': { stdout: NUM },
    'git status --porcelain=v1 -z --untracked-files=all': { stdout: PORCELAIN },
    'git diff --no-index -- /dev/null notes.md': {
      exitCode: 1,
      stdout: 'diff --git a/notes.md b/notes.md\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+hola\n+mundo\n',
    },
    'git diff --no-index -- /dev/null bin/blob.dat': { exitCode: 1, stdout: 'Binary files /dev/null and b/bin/blob.dat differ\n' },
    'git diff production-main': { stdout: TRACKED_DIFF },
    ...overrides,
  };
}

test('parsers: name-status con rename, numstat binario/rename, porcelain con untracked', () => {
  assert.deepEqual(parseNameStatus(NS), [
    { path: 'src/a.ts', status: 'modified' },
    { path: 'src/new.ts', status: 'added' },
    { path: 'old.txt', status: 'deleted' },
    { path: 'src/c.ts', status: 'renamed', from: 'src/b.ts' },
  ]);
  const num = parseNumstat(NUM);
  assert.deepEqual(num.get('src/a.ts'), { additions: 3, deletions: 1, binary: false });
  assert.deepEqual(num.get('assets/logo.png'), { additions: 0, deletions: 0, binary: true });
  assert.deepEqual(num.get('src/c.ts'), { additions: 1, deletions: 1, binary: false });
  const st = parsePorcelain(PORCELAIN);
  assert.deepEqual(st.untracked, ['notes.md', 'bin/blob.dat']);
  assert.deepEqual([...st.dirtyPaths], ['src/a.ts']);
  assert.deepEqual(countDiffLines(TRACKED_DIFF), { additions: 3, deletions: 1 });
});

test('getWorkspaceChanges: archivos con estado/contadores, untracked inline en el diff, resumen', async () => {
  const runner = fakeRunner(baseScript());
  const out = await getWorkspaceChanges({ runner, projectId: 'p1', baseBranch: 'production-main' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.base, { branch: 'production-main', sha: 'basesha1' });
  assert.deepEqual(out.head, { branch: 'production-main', sha: 'headsha2', ahead: 0 });
  assert.deepEqual(out.files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary, f.uncommitted]), [
    ['src/a.ts', 'modified', 3, 1, false, true],
    ['src/new.ts', 'added', 10, 0, false, false],
    ['old.txt', 'deleted', 0, 4, false, false],
    ['src/c.ts', 'renamed', 1, 1, false, false],
    ['notes.md', 'untracked', 2, 0, false, true],
    ['bin/blob.dat', 'untracked', 0, 0, true, true],
  ]);
  assert.equal(out.files[3].from, 'src/b.ts');
  assert.equal(out.filesChanged, 6);
  assert.equal(out.additions, 16);
  assert.equal(out.deletions, 6);
  assert.equal(out.dirty, true);
  assert.equal(out.truncated, false);
  assert.ok(out.diff.startsWith(TRACKED_DIFF), 'el diff tracked va primero');
  assert.ok(out.diff.includes('+++ b/notes.md'), 'los untracked se inlinean como diff vs /dev/null');
  assert.ok(out.diff.includes('Binary files /dev/null and b/bin/blob.dat differ'));
  // Solo lectura: ninguna mutación del workspace.
  assert.ok(runner.calls.every((c) => !/git (checkout|add|commit|reset|switch)/.test(c)), runner.calls.join('\n'));
  assert.ok(runner.calls.includes('git status --porcelain=v1 -z --untracked-files=all'));
});

test('getWorkspaceChanges: sin rama base en el workspace → base_missing 409; rama inválida → 400', async () => {
  const missing = fakeRunner(baseScript({ 'git rev-parse --verify --quiet production-main^{commit}': { exitCode: 1, stdout: '' } }));
  await assert.rejects(
    () => getWorkspaceChanges({ runner: missing, projectId: 'p1', baseBranch: 'production-main' }),
    (err) => err instanceof WorkspaceChangesError && err.code === 'base_missing' && err.status === 409,
  );
  for (const bad of ['run/x', '..', 'a b', '-oops']) {
    await assert.rejects(
      () => getWorkspaceChanges({ runner: fakeRunner(), projectId: 'p1', baseBranch: bad }),
      (err) => err.code === 'invalid_source_branch',
      bad,
    );
  }
});

test('getWorkspaceChanges: diff por encima del cap se trunca con marcador; git roto → git_failed 502', async () => {
  const big = 'x'.repeat(200);
  const runner = fakeRunner(baseScript({ 'git diff production-main': { stdout: big } }));
  const out = await getWorkspaceChanges({ runner, projectId: 'p1', baseBranch: 'production-main', diffCap: 100 });
  assert.equal(out.truncated, true);
  assert.ok(out.diff.endsWith('…[diff truncado]'));
  assert.ok(out.diff.length < 200);
  assert.equal(DIFF_CAP, 500_000);

  const broken = fakeRunner(baseScript({ 'git diff --name-status -z production-main': { exitCode: 128, stderr: 'fatal: bad' } }));
  await assert.rejects(
    () => getWorkspaceChanges({ runner: broken, projectId: 'p1', baseBranch: 'production-main' }),
    (err) => err.code === 'git_failed' && err.status === 502 && err.details.detail.includes('fatal: bad'),
  );
});

test('getWorkspaceChanges: HEAD suelto y commits por delante se reportan (branch null, ahead N)', async () => {
  const runner = fakeRunner(baseScript({
    'git rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n' },
    'git rev-list --count production-main..HEAD': { stdout: '2\n' },
    'git status --porcelain=v1 -z --untracked-files=all': { stdout: '' },
  }));
  const out = await getWorkspaceChanges({ runner, projectId: 'p1', baseBranch: 'production-main' });
  assert.equal(out.head.branch, null);
  assert.equal(out.head.ahead, 2);
  assert.equal(out.dirty, false);
  assert.equal(out.files.length, 4, 'sin untracked quedan los 4 tracked');
});

test('workspaceRunId: forma válida para runBranchName y única por minuto', () => {
  const id = workspaceRunId('clx9abcdef1234567', new Date(Date.UTC(2026, 8, 12, 6, 7)));
  assert.equal(id, 'agentes-f1234567-202609120607');
  assert.equal(runBranchName(id), `run/${id}`);
  assert.equal(workspaceRunId('', new Date(Date.UTC(2026, 0, 1, 0, 0))), 'agentes-chat-202601010000');
});

test('prepareWorkspaceBranch: dirty → checkout -B run/<id> + add -A + commit con identidad Codex', async () => {
  const runner = fakeRunner({
    'git status --porcelain=v1 -z --untracked-files=all': { stdout: ' M src/a.ts\0' },
    'git rev-list --count production-main..HEAD': { stdout: '0\n' },
    'git rev-parse HEAD': { stdout: 'newsha9\n' },
  });
  const out = await prepareWorkspaceBranch({
    runner, projectId: 'p1', baseBranch: 'production-main', runId: 'agentes-p1-202609120607', title: 'feat: hola', body: 'detalle',
  });
  assert.deepEqual(out, { status: 'prepared', branch: 'run/agentes-p1-202609120607', commitSha: 'newsha9', committed: true });
  assert.ok(runner.calls.includes('git checkout -B run/agentes-p1-202609120607'));
  assert.ok(runner.calls.includes('git add -A'));
  const commit = runner.calls.find((c) => c.includes(' commit '));
  assert.ok(commit.startsWith('git -c user.name=Codex Agent -c user.email=codex@siragpt.local commit'), commit);
  assert.ok(commit.includes('-m feat: hola'));
  assert.ok(commit.includes('-m detalle'));
});

test('prepareWorkspaceBranch: limpio y sin commits por delante → no_changes sin mutar; limpio pero adelantado → solo rama', async () => {
  const clean = fakeRunner({ 'git rev-list --count production-main..HEAD': { stdout: '0\n' } });
  const none = await prepareWorkspaceBranch({ runner: clean, projectId: 'p1', baseBranch: 'production-main', runId: 'agentes-p1-1', title: 'x' });
  assert.equal(none.status, 'no_changes');
  assert.ok(clean.calls.every((c) => !/git (checkout|add|commit)/.test(c)));

  const ahead = fakeRunner({
    'git rev-list --count production-main..HEAD': { stdout: '3\n' },
    'git rev-parse HEAD': { stdout: 'aheadsha\n' },
  });
  const out = await prepareWorkspaceBranch({ runner: ahead, projectId: 'p1', baseBranch: 'production-main', runId: 'agentes-p1-2', title: 'x' });
  assert.deepEqual(out, { status: 'prepared', branch: 'run/agentes-p1-2', commitSha: 'aheadsha', committed: false });
  assert.ok(ahead.calls.includes('git checkout -B run/agentes-p1-2'));
  assert.ok(ahead.calls.every((c) => !c.includes(' commit ')));
});

test('prepareWorkspaceBranch: runId inválido → invalid_run_id; commit fallido → git_failed 502', async () => {
  await assert.rejects(
    () => prepareWorkspaceBranch({ runner: fakeRunner(), projectId: 'p1', baseBranch: 'main', runId: 'bad id', title: 'x' }),
    (err) => err.code === 'invalid_run_id',
  );
  const failing = fakeRunner({
    'git status --porcelain=v1 -z --untracked-files=all': { stdout: '?? a.txt\0' },
    'git -c user.name=Codex Agent': { exitCode: 1, stderr: 'nothing to commit' },
  });
  await assert.rejects(
    () => prepareWorkspaceBranch({ runner: failing, projectId: 'p1', baseBranch: 'main', runId: 'agentes-p1-3', title: 'x' }),
    (err) => err.code === 'git_failed' && err.status === 502,
  );
});
