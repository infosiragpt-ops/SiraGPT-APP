'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  recoverCodexRunsAfterBoot,
  reconcileQueuedCodexRuns,
  resumeDeferredSwarmRuns,
  resumeDeferredSwarmRunsReliably,
  startQueuedRunReconciler,
  stopQueuedRunReconciler,
  INTERRUPTED_MSG,
  PAUSED_SWARM_MARKER,
  RESUME_MARKER,
  MAX_BOOT_RESUMES,
  TERMINAL_SWARM_MSG,
} = require('../src/services/codex/boot-recovery');

afterEach(async () => {
  delete process.env.CODEX_AGENT_V2;
  await stopQueuedRunReconciler();
});

const EMPTY = {
  erroredRunning: 0,
  resumedRunning: 0,
  reenqueuedQueued: 0,
  terminalized: 0,
  deferredPaused: 0,
  scanned: 0,
};

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
  for (const e of d.enqueued) assert.equal(e.jobId, `${e.runId}-r1`);
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
  assert.match(String(d.enqueued[0].jobId), /^q1-rq\d+$/);
});

test('cancelled swarm runs are finalized instead of resumed or re-enqueued', async () => {
  const runs = [
    { id: 'swarm-running', status: 'running', swarmTaskId: 'task-running' },
    { id: 'swarm-queued', status: 'queued', swarmTaskId: 'task-queued' },
  ];
  const d = makeDeps(runs);
  d.prisma.codexSwarmTask = {
    findUnique: async ({ where }) => ({
      id: where.id,
      swarm: {
        id: 'swarm-cancelled',
        status: 'cancelled',
        cancelRequestedAt: new Date('2026-08-11T12:00:00.000Z'),
      },
    }),
  };

  const res = await recoverCodexRunsAfterBoot({
    prisma: d.prisma,
    queue: d.queue,
    eventStore: d.eventStore,
    env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
  });

  assert.equal(res.scanned, 2);
  assert.deepEqual(d.enqueued, []);
  assert.deepEqual(runs.map((run) => run.status), ['cancelled', 'cancelled']);
  assert.equal(
    d.events.filter((event) => event.type === 'run_status' && event.data.status === 'cancelled').length,
    2,
  );
});

test('terminal swarms close orphaned runs instead of leaving active blockers', async () => {
  const runs = [
    { id: 'swarm-running', status: 'running', swarmTaskId: 'task-running' },
    { id: 'swarm-queued', status: 'queued', swarmTaskId: 'task-queued' },
  ];
  const d = makeDeps(runs);
  d.prisma.codexSwarmTask = {
    findUnique: async ({ where }) => ({
      id: where.id,
      swarm: {
        id: 'swarm-completed',
        status: 'completed',
        cancelRequestedAt: null,
      },
    }),
  };

  const res = await recoverCodexRunsAfterBoot({
    prisma: d.prisma,
    queue: d.queue,
    eventStore: d.eventStore,
    env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
  });

  assert.equal(res.terminalized, 2);
  assert.deepEqual(d.enqueued, []);
  for (const run of runs) {
    assert.equal(run.status, 'error');
    assert.match(run.error, new RegExp(TERMINAL_SWARM_MSG));
    assert.ok(run.finishedAt);
  }
  assert.equal(
    d.events.filter((event) => event.type === 'run_status'
      && event.data.reason === 'swarm_terminal').length,
    2,
  );
});

