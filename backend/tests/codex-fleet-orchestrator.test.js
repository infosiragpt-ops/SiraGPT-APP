'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  addQaCheckpoints,
  assignDepartmentPools,
  createBudgetedFleetPlanner,
  createFleetSwarm,
  DEFAULT_DEPARTMENT_IDS,
  normalizePlannerTasks,
  normalizeDepartmentId,
  padFleetToLogicalCapacity,
  planFleetTasks,
  terminalTaskKeys,
} = require('../src/services/codex/fleet-orchestrator');
const { CodexSwarmOrchestrator } = require('../src/services/codex/swarm-orchestrator');
const {
  createWriterRun,
  requeueWriterTask,
  shouldRetryWriterTask,
} = require('../src/services/codex/swarm-runner');

function freshFleetPrisma(project) {
  const state = {
    project: structuredClone(project),
    pools: new Map(),
    poolUpserts: 0,
  };
  const keyFor = (projectId, departmentId) => `${projectId}:${departmentId}`;
  const prisma = {
    state,
    // The real swarm orchestrator validates repository capabilities in its
    // constructor; createSwarm itself is replaced per integration test below.
    $transaction: async (operation) => operation(prisma),
    codexSwarm: {},
    codexSwarmTask: {
      findMany: async () => [],
    },
    codexProject: {
      findFirst: async ({ where }) => (
        where.id === state.project.id
        && (!where.userId || where.userId === state.project.userId)
          ? structuredClone(state.project)
          : null
      ),
      update: async ({ data }) => {
        state.project = { ...state.project, ...structuredClone(data) };
        return structuredClone(state.project);
      },
    },
    codexDepartmentPool: {
      findMany: async ({ where }) => Array.from(state.pools.values())
        .filter((pool) => pool.projectId === where.projectId)
        .map((pool) => structuredClone(pool)),
      findUnique: async ({ where }) => {
        if (where.id) {
          return structuredClone(
            Array.from(state.pools.values()).find((pool) => pool.id === where.id) || null,
          );
        }
        const identity = where.projectId_departmentId;
        return structuredClone(
          state.pools.get(keyFor(identity.projectId, identity.departmentId)) || null,
        );
      },
      upsert: async ({ where, create, update }) => {
        state.poolUpserts += 1;
        const identity = where.projectId_departmentId;
        const key = keyFor(identity.projectId, identity.departmentId);
        const previous = state.pools.get(key);
        const now = new Date('2026-08-11T12:00:00.000Z');
        const row = previous
          ? { ...previous, ...structuredClone(update), updatedAt: now }
          : {
            id: `pool-${create.departmentId}`,
            ...structuredClone(create),
            createdAt: now,
            updatedAt: now,
          };
        state.pools.set(key, row);
        return structuredClone(row);
      },
    },
    codexRunMetric: {
      findMany: async () => [],
    },
    codexUsageEntry: {
      findMany: async () => [],
    },
  };
  return prisma;
}

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

test('fleet planner budget preflight fails closed before provider spend or fallback', async () => {
  let plannerCalls = 0;
  let usageCalls = 0;
  const budgetError = new Error('company_daily_budget_exceeded:daily_budget_exceeded');
  budgetError.code = 'company_daily_budget_exceeded';
  budgetError.status = 429;
  const planner = createBudgetedFleetPlanner({
    planner: async () => {
      plannerCalls += 1;
      return { content: '{"tasks":[]}' };
    },
    prisma: {},
    project: { id: 'project-budget-0', userId: 'user-1' },
    budgetService: {
      requireOperationBudget: async ({ departmentId }) => {
        assert.equal(departmentId, 'ceo-office');
        throw budgetError;
      },
    },
    usageService: {
      createUsageCallId: () => 'unused',
      recordCompletionUsage: async () => { usageCalls += 1; },
    },
  });
  await assert.rejects(
    planFleetTasks({
      objective: 'No gastar con presupuesto agotado',
      desiredTasks: 8,
      planner,
      companyPlan: {
        executiveSummary: 'Fallback no autorizado',
        workstreams: [{
          id: 'software',
          title: 'Software',
          tasks: [{ id: 'fallback', title: 'No ejecutar', kind: 'research' }],
        }],
      },
    }),
    (error) => error === budgetError && error.fatalFleetPlanner === true,
  );
  assert.equal(plannerCalls, 0);
  assert.equal(usageCalls, 0);
});

