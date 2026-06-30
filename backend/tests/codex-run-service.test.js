'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const runService = require('../src/services/codex/run-service');
const { createRun, cancelRun, getRun, listRuns, RunServiceError } = runService;

// In-memory fake of the Prisma surface run-service touches.
function makeDb({ projects = [], runs = [] } = {}) {
  let id = 0;
  const db = {
    _runs: runs,
    codexProject: {
      async findFirst({ where }) {
        return projects.find((p) => p.id === where.id && p.userId === where.userId) || null;
      },
    },
    codexRun: {
      async findFirst({ where }) {
        return (
          runs.find((r) =>
            Object.entries(where).every(([k, v]) => {
              if (k === 'status' && v && v.in) return v.in.includes(r.status);
              return r[k] === v;
            }),
          ) || null
        );
      },
      async findUnique({ where }) { return runs.find((r) => r.id === where.id) || null; },
      async count({ where }) {
        return runs.filter((r) =>
          r.projectId === where.projectId &&
          where.status.in.includes(r.status) &&
          (!where.id || !where.id.not || r.id !== where.id.not),
        ).length;
      },
      async create({ data }) {
        const row = { id: `run-${++id}`, createdAt: new Date(), startedAt: null, finishedAt: null, jobId: null, ...data };
        runs.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = runs.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const r of runs) {
          const match = Object.entries(where).every(([k, v]) => {
            if (k === 'status' && v && v.in) return v.in.includes(r.status);
            return r[k] === v;
          });
          if (match) { Object.assign(r, data); count += 1; }
        }
        return { count };
      },
      async findMany({ where }) {
        return runs.filter((r) => r.projectId === where.projectId && r.userId === where.userId);
      },
    },
  };
  return db;
}

const fakeQueue = (calls = []) => ({
  enqueueCodexRun: async ({ runId }) => { calls.push(['enqueue', runId]); return { id: `job-${runId}` }; },
  cancelQueuedCodexRun: async (runId) => { calls.push(['cancelQueued', runId]); return { cancelled: true }; },
});
const fakeEventStore = (events = []) => ({ appendEvent: async (runId, type, data) => { events.push({ runId, type, data }); } });

const PROJECT = { id: 'p1', userId: 'u1', name: 'Demo' };

test('createRun rejects an invalid mode', async () => {
  const db = makeDb({ projects: [PROJECT] });
  await assert.rejects(
    () => createRun({ userId: 'u1', projectId: 'p1', mode: 'frobnicate', db, queue: fakeQueue() }),
    (e) => e instanceof RunServiceError && e.code === 'invalid_mode' && e.status === 400,
  );
});

test('createRun 404s when the project is not owned by the user', async () => {
  const db = makeDb({ projects: [PROJECT] });
  await assert.rejects(
    () => createRun({ userId: 'someone-else', projectId: 'p1', mode: 'plan', db, queue: fakeQueue() }),
    (e) => e.code === 'project_not_found' && e.status === 404,
  );
});

test('createRun (plan) enqueues a job and persists jobId', async () => {
  const db = makeDb({ projects: [PROJECT] });
  const calls = [];
  const run = await createRun({ userId: 'u1', projectId: 'p1', mode: 'plan', prompt: 'haz una landing', db, queue: fakeQueue(calls) });
  assert.equal(run.mode, 'plan');
  assert.equal(run.status, 'queued');
  assert.equal(run.prompt, 'haz una landing');
  assert.equal(run.userId, undefined); // projection hides userId
  assert.equal(run.jobId, undefined); // projection hides jobId
  assert.deepEqual(calls.at(-1), ['enqueue', run.id]);
  assert.equal(db._runs.find((r) => r.id === run.id).jobId, `job-${run.id}`);
});

test('createRun (build) requires a valid approvable planRunId', async () => {
  const db = makeDb({ projects: [PROJECT] });
  await assert.rejects(
    () => createRun({ userId: 'u1', projectId: 'p1', mode: 'build', db, queue: fakeQueue() }),
    (e) => e.code === 'plan_run_required',
  );
  // A plan run in the wrong state is rejected.
  db._runs.push({ id: 'plan-x', projectId: 'p1', userId: 'u1', mode: 'plan', status: 'running' });
  await assert.rejects(
    () => createRun({ userId: 'u1', projectId: 'p1', mode: 'build', planRunId: 'plan-x', db, queue: fakeQueue() }),
    (e) => e.code === 'invalid_plan_run',
  );
});

test('createRun (build) succeeds with an approvable plan run', async () => {
  const db = makeDb({ projects: [PROJECT], runs: [{ id: 'plan-ok', projectId: 'p1', userId: 'u1', mode: 'plan', status: 'waiting_approval' }] });
  const run = await createRun({ userId: 'u1', projectId: 'p1', mode: 'build', planRunId: 'plan-ok', db, queue: fakeQueue() });
  assert.equal(run.mode, 'build');
  assert.equal(run.planRunId, 'plan-ok');
});

test('createRun 409s when a run is already active for the project', async () => {
  const db = makeDb({ projects: [PROJECT], runs: [{ id: 'r-active', projectId: 'p1', userId: 'u1', mode: 'plan', status: 'running' }] });
  await assert.rejects(
    () => createRun({ userId: 'u1', projectId: 'p1', mode: 'plan', db, queue: fakeQueue() }),
    (e) => e.code === 'run_in_progress' && e.status === 409,
  );
});

