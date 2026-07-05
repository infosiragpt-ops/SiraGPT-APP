'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { recoverCodexRunsAfterBoot, INTERRUPTED_MSG, RESUME_MARKER, MAX_BOOT_RESUMES } = require('../src/services/codex/boot-recovery');

afterEach(() => { delete process.env.CODEX_AGENT_V2; });

const EMPTY = { erroredRunning: 0, resumedRunning: 0, reenqueuedQueued: 0, scanned: 0 };

function makeDeps(runs, priorEvents = []) {
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
    // Mirror the real contract: jobId arrives in the FIRST argument.
    enqueueCodexRun: async ({ runId, jobId }) => { enqueued.push({ runId, jobId }); return { id: jobId || runId }; },
  };
  const eventStore = {
    appendEvent: async (runId, type, data) => { events.push({ runId, type, data }); },
    listEvents: async (runId) => priorEvents.filter((e) => e.runId === runId),
  };
  return { prisma, queue, eventStore, events, enqueued };
}

test('flag off ⇒ recovery is a no-op', async () => {
  delete process.env.CODEX_AGENT_V2;
  const d = makeDeps([{ id: 'r1', status: 'running' }]);
  const res = await recoverCodexRunsAfterBoot({ prisma: d.prisma, queue: d.queue, eventStore: d.eventStore, env: { NODE_ENV: 'test' } });
  assert.deepEqual(res, EMPTY);
});

test('interrupted running runs RESUME: re-queued with resume narrative, error cleared', async () => {
  const runs = [{ id: 'r1', status: 'running' }, { id: 'r2', status: 'running' }];
  const d = makeDeps(runs);
  const res = await recoverCodexRunsAfterBoot({
    prisma: d.prisma, queue: d.queue, eventStore: d.eventStore, env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
  });
  assert.equal(res.resumedRunning, 2);
  assert.equal(res.erroredRunning, 0);
  assert.equal(runs[0].status, 'queued');
  assert.equal(runs[0].error, null);
  const byRun = d.enqueued.map((e) => e.runId).sort();
  assert.deepEqual(byRun, ['r1', 'r2']);
  // The resume MUST carry a unique jobId (runId alone is a BullMQ no-op while
  // the dead original job record lingers in Redis).
  for (const e of d.enqueued) assert.equal(e.jobId, `${e.runId}:r1`);
  const resumeNotes = d.events.filter((e) => e.type === 'narrative_delta' && String(e.data.text).includes(RESUME_MARKER));
  assert.equal(resumeNotes.length, 2);
  const queuedEvents = d.events.filter((e) => e.type === 'run_status' && e.data.status === 'queued');
  assert.equal(queuedEvents.length, 2);
});

test(`after ${MAX_BOOT_RESUMES} resumes the run is marked error (no infinite requeue)`, async () => {
  const runs = [{ id: 'r1', status: 'running' }];
  const prior = Array.from({ length: MAX_BOOT_RESUMES }, () => ({
    runId: 'r1', type: 'narrative_delta', data: { text: `${RESUME_MARKER} — continúo el build donde quedó.` },
  }));
  const d = makeDeps(runs, prior);
  const res = await recoverCodexRunsAfterBoot({
    prisma: d.prisma, queue: d.queue, eventStore: d.eventStore, env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
  });
  assert.equal(res.erroredRunning, 1);
  assert.equal(res.resumedRunning, 0);
  assert.equal(runs[0].status, 'error');
  assert.equal(runs[0].error, INTERRUPTED_MSG);
  assert.ok(runs[0].finishedAt);
  assert.deepEqual(d.enqueued, []);
});

test('no queue available ⇒ falls back to marking error (never leaves a zombie)', async () => {
  const runs = [{ id: 'r1', status: 'running' }];
  const d = makeDeps(runs);
  const res = await recoverCodexRunsAfterBoot({
    prisma: d.prisma, queue: null, eventStore: d.eventStore, env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
  });
  assert.equal(res.erroredRunning, 1);
  assert.equal(runs[0].status, 'error');
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
  assert.equal(d.enqueued.length, 1);
  assert.equal(d.enqueued[0].runId, 'q1');
  assert.match(String(d.enqueued[0].jobId), /^q1:rq\d+$/);
});

test('a DB failure never throws out of the sweep', async () => {
  const prisma = { codexRun: { async findMany() { throw new Error('db down'); } } };
  const res = await recoverCodexRunsAfterBoot({ prisma, env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' } });
  assert.deepEqual(res, EMPTY);
});
