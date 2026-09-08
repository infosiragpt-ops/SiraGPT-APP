'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  addQaCheckpoints,
  normalizePlannerTasks,
  padFleetToLogicalCapacity,
  planFleetTasks,
} = require('../src/services/codex/fleet-orchestrator');
const {
  createWriterRun,
  requeueWriterTask,
  shouldRetryWriterTask,
} = require('../src/services/codex/swarm-runner');

test('planner DAG with five writer tasks produces five code runs plus a QA checkpoint', async () => {
  const result = await planFleetTasks({
    objective: 'Construir cinco módulos',
    desiredTasks: 5,
    planner: async () => ({
      content: JSON.stringify({
        tasks: Array.from({ length: 5 }, (_, index) => ({
          id: `module-${index + 1}`,
          title: `Módulo ${index + 1}`,
          role: 'writer',
          departmentId: 'engineering',
          dependsOn: index ? [`module-${index}`] : [],
          acceptance: ['pruebas en verde'],
        })),
      }),
    }),
  });
  assert.equal(result.source, 'planner');
  assert.equal(result.tasks.filter((task) => task.role === 'writer').length, 5);
  const qa = result.tasks.find((task) => task.key === 'fleet-qa-1');
  assert.deepEqual(qa.dependsOn, [
    'module-1',
    'module-2',
    'module-3',
    'module-4',
    'module-5',
  ]);
});

test('pads a small planner DAG up to the requested logical agent capacity', async () => {
  const result = await planFleetTasks({
    objective: 'Activar flota de 256 agentes',
    desiredTasks: 256,
    planner: async () => ({
      content: JSON.stringify({
        tasks: [
          {
            id: 'core-module',
            title: 'Módulo núcleo',
            role: 'writer',
            departmentId: 'engineering',
            acceptance: ['typecheck ok'],
          },
        ],
      }),
    }),
  });
  assert.equal(result.source, 'planner+scale');
  assert.equal(result.tasks.filter((task) => task.role === 'writer').length, 1);
  assert.ok(result.tasks.filter((task) => task.role === 'read-only').length >= 250);
  assert.ok(result.tasks.length >= 256);
});

test('padFleetToLogicalCapacity never invents writers', () => {
  const padded = padFleetToLogicalCapacity(
    [{ key: 'w1', title: 'Write', role: 'writer', stage: 'work', priority: 1, dependsOn: [], input: {} }],
    { objective: 'Entregar producto funcional', targetCount: 100 },
  );
  assert.equal(padded.length, 100);
  assert.equal(padded.filter((task) => task.role === 'writer').length, 1);
  assert.equal(padded.filter((task) => task.role === 'read-only').length, 99);
});

test('QA checkpoints gate the next batch of writers', () => {
  const tasks = normalizePlannerTasks([
    { id: 'a', title: 'A', role: 'writer' },
    { id: 'b', title: 'B', role: 'writer' },
    { id: 'c', title: 'C', role: 'writer' },
  ]);
  const withQa = addQaCheckpoints(tasks, { every: 2 });
  assert.deepEqual(withQa.find((task) => task.key === 'fleet-qa-1').dependsOn, ['a', 'b']);
  assert.ok(withQa.find((task) => task.key === 'c').dependsOn.includes('fleet-qa-1'));
  assert.deepEqual(withQa.find((task) => task.key === 'fleet-qa-2').dependsOn, ['c']);
});

test('writer tasks create autonomous plan/build work with department and acceptance context', async () => {
  let createArgs = null;
  const updates = [];
  const prisma = {
    codexSwarmTask: {
      update: async (args) => {
        updates.push(args);
        return {};
      },
    },
    codexRun: {
      findUnique: async () => ({ id: 'plan-1', status: 'done', error: null }),
      findFirst: async () => null,
    },
    codexSwarm: {
      findUnique: async () => ({ status: 'running', cancelRequestedAt: null }),
    },
  };
  const result = await createWriterRun({
    task: {
      id: 'task-1',
      title: 'Implementar API',
      role: 'writer',
      dependsOn: [],
      input: {
        departmentId: 'engineering',
        instruction: 'Implementa la API de clientes.',
        acceptance: ['CRUD probado'],
      },
    },
    swarm: { id: 'swarm-1', metadata: { objective: 'CRM completo' } },
    project: { id: 'p1', userId: 'u1', name: 'CRM' },
    tasks: [],
    prisma,
    runService: {
      createRun: async (args) => {
        createArgs = args;
        return { id: 'plan-1' };
      },
      cancelRun: async () => {},
    },
    env: {
      CODEX_SWARM_INTEGRATION_TIMEOUT_MS: '60000',
      CODEX_SWARM_POLL_MS: '250',
      CODEX_RUN_BRANCHES: '1',
      CODEX_RUN_WORKTREES: '1',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(createArgs.autoExecute, true);
  assert.equal(createArgs.env.CODEX_RUN_WORKTREES, '1');
  assert.match(createArgs.prompt, /\[SWARM · engineering\]/);
  assert.match(createArgs.prompt, /CRUD probado/);
  assert.equal(updates[0].data.result.planRunId, 'plan-1');
});

test('failed writers are requeued with prior-attempt context until maxAttempts', async () => {
  const task = {
    id: 'task-1',
    role: 'writer',
    status: 'running',
    attemptCount: 1,
    maxAttempts: 3,
  };
  assert.equal(shouldRetryWriterTask(task, { ok: false, status: 'error' }), true);
  assert.equal(shouldRetryWriterTask({ ...task, attemptCount: 3 }, { ok: false }), false);
  let update = null;
  const result = await requeueWriterTask({
    prisma: {
      codexSwarmTask: {
        updateMany: async (args) => {
          update = args;
          return { count: 1 };
        },
      },
    },
    task,
    workerId: 'worker-1',
    leaseToken: 'lease-1',
    result: { ok: false, status: 'error', error: 'merge_conflict: app.ts' },
  });
  assert.equal(result.requeued, true);
  assert.equal(update.data.status, 'queued');
  assert.equal(update.data.result.retrying, true);
  assert.match(update.data.result.error, /merge_conflict/);
});

test('assignDepartmentPools tolerates tasks whose department has no pool row', () => {
  const { assignDepartmentPools } = require('../src/services/codex/fleet-orchestrator');
  // A fresh project has ZERO department pools. This exact shape crashed with
  // "Cannot read properties of undefined (reading 'id')" and killed every
  // fleet launch from the swarm route (observed live on production).
  const tasks = [
    { key: 't1', role: 'writer', input: { departmentId: 'engineering' } },
    { key: 't2', role: 'research', input: { departmentId: 'marketing' } },
  ];
  const out = assignDepartmentPools(tasks, []);
  assert.equal(out.length, 2);
  assert.equal(out[0].input.departmentPoolId, undefined);
  // Mixed case: one department has a pool, the other does not.
  const pooled = assignDepartmentPools(tasks, [
    { id: 'poolE', departmentId: 'engineering', enabled: true, dailyBudgetUsd: 4 },
  ]);
  assert.equal(pooled[0].input.departmentPoolId, 'poolE');
  assert.equal(pooled[0].input.poolBudgetReservationUsd, 4);
  assert.equal(pooled[1].input.departmentPoolId, undefined);
});