test('successful fleet planner completion is attributed to CEO pool exactly once', async () => {
  const usageCalls = [];
  const completion = {
    content: JSON.stringify({
      tasks: [{
        id: 'planned-module',
        title: 'Implementar módulo',
        role: 'writer',
        departmentId: 'engineering',
      }],
    }),
    usage: {
      tokensIn: 800,
      tokensOut: 200,
      provider: 'Anthropic',
      model: 'claude-sonnet-4-6',
      generationId: 'fleet-generation-1',
    },
  };
  const planner = createBudgetedFleetPlanner({
    planner: async () => completion,
    prisma: { codexUsageEntry: {} },
    project: { id: 'project-fleet', userId: 'user-1' },
    budgetService: {
      requireOperationBudget: async () => ({
        companyBudget: { allowed: true },
        poolBudget: { allowed: true },
        pool: { id: 'pool-ceo', departmentId: 'ceo-office' },
      }),
    },
    usageService: {
      createUsageCallId: () => 'fleet-call-1',
      recordCompletionUsage: async (args) => { usageCalls.push(args); },
    },
  });
  const result = await planFleetTasks({
    objective: 'Planificar con gasto auditable',
    desiredTasks: 8,
    planner,
  });
  assert.equal(result.source, 'planner+scale');
  assert.equal(usageCalls.length, 1);
  assert.equal(usageCalls[0].source, 'fleet_planner');
  assert.equal(usageCalls[0].sourceId, 'project-fleet:fleet-planner');
  assert.equal(usageCalls[0].departmentPoolId, 'pool-ceo');
  assert.equal(usageCalls[0].callId, 'fleet-call-1');
  assert.equal(usageCalls[0].completion, completion);
});

test('createFleetSwarm bootstraps empty durable pools before the planner budget preflight', async (t) => {
  const project = {
    id: 'project-fresh-fleet',
    userId: 'user-1',
    name: 'Fresh Fleet',
    brief: { proactive: { configuredDailyBudgetUsd: 25 } },
  };
  const prisma = freshFleetPrisma(project);
  let providerCalls = 0;
  let swarmCreates = 0;
  const originalCreateSwarm = CodexSwarmOrchestrator.prototype.createSwarm;
  CodexSwarmOrchestrator.prototype.createSwarm = async function createSwarm(args) {
    swarmCreates += 1;
    return { id: `swarm-${swarmCreates}`, ...args };
  };
  t.after(() => {
    CodexSwarmOrchestrator.prototype.createSwarm = originalCreateSwarm;
  });

  const launch = () => createFleetSwarm({
    prisma,
    userId: project.userId,
    project,
    objective: 'Construir una plataforma verificable',
    planner: async () => {
      providerCalls += 1;
      return {
        content: JSON.stringify({
          tasks: [{
            id: 'ceo-plan',
            title: 'Coordinar entrega',
            role: 'read-only',
            departmentId: 'ceo-office',
          }],
        }),
      };
    },
    logicalTasks: 8,
    maxConcurrency: 4,
    maxConcurrentWriters: 1,
    env: {
      NODE_ENV: 'test',
      CODEX_PROACTIVE_DAILY_BUDGET_USD: '25',
    },
  });

  const first = await launch();
  assert.equal(providerCalls, 1, 'the provider runs only after budget attribution exists');
  assert.equal(swarmCreates, 1);
  assert.equal(prisma.state.pools.size, DEFAULT_DEPARTMENT_IDS.length);
  assert.ok(
    Array.from(prisma.state.pools.values()).some((pool) => pool.departmentId === 'ceo-office'),
    'CEO Office pool is durably provisioned before planner spend',
  );
  assert.ok(
    first.tasks.every((task) => task.input?.departmentPoolId),
    'every fleet task is attributed to a provisioned pool',
  );

  const firstUpsertCount = prisma.state.poolUpserts;
  await launch();
  assert.equal(providerCalls, 2);
  assert.equal(swarmCreates, 2);
  assert.equal(prisma.state.pools.size, DEFAULT_DEPARTMENT_IDS.length);
  assert.equal(
    prisma.state.poolUpserts,
    firstUpsertCount,
    'replaying launch does not rewrite or duplicate existing pools',
  );
});

