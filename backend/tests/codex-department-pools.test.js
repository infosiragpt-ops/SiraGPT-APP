'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const departments = require('../src/services/codex/company-departments');
const pools = require('../src/services/codex/department-pools');
const runService = require('../src/services/codex/run-service');

function fakePrisma(project) {
  const state = {
    project: structuredClone(project),
    pools: [],
    nextId: 1,
  };
  const codexProject = {
    findFirst: async () => structuredClone(state.project),
    findUnique: async () => structuredClone(state.project),
    update: async ({ data }) => {
      state.project = { ...state.project, ...structuredClone(data) };
      return structuredClone(state.project);
    },
  };
  return {
    state,
    codexProject,
    codexDepartmentPool: {
      findMany: async ({ where }) => state.pools
        .filter((row) => row.projectId === where.projectId)
        .map((row) => structuredClone(row)),
      upsert: async ({ where, create, update }) => {
        const key = where.projectId_departmentId;
        const index = state.pools.findIndex((row) => (
          row.projectId === key.projectId && row.departmentId === key.departmentId
        ));
        if (index >= 0) {
          state.pools[index] = {
            ...state.pools[index],
            ...structuredClone(update),
            updatedAt: new Date(),
          };
          return structuredClone(state.pools[index]);
        }
        const now = new Date();
        const row = {
          id: `pool-${state.nextId++}`,
          ...structuredClone(create),
          createdAt: now,
          updatedAt: now,
        };
        state.pools.push(row);
        return structuredClone(row);
      },
      deleteMany: async ({ where }) => {
        const before = state.pools.length;
        state.pools = state.pools.filter((row) => (
          row.projectId !== where.projectId || row.departmentId !== where.departmentId
        ));
        return { count: before - state.pools.length };
      },
    },
  };
}

test('opening an engineering department creates five physical workers and a cap of five', async () => {
  const project = { id: 'p1', userId: 'u1', brief: { goal: 'ship' } };
  const prisma = fakePrisma(project);

  const rows = await departments.upsertDepartment({
    prisma,
    project,
    department: {
      id: 'product-engineering',
      name: 'Producto e Ingenieria',
      desiredAgents: 5,
      dailyBudgetUsd: 12.5,
    },
  });
  const storedPools = await pools.listDepartmentPools({ prisma, projectId: project.id });
  const capacity = departments.capacitySummary(rows, storedPools);

  assert.equal(storedPools.length, 1);
  assert.equal(storedPools[0].departmentId, 'product-engineering');
  assert.equal(storedPools[0].size, 5);
  assert.equal(storedPools[0].dailyBudgetUsd, 12.5);
  assert.equal(capacity.physicalAgents, 5);
  assert.equal(capacity.writerConcurrency, 5);
  assert.equal(prisma.state.project.brief.maxConcurrentRuns, 5);
});

test('physical capacity is bounded independently from logical agents and shrinks on deletion', async () => {
  const project = { id: 'p1', userId: 'u1', brief: {} };
  const prisma = fakePrisma(project);

  const rows = await departments.upsertDepartment({
    prisma,
    project,
    department: {
      name: 'Large Research',
      desiredAgents: 1000,
      dailyBudgetUsd: 0,
    },
  });
  const department = rows.find((row) => row.name === 'Large Research');
  let storedPools = await pools.listDepartmentPools({ prisma, projectId: project.id });
  assert.equal(department.desiredAgents, 1000);
  assert.equal(storedPools[0].size, pools.MAX_DEPARTMENT_POOL_SIZE);
  assert.equal(storedPools[0].dailyBudgetUsd, 0);
  assert.equal(prisma.state.project.brief.maxConcurrentRuns, pools.MAX_PROJECT_POOL_CAPACITY);

  await departments.deleteDepartment({
    prisma,
    project: prisma.state.project,
    departmentId: department.id,
  });
  storedPools = await pools.listDepartmentPools({ prisma, projectId: project.id });
  assert.deepEqual(storedPools, []);
  assert.equal(prisma.state.project.brief.maxConcurrentRuns, 1);
});

