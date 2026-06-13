'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cp = require('../src/services/codex/checkpoint-service');

// Fake runner that dispatches on the git subcommand. `state` controls outputs.
function makeRunner(state = {}) {
  const calls = [];
  const exec = async (project, cmd) => {
    calls.push(cmd.join(' '));
    const sub = cmd[1];
    if (cmd[0] === 'git' && sub === 'status') return { exitCode: 0, stdout: state.porcelain ?? '', stderr: '' };
    if (cmd[0] === 'git' && sub === 'add') return { exitCode: 0, stdout: '', stderr: '' };
    if (cmd[0] === 'git' && cmd.includes('commit')) return { exitCode: 0, stdout: '', stderr: '' };
    if (cmd[0] === 'git' && sub === 'rev-parse' && cmd.includes('HEAD')) return { exitCode: 0, stdout: `${state.sha || 'abc1234'}\n`, stderr: '' };
    if (cmd[0] === 'git' && sub === 'rev-parse' && cmd.includes('--verify')) return { exitCode: state.hasParent === false ? 1 : 0, stdout: '', stderr: '' };
    if (cmd[0] === 'git' && sub === 'reset') return { exitCode: state.resetFails ? 1 : 0, stdout: '', stderr: state.resetFails ? 'fatal' : '' };
    if (cmd[0] === 'git' && sub === 'diff' && cmd.includes('--shortstat')) return { exitCode: 0, stdout: state.shortstat || ' 2 files changed, 10 insertions(+), 3 deletions(-)', stderr: '' };
    if (cmd[0] === 'git' && sub === 'diff') return { exitCode: 0, stdout: state.diff || 'diff --git a/x b/x', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return {
    calls,
    exec,
    devStatus: async () => state.devStatus || { running: false },
    stopDev: async () => { calls.push('stopDev'); return { ok: true }; },
    startDev: async () => { calls.push('startDev'); return { ok: true }; },
  };
}

function makeDb(checkpoints = []) {
  let id = 0;
  return {
    codexCheckpoint: {
      async create({ data }) { const row = { id: `cp-${++id}`, createdAt: new Date('2026-06-13T00:00:00Z'), ...data }; checkpoints.push(row); return row; },
      async findFirst({ where }) {
        return checkpoints.find((c) => c.id === where.id && (!where.project || c._userId === where.project.userId)) || null;
      },
      async findMany() { return checkpoints; },
    },
    codexProject: { async findFirst({ where }) { return where.id === 'p1' && where.userId === 'u1' ? { id: 'p1', userId: 'u1' } : null; } },
    _checkpoints: checkpoints,
  };
}

test('createCheckpoint commits when there are changes and emits checkpoint_created', async () => {
  const runner = makeRunner({ porcelain: ' M index.html\n', sha: 'deadbee' });
  const events = [];
  const db = makeDb();
  const eventStore = { appendEvent: async (runId, type, data) => events.push({ type, data }) };
  const out = await cp.createCheckpoint({ run: { id: 'run-1', prompt: 'haz x' }, project: { id: 'p1' }, deps: { runner, prisma: db, eventStore, llmTurn: null } });
  assert.ok(out);
  assert.equal(out.commitSha, 'deadbee');
  assert.match(out.title, /feat\(codex\): cambios de la corrida run-1/);
  assert.equal(events[0].type, 'checkpoint_created');
  assert.equal(events[0].data.commitSha, 'deadbee');
});

test('createCheckpoint returns null on a clean tree (no card)', async () => {
  const runner = makeRunner({ porcelain: '' });
  const db = makeDb();
  const out = await cp.createCheckpoint({ run: { id: 'run-1' }, project: { id: 'p1' }, deps: { runner, prisma: db, eventStore: { appendEvent: async () => {} } } });
  assert.equal(out, null);
  assert.equal(db._checkpoints.length, 0);
});

test('generateCheckpointTitle uses the LLM line and falls back deterministically', async () => {
  const good = await cp.generateCheckpointTitle({ run: { id: 'r1' }, changedFiles: 'x', llmTurn: async () => ({ text: '"feat(ui): agrega header"\n' }) });
  assert.equal(good, 'feat(ui): agrega header');
  const fb = await cp.generateCheckpointTitle({ run: { id: 'abcdef12345' }, changedFiles: 'x', llmTurn: async () => { throw new Error('down'); } });
  assert.match(fb, /^feat\(codex\): cambios de la corrida abcdef12/);
});

test('rollback stops dev, resets hard, and restarts only if it was running', async () => {
  const runner = makeRunner({ devStatus: { running: true, project: 'p1' } });
  const db = makeDb([{ id: 'cp-1', commitSha: 'abc1234', projectId: 'p1', _userId: 'u1' }]);
  const out = await cp.rollbackCheckpoint({ checkpointId: 'cp-1', userId: 'u1', deps: { runner, prisma: db } });
  assert.equal(out.ok, true);
  assert.equal(out.restarted, true);
  const seq = runner.calls;
  assert.ok(seq.indexOf('stopDev') < seq.findIndex((c) => c.startsWith('git reset')));
  assert.ok(seq.findIndex((c) => c.startsWith('git reset')) < seq.indexOf('startDev'));
});

test('rollback does not restart dev when it was not running', async () => {
  const runner = makeRunner({ devStatus: { running: false } });
  const db = makeDb([{ id: 'cp-1', commitSha: 'abc1234', projectId: 'p1', _userId: 'u1' }]);
  const out = await cp.rollbackCheckpoint({ checkpointId: 'cp-1', userId: 'u1', deps: { runner, prisma: db } });
  assert.equal(out.restarted, false);
  assert.equal(runner.calls.includes('startDev'), false);
});

test('rollback 404s a foreign checkpoint and 500s on reset failure', async () => {
  const db = makeDb([{ id: 'cp-1', commitSha: 'abc1234', projectId: 'p1', _userId: 'u1' }]);
  const foreign = await cp.rollbackCheckpoint({ checkpointId: 'cp-1', userId: 'someone', deps: { runner: makeRunner(), prisma: db } });
  assert.equal(foreign.status, 404);
  const fail = await cp.rollbackCheckpoint({ checkpointId: 'cp-1', userId: 'u1', deps: { runner: makeRunner({ resetFails: true }), prisma: db } });
  assert.equal(fail.status, 500);
});

test('diff returns unified diff + shortstat; first commit (no parent) uses the empty tree', async () => {
  const db = makeDb([{ id: 'cp-1', commitSha: 'abc1234', projectId: 'p1', _userId: 'u1' }]);
  const runnerWithParent = makeRunner({ diff: 'diff --git a/x b/x\n+hello', shortstat: ' 1 file changed, 1 insertion(+)' });
  const d1 = await cp.getCheckpointDiff({ checkpointId: 'cp-1', userId: 'u1', deps: { runner: runnerWithParent, prisma: db } });
  assert.equal(d1.additions, 1);
  assert.equal(d1.deletions, 0);
  assert.match(d1.diff, /hello/);

  const runnerFirst = makeRunner({ hasParent: false });
  const d2 = await cp.getCheckpointDiff({ checkpointId: 'cp-1', userId: 'u1', deps: { runner: runnerFirst, prisma: db } });
  assert.equal(d2.ok, true);
  assert.ok(runnerFirst.calls.some((c) => c.includes(cp.EMPTY_TREE)));
});

test('diff truncates very large output with a marker', async () => {
  const big = 'x'.repeat(600_000);
  const db = makeDb([{ id: 'cp-1', commitSha: 'abc1234', projectId: 'p1', _userId: 'u1' }]);
  const out = await cp.getCheckpointDiff({ checkpointId: 'cp-1', userId: 'u1', deps: { runner: makeRunner({ diff: big }), prisma: db } });
  assert.equal(out.truncated, true);
  assert.match(out.diff, /diff truncado/);
});

test('parseShortstat handles all combinations', () => {
  assert.deepEqual(cp.parseShortstat(' 3 files changed, 45 insertions(+), 12 deletions(-)'), { filesChanged: 3, additions: 45, deletions: 12 });
  assert.deepEqual(cp.parseShortstat(' 1 file changed, 2 insertions(+)'), { filesChanged: 1, additions: 2, deletions: 0 });
  assert.deepEqual(cp.parseShortstat(''), { filesChanged: 0, additions: 0, deletions: 0 });
});

test('isValidSha guards the sha format', () => {
  assert.equal(cp.isValidSha('abc1234'), true);
  assert.equal(cp.isValidSha('ABC1234'), false);
  assert.equal(cp.isValidSha('xyz; rm -rf /'), false);
  assert.equal(cp.isValidSha('abc'), false);
});