test('fleet launch aborts before the provider when durable pool bootstrap is partial', async (t) => {
  const project = {
    id: 'project-partial-pools',
    userId: 'user-1',
    name: 'Partial Pools',
    brief: { proactive: { configuredDailyBudgetUsd: 25 } },
  };
  const prisma = freshFleetPrisma(project);
  const originalUpsert = prisma.codexDepartmentPool.upsert;
  prisma.codexDepartmentPool.upsert = async (args) => {
    if (args.create.departmentId === 'marketing') {
      throw new Error('simulated_pool_store_failure');
    }
    return originalUpsert(args);
  };
  let providerCalls = 0;
  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = originalWarn; });

  await assert.rejects(
    createFleetSwarm({
      prisma,
      userId: project.userId,
      project,
      objective: 'No aceptar una flota parcial',
      planner: async () => {
        providerCalls += 1;
        return { content: '{"tasks":[]}' };
      },
      logicalTasks: 8,
      maxConcurrency: 4,
      maxConcurrentWriters: 1,
      env: { NODE_ENV: 'test', CODEX_PROACTIVE_DAILY_BUDGET_USD: '25' },
    }),
    (error) => (
      error.code === 'fleet_department_pool_bootstrap_incomplete'
      && error.status === 503
      && error.details.missingDepartmentIds.includes('marketing')
    ),
  );
  assert.equal(providerCalls, 0);
  assert.equal(prisma.state.pools.size, DEFAULT_DEPARTMENT_IDS.length - 1);
});

test('bootstrap never re-enables a pool disabled concurrently after its snapshot', async () => {
  const project = {
    id: 'project-concurrent-pool-disable',
    userId: 'user-1',
    name: 'Concurrent Pool Disable',
    brief: { proactive: { configuredDailyBudgetUsd: 25 } },
  };
  const prisma = freshFleetPrisma(project);
  const originalUpsert = prisma.codexDepartmentPool.upsert;
  let injected = false;
  prisma.codexDepartmentPool.upsert = async (args) => {
    if (!injected && args.create.departmentId === 'ceo-office') {
      injected = true;
      const now = new Date('2026-08-11T12:00:00.000Z');
      prisma.state.pools.set(`${project.id}:ceo-office`, {
        id: 'pool-ceo-operator',
        projectId: project.id,
        departmentId: 'ceo-office',
        size: 1,
        dailyBudgetUsd: 8,
        enabled: false,
        createdAt: now,
        updatedAt: now,
      });
    }
    return originalUpsert(args);
  };
  let providerCalls = 0;

  await assert.rejects(
    createFleetSwarm({
      prisma,
      userId: project.userId,
      project,
      objective: 'Respetar el kill switch concurrente',
      planner: async () => {
        providerCalls += 1;
        return { content: '{"tasks":[]}' };
      },
      logicalTasks: 8,
      maxConcurrency: 4,
      maxConcurrentWriters: 1,
      env: { NODE_ENV: 'test', CODEX_PROACTIVE_DAILY_BUDGET_USD: '25' },
    }),
    (error) => (
      error.code === 'fleet_department_pool_bootstrap_incomplete'
      && error.details.disabledDepartmentIds.includes('ceo-office')
    ),
  );
  const ceoPool = prisma.state.pools.get(`${project.id}:ceo-office`);
  assert.equal(ceoPool.enabled, false);
  assert.equal(ceoPool.dailyBudgetUsd, 8);
  assert.equal(providerCalls, 0);
});

