'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const projectBudget = require('../src/services/codex/project-budget');

function budgetPrisma({
  poolBudgetUsd = 1,
  runningTasks = [],
  runCosts = [],
  usageCosts = [],
} = {}) {
  return {
    codexDepartmentPool: {
      findUnique: async ({ where }) => ({
        id: where.id,
        projectId: 'project-1',
        departmentId: 'engineering',
        dailyBudgetUsd: poolBudgetUsd,
        enabled: true,
      }),
    },
    codexRunMetric: {
      findMany: async () => runCosts,
    },
    codexUsageEntry: {
      findMany: async () => usageCosts,
    },
    codexSwarmTask: {
      findMany: async ({ where }) => runningTasks.filter(
        (row) => !where?.id?.not || row.id !== where.id.not,
      ),
    },
  };
}

function pooledTask(id, reservationUsd) {
  return {
    id,
    input: {
      departmentPoolId: 'pool-engineering',
      poolBudgetReservationUsd: reservationUsd,
    },
  };
}

test('claim admission includes the candidate reservation in its department pool', async () => {
  const prisma = budgetPrisma({
    poolBudgetUsd: 1,
    runningTasks: [pooledTask('active-task', 0.6)],
  });
  const result = await projectBudget.checkSwarmClaimBudget({
    prisma,
    projectId: 'project-1',
    task: pooledTask('candidate-task', 0.5),
    projectDailyBudgetUsd: null,
    companyDailyBudgetUsd: null,
    now: new Date('2026-07-28T18:00:00.000Z'),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'department_pool_budget_limit');
  assert.equal(result.activeReservationsUsd, 0.6);
  assert.equal(result.admissionReservationUsd, 0.5);
  assert.equal(result.costTodayUsd, 1.1);
});

test('revalidating a running claim does not reserve the same task twice', async () => {
  const task = pooledTask('active-task', 0.6);
  const prisma = budgetPrisma({
    poolBudgetUsd: 1,
    runningTasks: [task],
  });
  const result = await projectBudget.checkSwarmClaimBudget({
    prisma,
    projectId: 'project-1',
    task,
    projectDailyBudgetUsd: 1,
    companyDailyBudgetUsd: 1,
    now: new Date('2026-07-28T18:00:00.000Z'),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.activeReservationsUsd, 0);
  assert.equal(result.reservationUsd, 0.6);
  assert.equal(result.projectedCostUsd, 0.6);
});

test('pool usage counts run metrics and autonomous ledger entries', async () => {
  const prisma = budgetPrisma({
    poolBudgetUsd: 3,
    runCosts: [{ costOriginalUsd: 1.25, costAppliedUsd: 1 }],
    usageCosts: [{ costOriginalUsd: 0.5, costAppliedUsd: 0.75 }],
  });
  const result = await projectBudget.checkDepartmentPoolBudget({
    prisma,
    projectId: 'project-1',
    departmentPoolId: 'pool-engineering',
    now: new Date('2026-07-28T18:00:00.000Z'),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.persistedCostTodayUsd, 2);
  assert.equal(result.costTodayUsd, 2);
  assert.equal(result.remainingUsd, 1);
});
