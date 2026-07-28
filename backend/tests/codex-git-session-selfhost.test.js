'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const checkpointService = require('../src/services/codex/checkpoint-service');
const {
  mergeRunBranch,
  runBranchName,
  startRunBranch,
} = require('../src/services/codex/git-workflow');
const {
  createRunnerArtifactStore,
  createPrismaSessionStore,
  createSessionService,
  ensureSessionArtifactsIgnored,
  snapshotIsResumable,
} = require('../src/services/codex/session-service');
const {
  assertPublishableFile,
  prepareSelfHostedProject,
  publishSelfHostedPullRequest,
  validateRepositoryUrl,
} = require('../src/services/codex/self-hosting');
const { createProject } = require('../src/services/codex/project-service');
const { recoverCodexRunsAfterBoot } = require('../src/services/codex/boot-recovery');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function gitFixture(t, prefix = 'codex-git-parity-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectId = 'project-1';
  const projectDir = path.join(root, projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  git(projectDir, ['init', '-b', 'main']);
  git(projectDir, ['config', 'user.name', 'Codex Test']);
  git(projectDir, ['config', 'user.email', 'codex-test@siragpt.local']);
  git(projectDir, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(projectDir, 'app.txt'), 'base\n');
  git(projectDir, ['add', '-A']);
  git(projectDir, ['commit', '-m', 'initial']);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const runner = {
    async exec(project, command) {
      assert.equal(project, projectId);
      try {
        return {
          exitCode: 0,
          stdout: execFileSync(command[0], command.slice(1), {
            cwd: projectDir,
            encoding: 'utf8',
          }),
          stderr: '',
        };
      } catch (error) {
        return {
          exitCode: Number.isInteger(error.status) ? error.status : 1,
          stdout: String(error.stdout || ''),
          stderr: String(error.stderr || error.message || ''),
        };
      }
    },
    async devStatus() { return { running: false }; },
  };
  return { root, projectId, projectDir, runner };
}

function checkpointDb() {
  const rows = [];
  return {
    rows,
    codexCheckpoint: {
      async create({ data }) {
        const row = {
          id: `checkpoint-${rows.length + 1}`,
          createdAt: new Date('2026-07-26T00:00:00.000Z'),
          ...data,
        };
        rows.push(row);
        return row;
      },
    },
  };
}

test('OT-7: checkpoint finalization creates run/<id> and merges only after a green gate', async (t) => {
  const fixture = gitFixture(t);
  assert.equal(runBranchName('run-123'), 'run/run-123');
  assert.equal(runBranchName('../../main'), null);

  const run = { id: 'run-123', projectId: fixture.projectId, prompt: 'actualiza app' };
  const project = { id: fixture.projectId };
  const prepared = await checkpointService.prepareRunBranch({
    run,
    project,
    deps: { runner: fixture.runner },
  });
  assert.deepEqual(
    { ok: prepared.ok, branch: prepared.runBranch },
    { ok: true, branch: 'run/run-123' },
  );

  fs.writeFileSync(path.join(fixture.projectDir, 'app.txt'), 'feature\n');
  const db = checkpointDb();
  const snapshots = [];
  const sessionService = {
    async readTranscript() { return { lastSeq: 4 }; },
    async saveSnapshot(snapshot) {
      snapshots.push(snapshot);
      return { version: 1, sessionId: snapshot.sessionId, cursorSeq: snapshot.cursorSeq };
    },
  };

  const blocked = await checkpointService.finalizeRunCheckpoint({
    run,
    project,
    verification: { ok: false, status: 'failed' },
    deps: { runner: fixture.runner, prisma: db, sessionService },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.merge.code, 'verification_not_green');
  assert.equal(git(fixture.projectDir, ['branch', '--show-current']).trim(), 'run/run-123');
  assert.equal(git(fixture.projectDir, ['show', 'main:app.txt']), 'base\n');
  assert.equal(snapshots[0].checkpointSha, db.rows[0].commitSha);

  const merged = await mergeRunBranch({
    runner: fixture.runner,
    projectId: fixture.projectId,
    runId: run.id,
    verification: { ok: true, status: 'green' },
  });
  assert.equal(merged.ok, true);
  assert.equal(merged.status, 'merged');
  assert.equal(git(fixture.projectDir, ['branch', '--show-current']).trim(), 'main');
  assert.equal(fs.readFileSync(path.join(fixture.projectDir, 'app.txt'), 'utf8'), 'feature\n');
  const parents = git(fixture.projectDir, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/);
  assert.equal(parents.length, 3, 'green close must produce a merge commit');
});

test('OT-7: a merge conflict is structured and main is restored cleanly', async (t) => {
  const fixture = gitFixture(t, 'codex-git-conflict-');
  const started = await startRunBranch({
    runner: fixture.runner,
    projectId: fixture.projectId,
    runId: 'conflict-1',
  });
  assert.equal(started.ok, true);
  fs.writeFileSync(path.join(fixture.projectDir, 'app.txt'), 'run change\n');
  git(fixture.projectDir, ['add', '-A']);
  git(fixture.projectDir, ['commit', '-m', 'run change']);

  git(fixture.projectDir, ['switch', 'main']);
  fs.writeFileSync(path.join(fixture.projectDir, 'app.txt'), 'main change\n');
  git(fixture.projectDir, ['add', '-A']);
  git(fixture.projectDir, ['commit', '-m', 'main change']);

  const result = await mergeRunBranch({
    runner: fixture.runner,
    projectId: fixture.projectId,
    runId: 'conflict-1',
    verification: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'conflict');
  assert.equal(result.code, 'merge_conflict');
  assert.deepEqual(result.conflicts, ['app.txt']);
  assert.equal(git(fixture.projectDir, ['branch', '--show-current']).trim(), 'main');
  assert.equal(git(fixture.projectDir, ['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(path.join(fixture.projectDir, 'app.txt'), 'utf8'), 'main change\n');
});

test('A1: two run worktrees edit the same project without sharing a working tree', async (t) => {
  const fixture = gitFixture(t, 'codex-worktree-isolation-');
  const worktreesDir = path.join(fixture.root, 'worktrees');
  fs.mkdirSync(worktreesDir, { recursive: true });

  const execAt = async (cwd, command) => {
    try {
      return {
        exitCode: 0,
        stdout: execFileSync(command[0], command.slice(1), { cwd, encoding: 'utf8' }),
        stderr: '',
      };
    } catch (error) {
      return {
        exitCode: Number.isInteger(error.status) ? error.status : 1,
        stdout: String(error.stdout || ''),
        stderr: String(error.stderr || error.message || ''),
      };
    }
  };
  let baseRunner;
  const scopedRunner = (runId) => {
    const dir = path.join(worktreesDir, `wt-${runId}`);
    return {
      exec: (_projectId, command) => execAt(dir, command),
      unscoped: () => baseRunner,
      removeWorktree: async () => {
        git(fixture.projectDir, ['worktree', 'remove', dir]);
        return { ok: true, removed: true };
      },
    };
  };
  baseRunner = {
    exec: (_projectId, command) => execAt(fixture.projectDir, command),
    async createWorktree(_projectId, runId, baseBranch) {
      const dir = path.join(worktreesDir, `wt-${runId}`);
      git(fixture.projectDir, ['worktree', 'add', '-b', `run/${runId}`, dir, baseBranch]);
      return { ok: true, dir, resumed: false };
    },
    forRun: (runId) => scopedRunner(runId),
    unscoped: () => baseRunner,
  };

  const first = await startRunBranch({
    runner: baseRunner,
    projectId: fixture.projectId,
    runId: 'fleet-a',
  });
  const second = await startRunBranch({
    runner: baseRunner,
    projectId: fixture.projectId,
    runId: 'fleet-b',
  });
  assert.equal(first.worktree, true);
  assert.equal(second.worktree, true);

  const firstDir = path.join(worktreesDir, 'wt-fleet-a');
  const secondDir = path.join(worktreesDir, 'wt-fleet-b');
  fs.writeFileSync(path.join(firstDir, 'app.txt'), 'run A\n');
  fs.writeFileSync(path.join(secondDir, 'app.txt'), 'run B\n');
  assert.equal(fs.readFileSync(path.join(firstDir, 'app.txt'), 'utf8'), 'run A\n');
  assert.equal(fs.readFileSync(path.join(secondDir, 'app.txt'), 'utf8'), 'run B\n');
  assert.equal(fs.readFileSync(path.join(fixture.projectDir, 'app.txt'), 'utf8'), 'base\n');
  assert.equal(git(fixture.projectDir, ['status', '--porcelain']), '');

  git(firstDir, ['add', '-A']);
  git(firstDir, ['commit', '-m', 'fleet A']);
  const merged = await mergeRunBranch({
    runner: scopedRunner('fleet-a'),
    projectId: fixture.projectId,
    runId: 'fleet-a',
    verification: true,
  });
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.worktreeCleanup, { ok: true, removed: true });
  assert.equal(fs.existsSync(firstDir), false);
  assert.equal(fs.readFileSync(path.join(fixture.projectDir, 'app.txt'), 'utf8'), 'run A\n');
  assert.equal(fs.readFileSync(path.join(secondDir, 'app.txt'), 'utf8'), 'run B\n');
});

test('OT-7: configured production-main is used as the run base and merge target', async (t) => {
  const fixture = gitFixture(t, 'codex-production-main-');
  git(fixture.projectDir, ['branch', '-m', 'production-main']);
  const run = { id: 'prod-run-1', projectId: fixture.projectId, prompt: 'mejora segura' };
  const project = {
    id: fixture.projectId,
    brief: {
      kind: 'repo',
      repository: {
        url: 'https://github.com/infosiragpt-ops/SiraGPT-APP.git',
        sourceBranch: 'production-main',
      },
    },
  };
  const prepared = await checkpointService.prepareRunBranch({
    run,
    project,
    deps: { runner: fixture.runner },
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.baseBranch, 'production-main');
  fs.writeFileSync(path.join(fixture.projectDir, 'app.txt'), 'production feature\n');
  const expectedTreeSha = await checkpointService.captureWorkspaceTree({
    runner: fixture.runner,
    projectId: fixture.projectId,
  });
  const result = await checkpointService.finalizeRunCheckpoint({
    run,
    project,
    verification: { ok: true, status: 'passed' },
    deps: {
      runner: fixture.runner,
      prisma: checkpointDb(),
      expectedTreeSha,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.merge.baseBranch, 'production-main');
  assert.equal(git(fixture.projectDir, ['branch', '--show-current']).trim(), 'production-main');
  assert.equal(fs.readFileSync(path.join(fixture.projectDir, 'app.txt'), 'utf8'), 'production feature\n');
});

test('OT-7: workspace mutation after verification never reaches the base branch', async (t) => {
  const fixture = gitFixture(t, 'codex-tree-race-');
  const run = { id: 'tree-race-1', projectId: fixture.projectId, prompt: 'cambio verificado' };
  const project = { id: fixture.projectId };
  const prepared = await checkpointService.prepareRunBranch({
    run,
    project,
    deps: { runner: fixture.runner },
  });
  assert.equal(prepared.ok, true);

  fs.writeFileSync(path.join(fixture.projectDir, 'app.txt'), 'verified\n');
  const expectedTreeSha = await checkpointService.captureWorkspaceTree({
    runner: fixture.runner,
    projectId: fixture.projectId,
  });
  fs.writeFileSync(path.join(fixture.projectDir, 'app.txt'), 'mutated after verification\n');

  await assert.rejects(
    checkpointService.finalizeRunCheckpoint({
      run,
      project,
      verification: { ok: true, status: 'passed', treeSha: expectedTreeSha },
      deps: {
        runner: fixture.runner,
        prisma: checkpointDb(),
        expectedTreeSha,
      },
    }),
    (error) => error?.code === 'checkpoint_tree_mismatch',
  );
  assert.equal(git(fixture.projectDir, ['branch', '--show-current']).trim(), 'run/tree-race-1');
  assert.equal(git(fixture.projectDir, ['show', 'main:app.txt']), 'base\n');
});

function memoryArtifactStore() {
  const artifacts = new Map();
  const key = (projectId, artifactPath) => `${projectId}:${artifactPath}`;
  return {
    artifacts,
    async readText(projectId, artifactPath) {
      const value = artifacts.get(key(projectId, artifactPath));
      if (value == null) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return value;
    },
    async writeText(projectId, artifactPath, content) {
      artifacts.set(key(projectId, artifactPath), String(content));
      return { ok: true };
    },
    async deleteText(projectId, artifactPath) {
      artifacts.delete(key(projectId, artifactPath));
    },
  };
}

function sessionStateDb() {
  const rows = new Map();
  const composite = (projectId, sessionId) => `${projectId}:${sessionId}`;
  let idCounter = 0;
  const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));
  return {
    rows,
    codexSessionState: {
      async findUnique({ where }) {
        const key = composite(
          where.projectId_sessionId.projectId,
          where.projectId_sessionId.sessionId,
        );
        return clone(rows.get(key) || null);
      },
      async create({ data }) {
        const key = composite(data.projectId, data.sessionId);
        if (rows.has(key)) {
          const error = new Error('unique');
          error.code = 'P2002';
          throw error;
        }
        const row = { id: `state-${++idCounter}`, ...clone(data) };
        rows.set(key, row);
        return clone(row);
      },
      async updateMany({ where, data }) {
        const entry = [...rows.entries()].find(([, row]) => row.id === where.id);
        if (!entry || entry[1].revision !== where.revision) return { count: 0 };
        const [key, row] = entry;
        rows.set(key, {
          ...row,
          ...clone(Object.fromEntries(
            Object.entries(data).filter(([name]) => name !== 'revision'),
          )),
          revision: row.revision + Number(data.revision?.increment || 0),
        });
        return { count: 1 };
      },
    },
  };
}

test('OT-12: control-plane CAS preserves concurrent appends and redacts secrets', async () => {
  const db = sessionStateDb();
  const storeA = createPrismaSessionStore(db);
  const storeB = createPrismaSessionStore(db);
  const artifact = '.sira/sessions/run-1.jsonl';
  const append = (store, label, delay) => store.mutateText('p1', artifact, async (current) => {
    const parsed = current.trim()
      ? current.trim().split('\n').map((line) => JSON.parse(line))
      : [];
    await new Promise((resolve) => { setTimeout(resolve, delay); });
    parsed.push({ seq: (parsed.at(-1)?.seq || 0) + 1, label });
    return `${parsed.map((row) => JSON.stringify(row)).join('\n')}\n`;
  });
  await Promise.all([
    append(storeA, 'first', 15),
    append(storeB, 'second', 5),
  ]);
  const persisted = await storeA.readText('p1', artifact);
  const rows = persisted.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.seq), [1, 2]);
  assert.deepEqual(new Set(rows.map((row) => row.label)), new Set(['first', 'second']));

  const service = createSessionService({ db });
  await service.appendTranscript({
    projectId: 'p1',
    sessionId: 'secure-run',
    entry: {
      type: 'tool_result',
      token: 'never-persist-this',
      text: `Bearer github_pat_${'a'.repeat(30)}`,
    },
  });
  const secure = await service.readTranscript({ projectId: 'p1', sessionId: 'secure-run' });
  assert.equal(JSON.stringify(secure).includes('never-persist-this'), false);
  assert.equal(JSON.stringify(secure).includes('github_pat_'), false);
  assert.equal(db.rows.size, 2);
});

test('OT-12: session artifacts are excluded through the runner filesystem API without a shell', async () => {
  let content = '# local excludes\n';
  const calls = [];
  const runner = {
    async readFile(_projectId, artifactPath) {
      calls.push(['read', artifactPath]);
      return { content };
    },
    async writeFiles(_projectId, files) {
      calls.push(['write', files[0].path]);
      content = files[0].content;
      return { ok: true, written: 1 };
    },
    async exec() {
      throw new Error('session ignore initialization must not invoke shell or exec');
    },
  };

  assert.equal(await ensureSessionArtifactsIgnored(runner, 'p1'), true);
  assert.match(content, /^# local excludes\n\.sira\/sessions\/\n$/);
  assert.equal(await ensureSessionArtifactsIgnored(runner, 'p1'), true);
  assert.equal(calls.filter(([kind]) => kind === 'write').length, 1, 'the rule is idempotent');
});

test('OT-12: transcript JSONL is bounded and supports snapshot, continue, fork and rewind', async () => {
  const store = memoryArtifactStore();
  let tick = 0;
  const sessions = createSessionService({
    store,
    maxEntries: 10,
    maxBytes: 8_000,
    clock: () => new Date(`2026-07-26T00:00:${String(tick++).padStart(2, '0')}.000Z`),
  });

  for (let index = 1; index <= 12; index += 1) {
    await sessions.appendTranscript({
      projectId: 'p1',
      sessionId: 'session-1',
      entry: { role: index % 2 ? 'assistant' : 'tool', content: `message-${index}` },
    });
  }
  const transcript = await sessions.readTranscript({ projectId: 'p1', sessionId: 'session-1' });
  assert.equal(transcript.entries.length, 10);
  assert.equal(transcript.firstSeq, 3);
  assert.equal(transcript.lastSeq, 12);

  const snapshot = await sessions.saveSnapshot({
    projectId: 'p1',
    sessionId: 'session-1',
    cursorSeq: 8,
    checkpointSha: 'deadbee',
    loopState: { step: 4, phase: 'tool_result' },
  });
  assert.equal(snapshotIsResumable(snapshot), true);
  const continued = await sessions.continueSession({ projectId: 'p1', sessionId: 'session-1' });
  assert.deepEqual(continued.tail.map((entry) => entry.seq), [9, 10, 11, 12]);

  const forked = await sessions.forkSession({
    projectId: 'p1',
    sourceSessionId: 'session-1',
    targetSessionId: 'session-fork',
    atSeq: 10,
  });
  assert.equal(forked.ok, true);
  assert.equal(forked.lastSeq, 10);
  assert.equal(forked.snapshot.metadata.forkedFrom, 'session-1');

  const restores = [];
  const rewound = await sessions.rewindSession({
    projectId: 'p1',
    sessionId: 'session-fork',
    toSeq: 8,
    checkpointId: 'checkpoint-8',
    restoreCheckpoint: async (request) => {
      restores.push(request);
      return { ok: true, commitSha: 'deadbee' };
    },
  });
  assert.equal(rewound.ok, true);
  assert.equal(rewound.lastSeq, 8);
  assert.equal(restores[0].checkpointId, 'checkpoint-8');
  const afterRewind = await sessions.continueSession({ projectId: 'p1', sessionId: 'session-fork' });
  assert.deepEqual(afterRewind.tail, []);
});

test('OT-12: rewind compensates the checkpoint when transcript persistence fails', async () => {
  const baseStore = memoryArtifactStore();
  const sessions = createSessionService({ store: baseStore });
  await sessions.appendTranscript({
    projectId: 'p1',
    sessionId: 'session-rollback',
    entry: { role: 'assistant', content: 'before rewind' },
  });
  const originalWrite = baseStore.writeText.bind(baseStore);
  let failNextTranscriptWrite = true;
  baseStore.writeText = async (projectId, artifactPath, content) => {
    if (failNextTranscriptWrite && artifactPath.endsWith('.jsonl')) {
      failNextTranscriptWrite = false;
      throw new Error('control-plane write failed');
    }
    return originalWrite(projectId, artifactPath, content);
  };
  const restores = [];
  const compensations = [];

  await assert.rejects(
    sessions.rewindSession({
      projectId: 'p1',
      sessionId: 'session-rollback',
      toSeq: 0,
      checkpointId: 'checkpoint-p1',
      restoreCheckpoint: async (request) => {
        restores.push(request);
        return { ok: true, commitSha: 'target-sha', previousSha: 'previous-sha' };
      },
      undoCheckpointRestore: async (restore) => {
        compensations.push(restore);
        return { ok: true };
      },
    }),
    /control-plane write failed/,
  );
  assert.equal(restores[0].projectId, 'p1');
  assert.deepEqual(compensations, [
    { ok: true, commitSha: 'target-sha', previousSha: 'previous-sha' },
  ]);
  const transcript = await sessions.readTranscript({
    projectId: 'p1',
    sessionId: 'session-rollback',
  });
  assert.equal(transcript.entries.length, 1);
  assert.equal(transcript.entries[0].content, 'before rewind');
});

test('OT-12: rollback query scopes checkpoints to the requested project and run', async () => {
  let query = null;
  const result = await checkpointService.rollbackCheckpoint({
    checkpointId: 'checkpoint-other-project',
    userId: 'u1',
    projectId: 'p1',
    runId: 'run-1',
    deps: {
      runner: {},
      prisma: {
        codexCheckpoint: {
          async findFirst(args) {
            query = args;
            return null;
          },
        },
      },
    },
  });
  assert.equal(result.status, 404);
  assert.deepEqual(query.where, {
    id: 'checkpoint-other-project',
    project: { userId: 'u1' },
    projectId: 'p1',
    runId: 'run-1',
  });
});

test('OT-12: boot recovery requires and forwards a resumable snapshot when a session service is supplied', async () => {
  const runs = [{ id: 'run-resume', projectId: 'p1', status: 'running' }];
  const enqueued = [];
  const prisma = {
    codexRun: {
      async findMany({ where }) { return runs.filter((run) => run.status === where.status); },
      async update({ where, data }) {
        const run = runs.find((candidate) => candidate.id === where.id);
        Object.assign(run, data);
        return run;
      },
    },
  };
  const snapshot = {
    version: 1,
    projectId: 'p1',
    sessionId: 'run-resume',
    cursorSeq: 9,
    checkpointSha: 'deadbee',
    loopState: { step: 5 },
  };
  const sessionService = {
    async readSnapshot() { return snapshot; },
    async hasResumableSnapshot() { return true; },
  };
  const queue = {
    async enqueueCodexRun(payload) { enqueued.push(payload); },
  };
  const eventStore = {
    async listEvents() { return []; },
    async appendEvent() {},
  };

  const result = await recoverCodexRunsAfterBoot({
    prisma,
    queue,
    eventStore,
    sessionService,
    env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
  });
  assert.equal(result.resumedRunning, 1);
  assert.equal(enqueued[0].resumeSnapshot.cursorSeq, 9);
  assert.equal(enqueued[0].resumeSnapshot.checkpointSha, 'deadbee');
});

test('OT-12: boot recovery fails closed when the configured session store has no snapshot', async () => {
  const runs = [{ id: 'run-no-snapshot', projectId: 'p1', status: 'running' }];
  const enqueued = [];
  const prisma = {
    codexRun: {
      async findMany({ where }) { return runs.filter((run) => run.status === where.status); },
      async update({ where, data }) {
        const run = runs.find((candidate) => candidate.id === where.id);
        Object.assign(run, data);
        return run;
      },
    },
  };
  const result = await recoverCodexRunsAfterBoot({
    prisma,
    queue: { async enqueueCodexRun(payload) { enqueued.push(payload); } },
    eventStore: { async listEvents() { return []; }, async appendEvent() {} },
    sessionService: {
      async readSnapshot() { return null; },
      async hasResumableSnapshot() { return false; },
    },
    env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
  });
  assert.equal(result.erroredRunning, 1);
  assert.equal(runs[0].status, 'error');
  assert.deepEqual(enqueued, []);
});

test('OT-10: allowlisted HTTPS repository creates an isolated branch and PR descriptor without merge', async () => {
  const calls = [];
  const runner = {
    async initWorkspace(projectId) {
      calls.push(['init', projectId]);
      return { ok: true };
    },
    async exec(_projectId, command) {
      calls.push(command);
      if (command.join(' ') === 'git remote get-url origin') {
        return { exitCode: 2, stdout: '', stderr: 'missing remote' };
      }
      if (command.join(' ') === 'git rev-parse HEAD') {
        return { exitCode: 0, stdout: '0123456789abcdef\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const prepared = await prepareSelfHostedProject({
    runner,
    projectId: 'p1',
    repositoryUrl: 'https://github.com/SiraGPT-ORg/siraGPT',
    sourceBranch: 'main',
    runId: 'selfhost-p1',
    allowedRepositories: ['https://github.com/SiraGPT-ORg/siraGPT.git'],
    env: {},
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.workBranch, 'run/selfhost-p1');
  assert.equal(prepared.pullRequest.status, 'prepared');
  assert.equal(prepared.pullRequest.mergePolicy, 'pull_request_only');
  assert.equal(calls.some((command) => Array.isArray(command) && command.includes('merge')), false);
  assert.ok(calls.some((command) => Array.isArray(command) && command.includes('fetch')));
  const embeddedPassword = ['not', 'a', 'real', 'credential'].join('-');
  const credentialUrl = `https://${'test-user'}:${embeddedPassword}@github.com/SiraGPT-ORg/siraGPT.git`;
  assert.throws(
    () => validateRepositoryUrl(
      credentialUrl,
      { allowedHosts: ['github.com'], env: {} },
    ),
    (error) => (
      error.code === 'repository_credentials_forbidden'
      && !error.message.includes(embeddedPassword)
    ),
  );
});

test('OT-10: GitHub publication creates a bounded branch commit and opens a PR without merging', async () => {
  const calls = [];
  const runner = {
    async exec(_projectId, command) {
      const key = command.join(' ');
      if (key.includes('--diff-filter=ACMRT')) {
        return { exitCode: 0, stdout: 'src/app.js\0', stderr: '' };
      }
      if (key.includes('--diff-filter=D')) {
        return { exitCode: 0, stdout: 'src/old.js\0', stderr: '' };
      }
      if (key === 'git ls-files -s -- src/app.js') {
        return { exitCode: 0, stdout: `100644 ${'a'.repeat(40)} 0\tsrc/app.js\n`, stderr: '' };
      }
      if (key === 'git rev-parse main') {
        return { exitCode: 0, stdout: 'base-sha\n', stderr: '' };
      }
      throw new Error(`unexpected runner command: ${key}`);
    },
    async readFile(_projectId, filePath) {
      assert.equal(filePath, 'src/app.js');
      return { content: 'export const ready = true;\n' };
    },
  };
  let getRefCount = 0;
  const octokit = {
    rest: {
      git: {
        async getRef(args) {
          calls.push(['getRef', args]);
          getRefCount += 1;
          if (getRefCount === 1) return { data: { object: { sha: 'base-sha' } } };
          const error = new Error('missing branch');
          error.status = 404;
          throw error;
        },
        async getCommit(args) {
          calls.push(['getCommit', args]);
          return { data: { tree: { sha: 'base-tree' } } };
        },
        async createBlob(args) {
          calls.push(['createBlob', args]);
          return { data: { sha: 'blob-sha' } };
        },
        async createTree(args) {
          calls.push(['createTree', args]);
          return { data: { sha: 'tree-sha' } };
        },
        async createCommit(args) {
          calls.push(['createCommit', args]);
          return { data: { sha: 'commit-sha' } };
        },
        async createRef(args) {
          calls.push(['createRef', args]);
          return { data: { ref: args.ref } };
        },
        async updateRef(args) {
          calls.push(['updateRef', args]);
          return { data: {} };
        },
      },
      pulls: {
        async create(args) {
          calls.push(['createPull', args]);
          return { data: { number: 17, html_url: 'https://github.com/SiraGPT-ORg/siraGPT/pull/17', state: 'open' } };
        },
      },
    },
  };

  const result = await publishSelfHostedPullRequest({
    runner,
    projectId: 'p1',
    runId: 'selfhost-p1',
    repositoryUrl: 'https://github.com/SiraGPT-ORg/siraGPT.git',
    sourceBranch: 'main',
    title: `  Mejora segura\n${'x'.repeat(200)}  `,
    body: `Resumen\0${'y'.repeat(70_000)}`,
    allowedRepositories: ['https://github.com/SiraGPT-ORg/siraGPT.git'],
    env: { CODEX_SELF_HOST_GITHUB_TOKEN: 'test-token' },
    octokitFactory: async ({ token }) => {
      assert.equal(token, 'test-token');
      return octokit;
    },
  });

  assert.equal(result.status, 'pull_request_opened');
  assert.equal(result.pullRequest.number, 17);
  assert.equal(result.files, 1);
  assert.equal(result.deleted, 1);
  const commitCall = calls.find(([name]) => name === 'createCommit')[1];
  const pullCall = calls.find(([name]) => name === 'createPull')[1];
  assert.equal(commitCall.message.includes('\n'), false);
  assert.ok(commitCall.message.length <= 120);
  assert.equal(pullCall.title, commitCall.message);
  assert.ok(pullCall.body.length <= 60_000);
  assert.equal(pullCall.body.includes('\0'), false);
  assert.equal(calls.some(([name]) => name === 'merge'), false);
  assert.equal(calls.some(([name]) => name === 'updateRef'), false);
});

test('OT-10: self-hosting blocks reserved paths, secret content and stale remote bases', async () => {
  assert.throws(
    () => assertPublishableFile('.env.production', 'SAFE=value\n'),
    (error) => error.code === 'pull_request_sensitive_path',
  );
  assert.throws(
    () => assertPublishableFile('src/config.js', `const token = "github_pat_${'a'.repeat(30)}";\n`),
    (error) => error.code === 'pull_request_secret_detected',
  );

  const apiCalls = [];
  const octokit = {
    rest: {
      git: {
        async getRef() { return { data: { object: { sha: 'remote-new-sha' } } }; },
        async getCommit() { return { data: { tree: { sha: 'base-tree' } } }; },
        async createBlob(args) { apiCalls.push(['createBlob', args]); return { data: { sha: 'blob' } }; },
      },
      pulls: {
        async create(args) { apiCalls.push(['createPull', args]); return { data: {} }; },
      },
    },
  };
  const runner = {
    async exec(_projectId, command) {
      if (command.join(' ') === 'git rev-parse main') {
        return { exitCode: 0, stdout: 'local-old-sha\n', stderr: '' };
      }
      throw new Error(`unexpected command: ${command.join(' ')}`);
    },
  };
  await assert.rejects(
    () => publishSelfHostedPullRequest({
      runner,
      projectId: 'p1',
      runId: 'stale-run',
      repositoryUrl: 'https://github.com/SiraGPT-ORg/siraGPT.git',
      sourceBranch: 'main',
      allowedRepositories: ['https://github.com/SiraGPT-ORg/siraGPT.git'],
      env: { CODEX_SELF_HOST_GITHUB_TOKEN: 'test-token' },
      octokitFactory: async () => octokit,
    }),
    (error) => error.code === 'base_branch_diverged',
  );
  assert.deepEqual(apiCalls, []);
});

test('OT-12: session artifact store rejects a zero-write runner response', async () => {
  const store = createRunnerArtifactStore({
    async readFile() { return { content: '' }; },
    async writeFiles() { return { ok: true, written: 0 }; },
  });
  await assert.rejects(
    () => store.writeText('p1', '.sira/sessions/r1.jsonl', '{}\n'),
    /artifact_write_failed/,
  );
});

function projectDb() {
  const rows = new Map();
  return {
    rows,
    codexProject: {
      async create({ data }) {
        const row = {
          id: 'p1',
          workspacePath: null,
          previewUrl: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.set(row.id, row);
        return { ...row };
      },
      async update({ where, data }) {
        const row = { ...rows.get(where.id), ...data, updatedAt: new Date() };
        rows.set(row.id, row);
        return { ...row };
      },
    },
  };
}

test('OT-10: project-service provisions repo projects through self-hosting and returns PR-ready output', async () => {
  const db = projectDb();
  const preparedCalls = [];
  const selfHosting = {
    async prepareSelfHostedProject(request) {
      preparedCalls.push(request);
      return {
        ok: true,
        workspacePath: 'projects/p1',
        repository: { webUrl: 'https://github.com/SiraGPT-ORg/siraGPT' },
        sourceBranch: 'main',
        workBranch: 'run/selfhost-p1',
        commitSha: '0123456789abcdef',
        pullRequest: { status: 'prepared', mergePolicy: 'pull_request_only' },
      };
    },
  };
  const project = await createProject({
    userId: 'u1',
    name: 'SiraGPT self-host',
    brief: 'Mejora el propio producto',
    repository: {
      url: 'https://github.com/SiraGPT-ORg/siraGPT.git',
      sourceBranch: 'main',
    },
    runner: {},
    db,
    env: {},
    selfHosting,
    selfHostAllowedRepositories: ['https://github.com/SiraGPT-ORg/siraGPT.git'],
  });
  assert.equal(project.status, 'ready');
  assert.equal(project.kind, 'repo');
  assert.equal(project.pullRequest.mergePolicy, 'pull_request_only');
  assert.equal(preparedCalls.length, 1);
  assert.equal(db.rows.get('p1').brief.repository.url, 'https://github.com/SiraGPT-ORg/siraGPT.git');
});