test('existing CEO pool budget zero remains a provider kill switch after bootstrap', async () => {
  const project = {
    id: 'project-pool-budget-zero',
    userId: 'user-1',
    name: 'Pool Budget Zero',
    brief: { proactive: { configuredDailyBudgetUsd: 25 } },
  };
  const prisma = freshFleetPrisma(project);
  const now = new Date('2026-08-11T12:00:00.000Z');
  prisma.state.pools.set(`${project.id}:ceo-office`, {
    id: 'pool-ceo-budget-zero',
    projectId: project.id,
    departmentId: 'ceo-office',
    size: 1,
    dailyBudgetUsd: 0,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  let providerCalls = 0;

  await assert.rejects(
    createFleetSwarm({
      prisma,
      userId: project.userId,
      project,
      objective: 'No gastar el pool CEO',
      planner: async () => {
        providerCalls += 1;
        return { content: '{"tasks":[]}' };
      },
      logicalTasks: 8,
      maxConcurrency: 4,
      maxConcurrentWriters: 1,
      env: { NODE_ENV: 'test', CODEX_PROACTIVE_DAILY_BUDGET_USD: '25' },
    }),
    (error) => (
      error.code === 'department_pool_daily_budget_exceeded'
      && error.status === 429
      && error.fatalFleetPlanner === true
    ),
  );
  assert.equal(prisma.state.pools.get(`${project.id}:ceo-office`).dailyBudgetUsd, 0);
  assert.equal(providerCalls, 0);
});

test('fresh fleet preflight reloads a concurrent company budget change to zero', async (t) => {
  const project = {
    id: 'project-fresh-budget-zero',
    userId: 'user-1',
    name: 'Budget Zero',
    brief: { proactive: { configuredDailyBudgetUsd: 25 } },
  };
  const prisma = freshFleetPrisma(project);
  const originalUpsert = prisma.codexDepartmentPool.upsert;
  let budgetChanged = false;
  prisma.codexDepartmentPool.upsert = async (args) => {
    const row = await originalUpsert(args);
    if (!budgetChanged) {
      budgetChanged = true;
      prisma.state.project.brief = {
        ...prisma.state.project.brief,
        proactive: {
          ...prisma.state.project.brief.proactive,
          configuredDailyBudgetUsd: 0,
        },
      };
    }
    return row;
  };
  let providerCalls = 0;
  let swarmCreates = 0;
  const originalCreateSwarm = CodexSwarmOrchestrator.prototype.createSwarm;
  CodexSwarmOrchestrator.prototype.createSwarm = async function createSwarm(args) {
    swarmCreates += 1;
    return { id: 'must-not-exist', ...args };
  };
  t.after(() => {
    CodexSwarmOrchestrator.prototype.createSwarm = originalCreateSwarm;
  });

  await assert.rejects(
    createFleetSwarm({
      prisma,
      userId: project.userId,
      project,
      objective: 'No gastar con presupuesto cero',
      planner: async () => {
        providerCalls += 1;
        return { content: '{"tasks":[]}' };
      },
      logicalTasks: 8,
      maxConcurrency: 4,
      maxConcurrentWriters: 1,
      env: {
        NODE_ENV: 'test',
        CODEX_PROACTIVE_DAILY_BUDGET_USD: '999',
      },
    }),
    (error) => (
      error.code === 'company_daily_budget_exceeded'
      && error.status === 429
      && error.fatalFleetPlanner === true
    ),
  );
  assert.equal(prisma.state.pools.size, DEFAULT_DEPARTMENT_IDS.length);
  assert.equal(project.brief.proactive.configuredDailyBudgetUsd, 25, 'route snapshot stays stale');
  assert.equal(prisma.state.project.brief.proactive.configuredDailyBudgetUsd, 0);
  assert.equal(providerCalls, 0, 'budget denial happens before provider spend');
  assert.equal(swarmCreates, 0, 'no durable swarm is accepted after budget denial');
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
  assert.ok(result.tasks.filter((task) => task.role === 'read-only').length >= 240);
  assert.equal(result.tasks.length, 256);
  assert.equal(result.tasks.at(-1).role, 'reviewer');
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

test('planner department ids accept only real departments and explicit aliases', () => {
  assert.equal(DEFAULT_DEPARTMENT_IDS.length, 14);
  assert.equal(new Set(DEFAULT_DEPARTMENT_IDS).size, 14);
  const allowed = ['engineering-01', 'engineering-02', 'trust'];
  const normalized = normalizePlannerTasks([
    { id: 'known', departmentId: 'engineering-01' },
    { id: 'alias', departmentId: 'qa' },
  ], { departmentIds: allowed });

  assert.deepEqual(
    normalized.map((task) => task.input.departmentId),
    ['engineering-01', 'engineering-02'],
  );
  assert.deepEqual(normalized[1].input.departmentRouting, {
    source: 'explicit-alias',
    requestedDepartmentId: 'qa',
    assignedDepartmentId: 'engineering-02',
  });
  assert.equal(normalizeDepartmentId('trust-quality', { departmentIds: allowed }), 'trust');
  assert.ok(normalized.every((task) => allowed.includes(task.input.departmentId)));
  assert.throws(
    () => normalizePlannerTasks([
      { id: 'invented', departmentId: 'moonshot-division' },
    ], { departmentIds: allowed }),
    /fleet_planner_department_invalid:moonshot-division/,
  );
});

test('10k logical task budget includes deterministic QA coverage exactly once', async () => {
  const result = await planFleetTasks({
    objective: 'Activar y comprobar diez mil agentes',
    desiredTasks: 10_000,
    planner: async () => ({
      content: JSON.stringify({
        tasks: Array.from({ length: 5 }, (_, index) => ({
          id: `writer-${index + 1}`,
          title: `Writer ${index + 1}`,
          role: 'writer',
          departmentId: 'engineering',
        })),
      }),
    }),
  });

  assert.equal(result.tasks.length, 10_000);
  assert.equal(result.tasks.filter((task) => task.role === 'writer').length, 5);
  assert.equal(result.tasks.filter((task) => /^fleet-qa-/.test(task.key)).length, 1);
  assert.equal(result.tasks.at(-1).role, 'reviewer');

  const sinks = terminalTaskKeys(result.tasks);
  assert.equal(sinks.length, 1, 'the scaled fleet must have one final verdict');
  const byKey = new Map(result.tasks.map((task) => [task.key, task]));
  const reachable = new Set();
  const pending = [...sinks];
  while (pending.length) {
    const key = pending.pop();
    if (reachable.has(key)) continue;
    reachable.add(key);
    pending.push(...(byKey.get(key)?.dependsOn || []));
  }
  assert.equal(reachable.size, 10_000, 'every logical task must feed the final verdict');
  for (const task of result.tasks.filter((item) => /^fleet-reduce-/.test(item.key))) {
    assert.ok(task.dependsOn.length <= 50, `${task.key} exceeds bounded reduction fan-in`);
  }
});

test('QA insertion fails closed instead of exceeding the absolute 10k task limit', () => {
  const tasks = Array.from({ length: 10_000 }, (_, index) => ({
    key: `writer-${index + 1}`,
    title: `Writer ${index + 1}`,
    role: 'writer',
    stage: 'work',
    priority: index,
    dependsOn: [],
    input: { departmentId: 'product-engineering' },
  }));
  assert.throws(
    () => addQaCheckpoints(tasks, { every: 5, taskLimit: 10_000 }),
    (error) => (
      error.code === 'fleet_qa_task_budget_exceeded'
      && error.details.baseTasks === 10_000
      && error.details.totalTasks === 12_000
      && error.details.taskLimit === 10_000
    ),
  );
});

test('invented planner departments become a traced fallback plan without misbilling', async () => {
  const result = await planFleetTasks({
    objective: 'Construir una operación comprobable',
    desiredTasks: 10_000,
    departmentIds: ['ceo-office', 'trust'],
    companyPlan: {
      executiveSummary: 'Operación comprobable',
      workstreams: [{
        id: 'moonshot-workstream',
        title: 'Moonshot',
        score: 10,
        tasks: [{
          id: 'discovery',
          title: 'Investigar alcance',
          kind: 'research',
          output: 'Informe',
        }],
      }],
    },
    planner: async () => ({
      content: JSON.stringify({
        tasks: [{
          id: 'invented',
          title: 'Tarea inventada',
          role: 'writer',
          departmentId: 'moonshot-division',
        }],
      }),
    }),
  });

  assert.equal(result.source, 'fallback');
  assert.match(result.plannerError, /fleet_planner_department_invalid:moonshot-division/);
  assert.equal(result.tasks.length, 10_000);
  assert.equal(result.tasks.some((task) => task.input?.departmentId === 'moonshot-division'), false);
  const fallbackTask = result.tasks.find((task) => task.input?.fallback === true);
  assert.ok(fallbackTask);
  assert.deepEqual(fallbackTask.input.departmentRouting, {
    source: 'fleet-fallback',
    reason: 'planner_fallback',
    requestedDepartmentId: 'moonshot-workstream',
    assignedDepartmentId: 'ceo-office',
  });
  assert.ok(result.tasks.some((task) => /^fleet-qa-/.test(task.key)));
});

test('logical padding is distributed deterministically across supplied departments', () => {
  const departments = ['sales', 'marketing', 'customer-success', 'trust'];
  const args = {
    objective: 'Auditar toda la empresa',
    targetCount: 17,
    departmentIds: departments,
  };
  const first = padFleetToLogicalCapacity([], args);
  const second = padFleetToLogicalCapacity([], args);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.slice(0, 8).map((task) => task.input.departmentId),
    ['sales', 'customer-success', 'marketing', 'trust', 'sales', 'customer-success', 'marketing', 'trust'],
  );
  const counts = new Map();
  for (const task of first) {
    counts.set(task.input.departmentId, (counts.get(task.input.departmentId) || 0) + 1);
  }
  assert.equal(Math.max(...counts.values()) - Math.min(...counts.values()), 1);
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

test('assignDepartmentPools tolerates a fresh project but fails closed against a supplied pool authority', () => {
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
  // Once the runtime supplies pools, they are authoritative; a planner cannot
  // invent or bypass a department that has no real capacity/budget row.
  assert.throws(() => assignDepartmentPools(tasks, [
    { id: 'poolE', departmentId: 'engineering', enabled: true, dailyBudgetUsd: 4 },
  ]), /department_pool_unavailable:marketing/);

  const pooled = assignDepartmentPools(tasks.slice(0, 1), [
    { id: 'poolE', departmentId: 'engineering', enabled: true, dailyBudgetUsd: 4 },
  ]);
  assert.equal(pooled[0].input.departmentPoolId, 'poolE');
  assert.equal(pooled[0].input.poolBudgetReservationUsd, 4);
});
