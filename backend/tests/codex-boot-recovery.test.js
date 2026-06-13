'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { recoverCodexRunsAfterBoot, INTERRUPTED_MSG } = require('../src/services/codex/boot-recovery');

afterEach(() => { delete process.env.CODEX_AGENT_V2; });

function makeDeps(runs) {
  const events = [];
  const enqueued = [];
  const prisma = {
    codexRun: {
      async findMany({ where }) { return runs.filter((r) => r.status === where.status); },
      async update({ where, data }) { const r = runs.find((x) => x.id === where.id); Object.assign(r, data); return r; },
    },
  };
  const queue = {
    peekCodexJob: async (runId) => (runs.find((r) => r.id === runId)?._hasJob ? { id: runId } : null),
    enqueueCodexRun: async ({ runId }) => { enqueued.push(runId); return { id: runId }; },
  };
  const eventStore = { appendEvent: async (runId, type, data) => { events.push({ runId, type, data }); } };
  return { prisma, queue, eventStore, events, enqueued };
}

test('flag off ⇒ recovery is a no-op', async () => {
  delete process.env.CODEX_AGENT_V2;
  const d = makeDeps([{ id: 'r1', status: 'running' }]);
  const res = await recoverCodexRunsAfterBoot({ prisma: d.prisma, queue: d.queue, eventStore: d.eventStore, env: { NODE_ENV: 'test' } });
  assert.deepEqual(res, { erroredRunning: 0, reenqueuedQueued: 0, scanned: 0 });
});

test('running runs are marked error with a terminal event', async () => {
  const runs = [{ id: 'r1', status: 'running' }, { id: 'r2', status: 'running' }];
  const d = makeDeps(runs);
  const res = await recoverCodexRunsAfterBoot({
    prisma: d.prisma, queue: d.queue, eventStore: d.eventStore, env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
  });
  assert.equal(res.erroredRunning, 2);
  assert.equal(runs[0].status, 'error');
  assert.equal(runs[0].error, INTERRUPTED_MSG);
  assert.ok(runs[0].finishedAt);
  const errEvents = d.events.filter((e) => e.type === 'run_status' && e.data.status === 'error');
  assert.equal(errEvents.length, 2);
});

test('queued runs with no live job are re-enqueued; those with a job are left alone', async () => {
  const runs = [
    { id: 'q1', status: 'queued', _hasJob: false },
    { id: 'q2', status: 'queued', _hasJob: true },
  ];
  const d = makeDeps(runs);
  const res = await recoverCodexRunsAfterBoot({
    prisma: d.prisma, queue: d.queue, eventStore: d.eventStore, env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
  });
  assert.equal(res.reenqueuedQueued, 1);
  assert.deepEqual(d.enqueued, ['q1']);
});

test('a DB failure never throws out of the sweep', async () => {
  const prisma = { codexRun: { async findMany() { throw new Error('db down'); } } };
  const res = await recoverCodexRunsAfterBoot({ prisma, env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' } });
  assert.deepEqual(res, { erroredRunning: 0, reenqueuedQueued: 0, scanned: 0 });
});