test('pause → restart → resume defers the orphan and re-enqueues it exactly once', async () => {
  const resumedAt = new Date('2026-08-11T16:00:00.000Z');
  const runs = [{
    id: 'run-paused',
    projectId: 'project-1',
    status: 'running',
    swarmTaskId: 'task-paused',
    jobId: 'run-paused-old',
    updatedAt: new Date(resumedAt.getTime() - 120_000),
  }];
  let swarmStatus = 'paused';
  const deps = makePeriodicDeps(runs);
  deps.prisma.codexSwarmTask = {
    async findUnique() {
      return {
        id: 'task-paused',
        swarm: { id: 'swarm-paused', status: swarmStatus, cancelRequestedAt: null },
      };
    },
    async findMany({ where }) {
      return where.swarmId === 'swarm-paused' ? [{ id: 'task-paused' }] : [];
    },
  };
  const events = [];
  const eventStore = {
    async appendEvent(runId, type, data) { events.push({ runId, type, data }); },
    async listEvents() { return []; },
  };

  const boot = await recoverCodexRunsAfterBoot({
    prisma: deps.prisma,
    queue: deps.queue,
    eventStore,
    env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
    clock: () => resumedAt,
  });
  assert.equal(boot.deferredPaused, 1);
  assert.equal(boot.resumedRunning, 0);
  assert.equal(runs[0].status, 'queued');
  assert.deepEqual(deps.enqueued, []);
  assert.ok(events.some((event) => (
    event.type === 'narrative_delta' && String(event.data.text).includes(PAUSED_SWARM_MARKER)
  )));

  swarmStatus = 'running';
  const resumed = await resumeDeferredSwarmRuns({
    prisma: deps.prisma,
    queue: deps.queue,
    eventStore,
    swarmId: 'swarm-paused',
    env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
    clock: () => resumedAt,
    sessionService: {
      async readSnapshot() {
        return {
          version: 1,
          sessionId: 'run-paused',
          cursorSeq: 7,
          checkpointSha: 'abcdef1',
          loopState: { summary: 'durable' },
        };
      },
    },
  });
  assert.equal(resumed.reenqueued, 1);
  assert.equal(resumed.live, 0);
  assert.equal(deps.enqueued.length, 1);
  assert.equal(deps.enqueued[0].runId, 'run-paused');
  assert.match(deps.enqueued[0].jobId, /^run-paused-sr\d+-1$/);
  assert.deepEqual(deps.enqueued[0].resumeSnapshot, {
    sessionId: 'run-paused',
    cursorSeq: 7,
    checkpointSha: 'abcdef1',
  });

  const duplicateResume = await resumeDeferredSwarmRuns({
    prisma: deps.prisma,
    queue: deps.queue,
    eventStore,
    swarmId: 'swarm-paused',
    env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
    clock: () => new Date(resumedAt.getTime() + 1),
  });
  assert.equal(duplicateResume.reenqueued, 0);
  assert.equal(duplicateResume.live, 1);
  assert.equal(deps.enqueued.length, 1, 'a live resume job must never be duplicated');
});

test('reliable deferred resume retries a transient enqueue failure and reports final success', async () => {
  const now = new Date('2026-08-11T16:30:00.000Z');
  const runs = [{
    id: 'run-retry',
    projectId: 'project-1',
    status: 'queued',
    swarmTaskId: 'task-retry',
    jobId: 'run-retry-old',
    updatedAt: new Date(now.getTime() - 60_000),
  }];
  const deps = makePeriodicDeps(runs);
  deps.prisma.codexSwarmTask = {
    async findUnique() {
      return {
        id: 'task-retry',
        swarm: { id: 'swarm-retry', status: 'running', cancelRequestedAt: null },
      };
    },
    async findMany() { return [{ id: 'task-retry' }]; },
  };
  let enqueueAttempts = 0;
  const live = new Set();
  const queue = {
    async peekLiveCodexJob(jobId) {
      return live.has(String(jobId)) ? { id: String(jobId) } : null;
    },
    async enqueueCodexRun(payload) {
      enqueueAttempts += 1;
      if (enqueueAttempts === 1) throw new Error('temporary redis outage');
      live.add(payload.jobId);
      return { id: payload.jobId };
    },
  };

  const result = await resumeDeferredSwarmRunsReliably({
    prisma: deps.prisma,
    queue,
    eventStore: null,
    swarmId: 'swarm-retry',
    env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
    clock: () => now,
  });

  assert.equal(result.complete, true);
  assert.equal(result.attemptCount, 2);
  assert.equal(result.attempts[0].failed, 1);
  assert.equal(result.reenqueued, 1);
  assert.equal(result.failed, 0);
  assert.equal(enqueueAttempts, 2);
  assert.ok(live.has(runs[0].jobId));
});

