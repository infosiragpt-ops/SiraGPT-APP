'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const runService = require('../src/services/codex/run-service');
const { createRun, cancelRun, cancelRunFamily, getRun, listRuns, RunServiceError } = runService;

// In-memory fake of the Prisma surface run-service touches.
function makeDb({ projects = [], runs = [] } = {}) {
  let id = 0;
  const matchesWhere = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((branch) => matchesWhere(row, branch));
    if (value && typeof value === 'object' && Array.isArray(value.in)) return value.in.includes(row[key]);
    if (value && typeof value === 'object' && Object.hasOwn(value, 'not')) return row[key] !== value.not;
    return row[key] === value;
  });
  const db = {
    _runs: runs,
    codexProject: {
      async findFirst({ where }) {
        return projects.find((p) => p.id === where.id && p.userId === where.userId) || null;
      },
    },
    codexRun: {
      async findFirst({ where }) {
        return runs.find((run) => matchesWhere(run, where)) || null;
      },
      async findUnique({ where }) { return runs.find((r) => r.id === where.id) || null; },
      async count({ where }) {
        return runs.filter((run) => matchesWhere(run, where)).length;
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
          if (matchesWhere(r, where)) { Object.assign(r, data); count += 1; }
        }
        return { count };
      },
      async findMany({ where }) {
        return runs.filter((run) => matchesWhere(run, where));
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

test('auto-executable plan stores control metadata but exposes a clean prompt', async () => {
  const db = makeDb({ projects: [PROJECT] });
  const run = await createRun({
    userId: 'u1',
    projectId: 'p1',
    mode: 'plan',
    prompt: 'construye una app full-stack',
    autoExecute: true,
    db,
    queue: fakeQueue(),
  });
  assert.equal(run.prompt, 'construye una app full-stack');
  assert.equal(run.autoExecute, true);
  assert.match(db._runs.find((row) => row.id === run.id).prompt, /^\[SIRAGPT_AUTOEXEC_V1\]/);
});

test('pooled swarm runs persist lineage and replay idempotently', async () => {
  const db = makeDb({ projects: [PROJECT] });
  db.codexDepartmentPool = {
    async findFirst({ where }) {
      return where.id === 'pool-engineering'
        && where.projectId === PROJECT.id
        && where.enabled === true
        ? { id: 'pool-engineering' }
        : null;
    },
  };
  db.codexSwarmTask = {
    async findFirst({ where }) {
      return where.id === 'task-1' && where.swarm.projectId === PROJECT.id
        ? {
          id: 'task-1',
          input: { departmentPoolId: 'pool-engineering' },
        }
        : null;
    },
  };
  const calls = [];
  const input = {
    userId: 'u1',
    projectId: 'p1',
    mode: 'plan',
    prompt: 'implementa una tarea aislada',
    idempotencyKey: 'swarm-task:task-1:plan',
    departmentPoolId: 'pool-engineering',
    swarmTaskId: 'task-1',
    db,
    queue: fakeQueue(calls),
  };
  const first = await createRun(input);
  const replay = await createRun(input);

  assert.equal(first.id, replay.id);
  assert.equal(first.departmentPoolId, 'pool-engineering');
  assert.equal(first.swarmTaskId, 'task-1');
  assert.equal(calls.length, 1, 'an idempotent replay must not enqueue twice');
  assert.equal(db._runs.length, 1);
  assert.equal(db._runs[0].idempotencyKey, 'swarm-task:task-1:plan');
});

test('a direct department run accepts a validated pool without requiring a swarm task', async () => {
  const db = makeDb({ projects: [PROJECT] });
  db.codexDepartmentPool = {
    async findFirst({ where }) {
      return where.id === 'pool-support'
        && where.projectId === PROJECT.id
        && where.enabled === true
        ? { id: 'pool-support' }
        : null;
    },
  };
  const run = await createRun({
    userId: 'u1',
    projectId: 'p1',
    mode: 'plan',
    prompt: 'mejora el soporte',
    departmentPoolId: 'pool-support',
    db,
    queue: fakeQueue(),
  });

  assert.equal(run.departmentPoolId, 'pool-support');
  assert.equal(run.swarmTaskId, null);
});

test('swarm lineage validation fails closed and build continuations cannot switch pools', async () => {
  const noStore = makeDb({ projects: [PROJECT] });
  await assert.rejects(
    () => createRun({
      userId: 'u1',
      projectId: 'p1',
      mode: 'plan',
      departmentPoolId: 'pool-engineering',
      db: noStore,
      queue: fakeQueue(),
    }),
    (error) => error.code === 'department_pool_store_unavailable' && error.status === 503,
  );

  const db = makeDb({
    projects: [PROJECT],
    runs: [{
      id: 'plan-pooled',
      projectId: 'p1',
      userId: 'u1',
      mode: 'plan',
      status: 'waiting_approval',
      departmentPoolId: 'pool-engineering',
      swarmTaskId: 'task-1',
    }],
  });
  await assert.rejects(
    () => createRun({
      userId: 'u1',
      projectId: 'p1',
      mode: 'build',
      planRunId: 'plan-pooled',
      departmentPoolId: 'pool-sales',
      db,
      queue: fakeQueue(),
    }),
    (error) => error.code === 'run_lineage_mismatch' && error.status === 409,
  );
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
  const events = [];
  const finishedAt = new Date('2026-07-27T12:00:00.000Z');
  const run = await createRun({
    userId: 'u1',
    projectId: 'p1',
    mode: 'build',
    planRunId: 'plan-ok',
    db,
    queue: fakeQueue(),
    eventStore: fakeEventStore(events),
    clock: () => finishedAt,
  });
  assert.equal(run.mode, 'build');
  assert.equal(run.planRunId, 'plan-ok');
  assert.equal(db._runs.find((row) => row.id === 'plan-ok').status, 'done');
  assert.equal(db._runs.find((row) => row.id === 'plan-ok').finishedAt, finishedAt);
  assert.deepEqual(events, [{
    runId: 'plan-ok',
    type: 'run_status',
    data: { status: 'done', continuationRunId: run.id },
  }]);
});

test('build continuation inherits the exact plan model, tier and reasoning effort', async () => {
  const db = makeDb({
    projects: [PROJECT],
    runs: [{
      id: 'plan-depth',
      projectId: 'p1',
      userId: 'u1',
      mode: 'plan',
      status: 'waiting_approval',
      model: 'gpt-5.4',
      tier: 'power',
      reasoningEffort: 'max',
    }],
  });
  const run = await createRun({
    userId: 'u1',
    projectId: 'p1',
    mode: 'build',
    planRunId: 'plan-depth',
    db,
    queue: fakeQueue(),
    eventStore: fakeEventStore(),
  });

  assert.equal(run.model, 'gpt-5.4');
  assert.equal(run.tier, 'power');
  assert.equal(run.reasoningEffort, 'max');
});

test('createRun rejects unsupported reasoning effort', async () => {
  const db = makeDb({ projects: [PROJECT] });
  await assert.rejects(
    () => createRun({
      userId: 'u1',
      projectId: 'p1',
      mode: 'plan',
      reasoningEffort: 'unbounded',
      db,
      queue: fakeQueue(),
    }),
    (error) => error.code === 'invalid_reasoning_effort' && error.status === 400,
  );
});

test('build creation revalidates a plan cancelled while approval was in flight', async () => {
  const db = makeDb({
    projects: [PROJECT],
    runs: [{ id: 'plan-race', projectId: 'p1', userId: 'u1', mode: 'plan', status: 'waiting_approval' }],
  });
  const originalFindFirst = db.codexRun.findFirst.bind(db.codexRun);
  let planReads = 0;
  db.codexRun.findFirst = async (args) => {
    const row = await originalFindFirst(args);
    if (args.where?.id === 'plan-race' && row && ++planReads === 1) {
      const snapshot = { ...row };
      row.status = 'cancelled';
      return snapshot;
    }
    return row;
  };

  await assert.rejects(
    () => createRun({
      userId: 'u1',
      projectId: 'p1',
      mode: 'build',
      planRunId: 'plan-race',
      db,
      queue: fakeQueue(),
      eventStore: fakeEventStore(),
    }),
    (error) => error.code === 'invalid_plan_run' && error.status === 409,
  );
  assert.equal(db._runs.some((row) => row.mode === 'build'), false);
});

test('build approval is idempotent for the same plan run', async () => {
  const calls = [];
  const db = makeDb({
    projects: [PROJECT],
    runs: [
      { id: 'plan-ok', projectId: 'p1', userId: 'u1', mode: 'plan', status: 'waiting_approval' },
      { id: 'build-existing', projectId: 'p1', userId: 'u1', mode: 'build', status: 'queued', planRunId: 'plan-ok' },
    ],
  });
  const run = await createRun({
    userId: 'u1',
    projectId: 'p1',
    mode: 'build',
    planRunId: 'plan-ok',
    db,
    queue: fakeQueue(calls),
    eventStore: fakeEventStore(),
  });
  assert.equal(run.id, 'build-existing');
  assert.equal(calls.length, 0, 'an existing continuation must not be enqueued twice');
  assert.equal(db._runs.filter((row) => row.mode === 'build').length, 1);
  assert.equal(db._runs.find((row) => row.id === 'plan-ok').status, 'done');
});

test('repeating a build approval does not emit another plan terminal event', async () => {
  const calls = [];
  const events = [];
  const db = makeDb({
    projects: [PROJECT],
    runs: [
      { id: 'plan-ok', projectId: 'p1', userId: 'u1', mode: 'plan', status: 'done' },
      { id: 'build-existing', projectId: 'p1', userId: 'u1', mode: 'build', status: 'queued', planRunId: 'plan-ok' },
    ],
  });
  const run = await createRun({
    userId: 'u1',
    projectId: 'p1',
    mode: 'build',
    planRunId: 'plan-ok',
    db,
    queue: fakeQueue(calls),
    eventStore: fakeEventStore(events),
  });
  assert.equal(run.id, 'build-existing');
  assert.equal(events.length, 0);
});

test('createRun 409s when a run is already active for the project', async () => {
  const db = makeDb({ projects: [PROJECT], runs: [{ id: 'r-active', projectId: 'p1', userId: 'u1', mode: 'plan', status: 'running' }] });
  await assert.rejects(
    () => createRun({ userId: 'u1', projectId: 'p1', mode: 'plan', db, queue: fakeQueue() }),
    (e) => e.code === 'run_in_progress' && e.status === 409,
  );
});

test('worktree concurrency cap admits three runs and rejects the fourth', async () => {
  const project = { ...PROJECT, brief: { maxConcurrentRuns: 3 } };
  const db = makeDb({ projects: [project] });
  const env = {
    NODE_ENV: 'production',
    CODEX_RUN_BRANCHES: '1',
    CODEX_RUN_WORKTREES: '1',
    CODEX_RUN_CONCURRENCY_ENABLED: '1',
    CODEX_RUN_OS_ISOLATION_ATTESTED: '1',
    CODEX_MAX_CONCURRENT_RUNS: '3',
  };
  const first = await createRun({
    userId: 'u1', projectId: 'p1', mode: 'plan', db, queue: fakeQueue(), env,
  });
  const second = await createRun({
    userId: 'u1', projectId: 'p1', mode: 'plan', db, queue: fakeQueue(), env,
  });
  const third = await createRun({
    userId: 'u1', projectId: 'p1', mode: 'plan', db, queue: fakeQueue(), env,
  });
  assert.deepEqual([first.status, second.status, third.status], ['queued', 'queued', 'queued']);
  await assert.rejects(
    () => createRun({
      userId: 'u1', projectId: 'p1', mode: 'plan', db, queue: fakeQueue(), env,
    }),
    (error) => error.code === 'run_in_progress'
      && error.status === 409
      && /cap is 3/.test(error.message),
  );
});

test('configured concurrency is clamped to one until every isolation gate is attested', () => {
  const project = { ...PROJECT, brief: { maxConcurrentRuns: 9 } };
  assert.equal(runService.configuredRunCap(project, { NODE_ENV: 'test' }), 1);
  assert.equal(runService.configuredRunCap(project, {
    NODE_ENV: 'production',
    CODEX_RUN_BRANCHES: '1',
    CODEX_RUN_WORKTREES: '0',
  }), 1);
  assert.equal(runService.configuredRunCap(project, {
    NODE_ENV: 'test',
    CODEX_RUN_BRANCHES: '1',
    CODEX_RUN_WORKTREES: '1',
    CODEX_RUN_CONCURRENCY_ENABLED: '0',
  }), 1);
  assert.equal(runService.configuredRunCap(project, {
    NODE_ENV: 'test',
    CODEX_RUN_BRANCHES: '1',
    CODEX_RUN_WORKTREES: '1',
    CODEX_RUN_CONCURRENCY_ENABLED: '1',
    CODEX_RUN_OS_ISOLATION_ATTESTED: '0',
    CODEX_MAX_CONCURRENT_RUNS: '9',
  }), 1);
  assert.equal(runService.configuredRunCap(project, {
    NODE_ENV: 'test',
    CODEX_RUN_BRANCHES: '1',
    CODEX_RUN_WORKTREES: '1',
    CODEX_RUN_CONCURRENCY_ENABLED: '1',
    CODEX_RUN_OS_ISOLATION_ATTESTED: '1',
    CODEX_MAX_CONCURRENT_RUNS: '4',
  }), 4);
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
  const db = makeDb({ projects: [PROJECT], runs: [{
    id: 'r1',
    projectId: 'p1',
    userId: 'u1',
    mode: 'build',
    status: 'running',
    jobId: 'r1:qr123',
  }] });
  const calls = [];
  const events = [];
  const aborts = [];
  const run = await cancelRun({
    userId: 'u1',
    runId: 'r1',
    db,
    queue: fakeQueue(calls),
    eventStore: fakeEventStore(events),
    abortRun: (runId) => { aborts.push(runId); return true; },
  });
  assert.equal(run.status, 'cancelled');
  assert.ok(run.finishedAt);
  assert.deepEqual(aborts, ['r1']);
  assert.deepEqual(calls.find((c) => c[0] === 'cancelQueued'), ['cancelQueued', 'r1:qr123']);
  assert.deepEqual(events, [{ runId: 'r1', type: 'run_status', data: { status: 'cancelled' } }]);
});

test('cancelRunFamily atomically stops a plan and its active build continuation', async () => {
  const db = makeLockingDb({
    projects: [PROJECT],
    runs: [
      { id: 'plan-family', projectId: 'p1', userId: 'u1', mode: 'plan', status: 'waiting_approval' },
      { id: 'build-family', projectId: 'p1', userId: 'u1', mode: 'build', status: 'running', planRunId: 'plan-family' },
      { id: 'other-run', projectId: 'p1', userId: 'u1', mode: 'build', status: 'running', planRunId: 'other-plan' },
    ],
  });
  const events = [];
  const queueCalls = [];
  const aborts = [];
  const result = await cancelRunFamily({
    userId: 'u1',
    runId: 'plan-family',
    db,
    queue: fakeQueue(queueCalls),
    eventStore: fakeEventStore(events),
    abortRun: (runId) => { aborts.push(runId); return true; },
  });

  assert.deepEqual(new Set(result.cancelledRunIds), new Set(['plan-family', 'build-family']));
  assert.equal(db._runs.find((run) => run.id === 'plan-family').status, 'cancelled');
  assert.equal(db._runs.find((run) => run.id === 'build-family').status, 'cancelled');
  assert.equal(db._runs.find((run) => run.id === 'other-run').status, 'running');
  assert.deepEqual(new Set(aborts), new Set(['plan-family', 'build-family']));
  assert.equal(events.filter((event) => event.type === 'run_status').length, 2);
  assert.equal(db._locks.length, 1, 'family cancellation shares the createRun advisory lock');
});

test('cancelRunFamily fans out only rows whose conditional cancellation won', async () => {
  const completedAt = new Date('2026-08-03T12:00:00.000Z');
  const db = makeLockingDb({
    projects: [PROJECT],
    runs: [
      { id: 'plan-racing', projectId: 'p1', userId: 'u1', mode: 'plan', status: 'waiting_approval' },
      { id: 'build-racing', projectId: 'p1', userId: 'u1', mode: 'build', status: 'running', planRunId: 'plan-racing' },
    ],
  });
  const originalFindMany = db.codexRun.findMany.bind(db.codexRun);
  let raced = false;
  db.codexRun.findMany = async (args) => {
    const rows = await originalFindMany(args);
    if (!raced && args.where?.status?.in) {
      raced = true;
      const build = db._runs.find((run) => run.id === 'build-racing');
      build.status = 'done';
      build.finishedAt = completedAt;
    }
    return rows;
  };

  const events = [];
  const queueCalls = [];
  const aborts = [];
  const result = await cancelRunFamily({
    userId: 'u1',
    runId: 'plan-racing',
    db,
    queue: fakeQueue(queueCalls),
    eventStore: fakeEventStore(events),
    abortRun: (runId) => { aborts.push(runId); return true; },
  });

  assert.deepEqual(result.cancelledRunIds, ['plan-racing']);
  assert.equal(db._runs.find((run) => run.id === 'plan-racing').status, 'cancelled');
  assert.equal(db._runs.find((run) => run.id === 'build-racing').status, 'done');
  assert.equal(db._runs.find((run) => run.id === 'build-racing').finishedAt, completedAt);
  assert.deepEqual(aborts, ['plan-racing']);
  assert.deepEqual(queueCalls.filter((call) => call[0] === 'cancelQueued'), [['cancelQueued', 'plan-racing']]);
  assert.deepEqual(events.map((event) => event.runId), ['plan-racing']);
});

test('cancelRunFamily is idempotent when the family is already terminal', async () => {
  const db = makeDb({
    projects: [PROJECT],
    runs: [
      { id: 'plan-done', projectId: 'p1', userId: 'u1', mode: 'plan', status: 'done' },
      { id: 'build-done', projectId: 'p1', userId: 'u1', mode: 'build', status: 'cancelled', planRunId: 'plan-done' },
    ],
  });
  const result = await cancelRunFamily({
    userId: 'u1',
    runId: 'plan-done',
    db,
    queue: fakeQueue(),
    eventStore: fakeEventStore(),
  });
  assert.deepEqual(result.cancelledRunIds, []);
  assert.equal(result.runs.length, 2);
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