test('reported physical and writer capacity never exceed the real run hard cap', () => {
  assert.equal(pools.MAX_PROJECT_POOL_CAPACITY, runService.MAX_CONCURRENT_RUNS_HARD_CAP);
  const capacity = pools.poolCapacity(Array.from({ length: 14 }, (_, index) => ({
    id: `pool-${index}`,
    enabled: true,
    size: pools.MAX_DEPARTMENT_POOL_SIZE,
  })));
  assert.equal(capacity.physicalAgents, runService.MAX_CONCURRENT_RUNS_HARD_CAP);
  assert.equal(capacity.writerConcurrency, runService.MAX_CONCURRENT_RUNS_HARD_CAP);
});

test('updating pool size preserves an existing budget when no budget field is sent', async () => {
  const project = { id: 'p1', userId: 'u1', brief: {} };
  const prisma = fakePrisma(project);
  await pools.upsertDepartmentPool({
    prisma,
    project,
    departmentId: 'engineering',
    size: 2,
    dailyBudgetUsd: 8,
  });
  await pools.upsertDepartmentPool({
    prisma,
    project: prisma.state.project,
    departmentId: 'engineering',
    size: 3,
  });
  const [row] = await pools.listDepartmentPools({ prisma, projectId: project.id });
  assert.equal(row.size, 3);
  assert.equal(row.dailyBudgetUsd, 8);
  assert.equal(prisma.state.project.brief.maxConcurrentRuns, 3);
});

test('department pool daily budget counts only that department and acts as a kill switch', async () => {
  let metricWhere = null;
  let ledgerWhere = null;
  const prisma = {
    codexDepartmentPool: {
      findUnique: async () => ({
        id: 'pool-engineering',
        projectId: 'p1',
        departmentId: 'engineering',
        size: 3,
        dailyBudgetUsd: 4,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    },
    codexRunMetric: {
      findMany: async ({ where }) => {
        metricWhere = where;
        return [{ costOriginalUsd: 3.25, costAppliedUsd: 2 }];
      },
    },
    codexUsageEntry: {
      findMany: async ({ where }) => {
        ledgerWhere = where;
        return [{ costOriginalUsd: 1, costAppliedUsd: 0.5 }];
      },
    },
    codexSwarmTask: {
      findMany: async () => [],
    },
  };
  const status = await pools.checkDepartmentPoolBudget({
    prisma,
    projectId: 'p1',
    departmentId: 'engineering',
    now: new Date('2026-07-28T18:00:00.000Z'),
  });
  assert.equal(status.allowed, false);
  assert.equal(status.reason, 'daily_budget_exceeded');
  assert.equal(status.costTodayUsd, 4.25);
  assert.equal(status.remainingUsd, 0);
  assert.deepEqual(metricWhere.run, {
    projectId: 'p1',
    departmentPoolId: 'pool-engineering',
  });
  assert.equal(metricWhere.createdAt.gte.toISOString(), '2026-07-28T00:00:00.000Z');
  assert.equal(ledgerWhere.departmentPoolId, 'pool-engineering');
  assert.equal(ledgerWhere.createdAt.gte.toISOString(), '2026-07-28T00:00:00.000Z');
});

test('configured pool budget fails closed in production when cost aggregation is unavailable', async () => {
  const prisma = {
    codexDepartmentPool: {
      findUnique: async () => ({
        id: 'pool-sales',
        projectId: 'p1',
        departmentId: 'sales',
        size: 1,
        dailyBudgetUsd: 2,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    },
  };
  const status = await pools.checkDepartmentPoolBudget({
    prisma,
    projectId: 'p1',
    departmentId: 'sales',
    env: { NODE_ENV: 'production' },
  });
  assert.equal(status.allowed, false);
  assert.equal(status.reason, 'budget_query_failed');
});

test('an enabled pool without a daily limit remains unlimited', async () => {
  const prisma = {
    codexDepartmentPool: {
      findUnique: async () => ({
        id: 'pool-product',
        projectId: 'p1',
        departmentId: 'product',
        size: 2,
        dailyBudgetUsd: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    },
  };
  const status = await pools.checkDepartmentPoolBudget({
    prisma,
    projectId: 'p1',
    departmentId: 'product',
    env: { NODE_ENV: 'production' },
  });
  assert.equal(status.allowed, true);
  assert.equal(status.reason, 'unlimited');
  assert.equal(status.dailyBudgetUsd, null);
});