test('reliable deferred resume exposes a persistent enqueue failure as incomplete', async () => {
  const now = new Date('2026-08-11T16:45:00.000Z');
  const runs = [{
    id: 'run-stuck',
    projectId: 'project-1',
    status: 'queued',
    swarmTaskId: 'task-stuck',
    jobId: null,
    updatedAt: new Date(now.getTime() - 60_000),
  }];
  const deps = makePeriodicDeps(runs);
  deps.prisma.codexSwarmTask = {
    async findUnique() {
      return {
        id: 'task-stuck',
        swarm: { id: 'swarm-stuck', status: 'running', cancelRequestedAt: null },
      };
    },
    async findMany() { return [{ id: 'task-stuck' }]; },
  };
  let enqueueAttempts = 0;
  const result = await resumeDeferredSwarmRunsReliably({
    prisma: deps.prisma,
    queue: {
      async peekLiveCodexJob() { return null; },
      async enqueueCodexRun() {
        enqueueAttempts += 1;
        throw new Error('redis unavailable');
      },
    },
    swarmId: 'swarm-stuck',
    env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
    clock: () => now,
  });

  assert.equal(result.complete, false);
  assert.equal(result.attemptCount, 2);
  assert.equal(result.failed, 1);
  assert.equal(enqueueAttempts, 2);
  assert.ok(result.attempts.every((attempt) => attempt.failed === 1));
});