// Postgres-shaped fake: adds the $transaction + $queryRawUnsafe surface so
// createRun takes the advisory-lock-guarded path (the single-active count→create
// is otherwise a TOCTOU race under concurrency).
function makeLockingDb(opts = {}) {
  const db = makeDb(opts);
  const locks = [];
  db._locks = locks;
  db.$queryRawUnsafe = async (sql, klass, objId) => { locks.push({ sql, klass, objId }); return []; };
  db.$transaction = async (fn) => fn(db);
  return db;
}

test('createRun takes the advisory-lock path when the client supports transactions', async () => {
  const db = makeLockingDb({ projects: [PROJECT] });
  const run = await createRun({ userId: 'u1', projectId: 'p1', mode: 'plan', db, queue: fakeQueue() });
  assert.equal(run.status, 'queued');
  assert.equal(db._locks.length, 1, 'a per-project advisory lock was taken');
  assert.match(db._locks[0].sql, /pg_advisory_xact_lock/);
  assert.match(db._locks[0].sql, /SELECT 1::int AS locked/, 'Prisma must not deserialize PostgreSQL void columns');
  assert.equal(typeof db._locks[0].objId, 'number');
});

test('advisory-lock path still enforces single-active inside the transaction', async () => {
  const db = makeLockingDb({ projects: [PROJECT], runs: [{ id: 'r-active', projectId: 'p1', userId: 'u1', mode: 'plan', status: 'queued' }] });
  await assert.rejects(
    () => createRun({ userId: 'u1', projectId: 'p1', mode: 'plan', db, queue: fakeQueue() }),
    (e) => e.code === 'run_in_progress' && e.status === 409,
  );
  assert.equal(db._locks.length, 1, 'lock acquired before the count check');
});

test('cancelRun flips to cancelled, removes the job, and emits one terminal event', async () => {
  const db = makeDb({ projects: [PROJECT], runs: [{ id: 'r1', projectId: 'p1', userId: 'u1', mode: 'build', status: 'running' }] });
  const calls = [];
  const events = [];
  const run = await cancelRun({ userId: 'u1', runId: 'r1', db, queue: fakeQueue(calls), eventStore: fakeEventStore(events) });
  assert.equal(run.status, 'cancelled');
  assert.ok(run.finishedAt);
  assert.deepEqual(calls.find((c) => c[0] === 'cancelQueued'), ['cancelQueued', 'r1']);
  assert.deepEqual(events, [{ runId: 'r1', type: 'run_status', data: { status: 'cancelled' } }]);
});

test('cancelRun 404s for a foreign run and 409s for a terminal one', async () => {
  const db = makeDb({ projects: [PROJECT], runs: [
    { id: 'r1', projectId: 'p1', userId: 'u1', mode: 'build', status: 'done' },
    { id: 'r2', projectId: 'p1', userId: 'other', mode: 'build', status: 'running' },
  ] });
  await assert.rejects(() => cancelRun({ userId: 'u1', runId: 'r2', db, queue: fakeQueue(), eventStore: fakeEventStore() }),
    (e) => e.code === 'run_not_found' && e.status === 404);
  await assert.rejects(() => cancelRun({ userId: 'u1', runId: 'r1', db, queue: fakeQueue(), eventStore: fakeEventStore() }),
    (e) => e.code === 'run_already_terminal' && e.status === 409);
});

test('getRun and listRuns are scoped by userId', async () => {
  const db = makeDb({ projects: [PROJECT], runs: [
    { id: 'r1', projectId: 'p1', userId: 'u1', mode: 'build', status: 'done' },
    { id: 'r2', projectId: 'p1', userId: 'other', mode: 'build', status: 'done' },
  ] });
  assert.equal((await getRun({ userId: 'u1', runId: 'r1', db })).id, 'r1');
  assert.equal(await getRun({ userId: 'u1', runId: 'r2', db }), null); // foreign
  const list = await listRuns({ userId: 'u1', projectId: 'p1', db });
  assert.deepEqual(list.map((r) => r.id), ['r1']);
});

test('cancelRun does not overwrite a run that went terminal between the read and the flip', async () => {
  const db = makeDb({ projects: [PROJECT], runs: [{ id: 'r1', projectId: 'p1', userId: 'u1', mode: 'build', status: 'running' }] });
  const events = [];
  // Simulate the processor stamping the run terminal right after cancelRun's
  // ownership read but before the conditional flip.
  const origFindFirst = db.codexRun.findFirst.bind(db.codexRun);
  db.codexRun.findFirst = async (args) => {
    const row = await origFindFirst(args);
    if (!row) return row;
    const snapshot = { ...row }; // cancelRun sees 'running'
    const real = db._runs.find((r) => r.id === 'r1');
    if (real) real.status = 'done'; // processor finishes concurrently
    return snapshot;
  };
  const run = await cancelRun({ userId: 'u1', runId: 'r1', db, queue: fakeQueue(), eventStore: fakeEventStore(events) });
  // The guarded updateMany found no active row → terminal status preserved…
  assert.equal(run.status, 'done', 'terminal status must not be clobbered to cancelled');
  // …and no duplicate terminal run_status event was emitted.
  assert.equal(events.length, 0, 'no duplicate terminal event');
});