test('concurrent boot sweeps claim a running run only once', async () => {
  const runs = [{ id: 'r1', status: 'running' }];
  const enqueued = [];
  const prisma = {
    codexRun: {
      async findMany({ where }) { return runs.filter((run) => run.status === where.status); },
      async updateMany({ where, data }) {
        const run = runs.find((candidate) => candidate.id === where.id && candidate.status === where.status);
        if (!run) return { count: 0 };
        Object.assign(run, data);
        return { count: 1 };
      },
    },
  };
  const queue = { async enqueueCodexRun(payload) { enqueued.push(payload); } };
  const eventStore = { async listEvents() { return []; }, async appendEvent() {} };
  const options = { prisma, queue, eventStore, env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' } };
  const [first, second] = await Promise.all([
    recoverCodexRunsAfterBoot(options),
    recoverCodexRunsAfterBoot(options),
  ]);
  assert.equal(first.resumedRunning + second.resumedRunning, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(runs[0].status, 'queued');
});

test('a DB failure never throws out of the sweep', async () => {
  const prisma = { codexRun: { async findMany() { throw new Error('db down'); } } };
  const res = await recoverCodexRunsAfterBoot({ prisma, env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' } });
  assert.deepEqual(res, EMPTY);
});

function makePeriodicDeps(runs, { liveJobIds = [], enqueueFailure = null } = {}) {
  const enqueued = [];
  const live = new Set(liveJobIds);
  const matchesWhere = (run, where) => {
    if (where.id != null && run.id !== where.id) return false;
    if (where.status != null && run.status !== where.status) return false;
    if (Object.prototype.hasOwnProperty.call(where, 'jobId') && run.jobId !== where.jobId) return false;
    if (where.swarmTaskId?.in && !where.swarmTaskId.in.includes(run.swarmTaskId)) return false;
    if (where.updatedAt?.lte && new Date(run.updatedAt) > new Date(where.updatedAt.lte)) return false;
    if (where.updatedAt instanceof Date && new Date(run.updatedAt).getTime() !== where.updatedAt.getTime()) return false;
    return true;
  };
  const prisma = {
    codexRun: {
      async findMany({ where, orderBy, take }) {
        const rows = runs.filter((run) => matchesWhere(run, where));
        if (orderBy?.updatedAt === 'asc') {
          rows.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
        }
        return Number.isFinite(take) ? rows.slice(0, take) : rows;
      },
      async updateMany({ where, data }) {
        const matched = runs.filter((run) => matchesWhere(run, where));
        for (const run of matched) Object.assign(run, data);
        return { count: matched.length };
      },
    },
  };
  const queue = {
    async peekLiveCodexJob(jobId) {
      return live.has(String(jobId)) ? { id: String(jobId) } : null;
    },
    async enqueueCodexRun(payload) {
      if (enqueueFailure) throw enqueueFailure;
      enqueued.push(payload);
      live.add(String(payload.jobId));
      return { id: payload.jobId };
    },
  };
  return { prisma, queue, enqueued };
}

test('periodic reconciliation only leases stale queued rows and persists the recovered job id', async () => {
  const now = new Date('2026-08-11T15:00:00.000Z');
  const runs = [
    { id: 'stale', status: 'queued', jobId: null, updatedAt: new Date(now.getTime() - 60_000) },
    { id: 'live', status: 'queued', jobId: 'live:job', updatedAt: new Date(now.getTime() - 60_000) },
    { id: 'fresh', status: 'queued', jobId: null, updatedAt: new Date(now.getTime() - 5_000) },
  ];
  const deps = makePeriodicDeps(runs, { liveJobIds: ['live:job'] });
  const result = await reconcileQueuedCodexRuns({
    prisma: deps.prisma,
    queue: deps.queue,
    env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
    clock: () => now,
    staleAfterMs: 30_000,
  });

  assert.equal(result.scanned, 2);
  assert.equal(result.reenqueuedQueued, 1);
  assert.equal(result.liveQueued, 1);
  assert.deepEqual(deps.enqueued.map((entry) => entry.runId), ['stale']);
  assert.match(runs[0].jobId, /^stale-qr\d+$/);
  assert.equal(runs[2].jobId, null);
});

test('live queued jobs rotate out of a bounded scan so a later orphan is recovered next tick', async () => {
  const now = new Date('2026-08-11T15:00:00.000Z');
  const originalLiveUpdatedAt = new Date(now.getTime() - 90_000);
  const runs = [
    { id: 'live-1', status: 'queued', jobId: 'job-live-1', updatedAt: originalLiveUpdatedAt },
    { id: 'live-2', status: 'queued', jobId: 'job-live-2', updatedAt: new Date(now.getTime() - 80_000) },
    { id: 'orphan-3', status: 'queued', jobId: null, updatedAt: new Date(now.getTime() - 70_000) },
  ];
  const deps = makePeriodicDeps(runs, { liveJobIds: ['job-live-1', 'job-live-2'] });
  const options = {
    prisma: deps.prisma,
    queue: deps.queue,
    env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
    clock: () => now,
    staleAfterMs: 30_000,
    batchSize: 2,
  };

  const first = await reconcileQueuedCodexRuns(options);
  assert.equal(first.scanned, 2);
  assert.equal(first.liveQueued, 2);
  assert.equal(first.reenqueuedQueued, 0);
  assert.deepEqual(deps.enqueued, []);
  assert.deepEqual(
    runs.slice(0, 2).map(({ id, status, jobId }) => ({ id, status, jobId })),
    [
      { id: 'live-1', status: 'queued', jobId: 'job-live-1' },
      { id: 'live-2', status: 'queued', jobId: 'job-live-2' },
    ],
  );
  assert.equal(runs[0].updatedAt.getTime(), now.getTime());
  assert.equal(runs[1].updatedAt.getTime(), now.getTime());

  const second = await reconcileQueuedCodexRuns(options);
  assert.equal(second.scanned, 1);
  assert.equal(second.liveQueued, 0);
  assert.equal(second.reenqueuedQueued, 1);
  assert.deepEqual(deps.enqueued.map((entry) => entry.runId), ['orphan-3']);
  assert.match(runs[2].jobId, /^orphan-3-qr\d+$/);
});

test('paused queued rows beyond the batch limit rotate and cannot starve an active orphan', async () => {
  const now = new Date('2026-08-11T15:00:00.000Z');
  const pausedRuns = Array.from({ length: 5 }, (_, index) => ({
    id: `paused-${index + 1}`,
    status: 'queued',
    jobId: null,
    swarmTaskId: `task-paused-${index + 1}`,
    updatedAt: new Date(now.getTime() - (120_000 - index * 1_000)),
  }));
  const orphan = {
    id: 'active-orphan',
    status: 'queued',
    jobId: null,
    updatedAt: new Date(now.getTime() - 100_000),
  };
  const runs = [...pausedRuns, orphan];
  const deps = makePeriodicDeps(runs);
  deps.prisma.codexSwarmTask = {
    async findUnique({ where }) {
      return {
        id: where.id,
        swarm: { id: 'swarm-paused', status: 'paused', cancelRequestedAt: null },
      };
    },
  };
  const options = {
    prisma: deps.prisma,
    queue: deps.queue,
    env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
    clock: () => now,
    staleAfterMs: 30_000,
    batchSize: 2,
  };

  const first = await reconcileQueuedCodexRuns(options);
  const second = await reconcileQueuedCodexRuns(options);
  const third = await reconcileQueuedCodexRuns(options);

  assert.equal(first.deferredPaused, 2);
  assert.equal(second.deferredPaused, 2);
  assert.equal(third.deferredPaused, 1);
  assert.equal(third.reenqueuedQueued, 1);
  assert.deepEqual(deps.enqueued.map((entry) => entry.runId), ['active-orphan']);
  assert.ok(pausedRuns.every((run) => run.updatedAt.getTime() === now.getTime()));
});

test('concurrent periodic sweeps enqueue a stale run exactly once', async () => {
  const now = new Date('2026-08-11T15:00:00.000Z');
  const runs = [
    { id: 'q1', status: 'queued', jobId: null, updatedAt: new Date(now.getTime() - 60_000) },
  ];
  const deps = makePeriodicDeps(runs);
  const options = {
    prisma: deps.prisma,
    queue: deps.queue,
    env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
    clock: () => now,
    staleAfterMs: 30_000,
  };
  const [first, second] = await Promise.all([
    reconcileQueuedCodexRuns(options),
    reconcileQueuedCodexRuns(options),
  ]);

  assert.equal(deps.enqueued.length, 1);
  assert.equal(first.reenqueuedQueued + second.reenqueuedQueued, 1);
  assert.equal(
    first.leaseLost + second.leaseLost + first.liveQueued + second.liveQueued,
    1,
  );
});

test('failed periodic enqueue remains recoverable after the bounded lease expires', async () => {
  let now = new Date('2026-08-11T15:00:00.000Z');
  const runs = [
    { id: 'q1', status: 'queued', jobId: null, updatedAt: new Date(now.getTime() - 60_000) },
  ];
  const failed = makePeriodicDeps(runs, { enqueueFailure: new Error('redis unavailable') });
  const base = {
    prisma: failed.prisma,
    queue: failed.queue,
    env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
    clock: () => now,
    staleAfterMs: 30_000,
  };
  const first = await reconcileQueuedCodexRuns(base);
  assert.equal(first.failed, 1);
  assert.equal(runs[0].status, 'queued');

  now = new Date(now.getTime() + 10_000);
  const tooSoon = await reconcileQueuedCodexRuns(base);
  assert.equal(tooSoon.scanned, 0);

  now = new Date(now.getTime() + 21_000);
  const recovered = makePeriodicDeps(runs);
  const retry = await reconcileQueuedCodexRuns({ ...base, queue: recovered.queue });
  assert.equal(retry.reenqueuedQueued, 1);
  assert.equal(recovered.enqueued.length, 1);
});

test('queued reconciler does not overlap ticks and stop waits for in-flight work', async () => {
  let intervalCallback = null;
  let cleared = false;
  const timer = { unref() {} };
  const scheduler = {
    setInterval(callback) {
      intervalCallback = callback;
      return timer;
    },
    clearInterval(value) {
      assert.equal(value, timer);
      cleared = true;
    },
  };
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  assert.equal(startQueuedRunReconciler({
    env: {
      CODEX_AGENT_V2: '1',
      NODE_ENV: 'test',
      CODEX_QUEUED_RECONCILE_INTERVAL_MS: '1000',
    },
    scheduler,
    reconcile: async () => {
      calls += 1;
      await gate;
      return { reenqueuedQueued: 0, cancelled: 0, failed: 0 };
    },
  }), true);

  intervalCallback();
  intervalCallback();
  await Promise.resolve();
  assert.equal(calls, 1);

  let stopped = false;
  const stop = stopQueuedRunReconciler().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(cleared, true);
  assert.equal(stopped, false);
  release();
  await stop;
  assert.equal(stopped, true);
});
