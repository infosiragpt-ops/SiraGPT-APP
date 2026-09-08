'use strict';

const { mutateProjectBrief } = require('./project-brief-store');
const projectBudget = require('./project-budget');

// Physical pool seats per department / project (writers still isolation-capped).
const MAX_DEPARTMENT_POOL_SIZE = 512;
const MAX_PROJECT_POOL_CAPACITY = 512;

function boundedSize(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_DEPARTMENT_POOL_SIZE, parsed));
}

function boundedBudget(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('invalid_department_pool_budget');
  return Math.round(parsed * 10_000) / 10_000;
}

function normalizePool(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    departmentId: row.departmentId,
    size: boundedSize(row.size),
    dailyBudgetUsd: row.dailyBudgetUsd == null ? null : Number(row.dailyBudgetUsd),
    enabled: row.enabled !== false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function poolCapacity(pools) {
  const enabled = (Array.isArray(pools) ? pools : []).filter((pool) => pool?.enabled !== false);
  const physicalAgents = enabled.reduce((sum, pool) => sum + boundedSize(pool?.size), 0);
  return {
    pools: enabled.length,
    physicalAgents,
    writerConcurrency: Math.max(1, Math.min(MAX_PROJECT_POOL_CAPACITY, physicalAgents || 1)),
    dailyBudgetUsd: enabled.reduce((sum, pool) => (
      pool?.dailyBudgetUsd == null ? sum : sum + Number(pool.dailyBudgetUsd)
    ), 0),
  };
}

async function findDepartmentPool({ prisma, projectId, departmentId }) {
  if (!projectId || !departmentId) return null;
  let row = null;
  if (prisma?.codexDepartmentPool?.findUnique) {
    row = await prisma.codexDepartmentPool.findUnique({
      where: { projectId_departmentId: { projectId, departmentId } },
    });
  } else if (prisma?.codexDepartmentPool?.findFirst) {
    row = await prisma.codexDepartmentPool.findFirst({
      where: { projectId, departmentId },
    });
  }
  return normalizePool(row);
}

async function departmentCostTodayUsd({
  prisma,
  projectId,
  departmentId,
  now = new Date(),
}) {
  const pool = await findDepartmentPool({ prisma, projectId, departmentId });
  if (!pool) return 0;
  return projectBudget.costTodayUsdForPool({
    prisma,
    projectId,
    departmentPoolId: pool.id,
    now,
  });
}

async function checkDepartmentPoolBudget({
  prisma,
  projectId,
  departmentId,
  env = process.env,
  now = new Date(),
}) {
  const pool = await findDepartmentPool({ prisma, projectId, departmentId });
  if (!pool) {
    return {
      allowed: true,
      reason: 'pool_not_configured',
      pool: null,
      costTodayUsd: 0,
      dailyBudgetUsd: null,
      remainingUsd: null,
    };
  }
  if (!pool.enabled) {
    return {
      allowed: false,
      reason: 'pool_disabled',
      pool,
      costTodayUsd: 0,
      dailyBudgetUsd: pool.dailyBudgetUsd,
      remainingUsd: 0,
    };
  }
  if (pool.dailyBudgetUsd == null) {
    return {
      allowed: true,
      reason: 'unlimited',
      pool,
      costTodayUsd: 0,
      dailyBudgetUsd: null,
      remainingUsd: null,
    };
  }
  try {
    const status = await projectBudget.checkDepartmentPoolBudget({
      prisma,
      projectId,
      departmentPoolId: pool.id,
      now,
    });
    const allowed = status.allowed === true;
    return {
      allowed,
      reason: allowed
        ? (status.reason === 'department_pool_unlimited' ? 'unlimited' : 'within_budget')
        : status.reason === 'department_pool_paused'
          ? 'pool_disabled'
          : status.reason === 'department_pool_budget_limit'
            || status.reason === 'department_pool_budget_blocked'
            ? 'daily_budget_exceeded'
            : 'budget_query_failed',
      pool,
      costTodayUsd: status.costTodayUsd,
      dailyBudgetUsd: pool.dailyBudgetUsd,
      remainingUsd: status.remainingUsd,
      detail: status,
    };
  } catch (error) {
    return {
      allowed: false,
      reason: 'budget_query_failed',
      error: String(error?.message || error).slice(0, 300),
      pool,
      costTodayUsd: null,
      dailyBudgetUsd: pool.dailyBudgetUsd,
      remainingUsd: null,
    };
  }
}

async function listDepartmentPools({ prisma, projectId }) {
  if (!prisma?.codexDepartmentPool?.findMany || !projectId) return [];
  const rows = await prisma.codexDepartmentPool.findMany({
    where: { projectId },
    orderBy: [{ createdAt: 'asc' }, { departmentId: 'asc' }],
  });
  return rows.map(normalizePool).filter(Boolean);
}

async function persistProjectCap({ prisma, project }) {
  if (!project?.id) return 1;
  const pools = await listDepartmentPools({ prisma, projectId: project.id });
  const capacity = poolCapacity(pools);
  if (prisma?.codexProject?.update) {
    await mutateProjectBrief({
      prisma,
      projectId: project.id,
      userId: project.userId,
      mutate: (brief) => ({
        ...brief,
        maxConcurrentRuns: capacity.writerConcurrency,
      }),
    });
  }
  return capacity.writerConcurrency;
}

async function upsertDepartmentPool({
  prisma,
  project,
  departmentId,
  size,
  dailyBudgetUsd,
  enabled = true,
}) {
  if (!project?.id || !departmentId) throw new Error('department_pool_invalid');
  if (!prisma?.codexDepartmentPool?.upsert) return null;
  const normalizedSize = boundedSize(size);
  const budgetProvided = dailyBudgetUsd !== undefined;
  const normalizedBudget = budgetProvided ? boundedBudget(dailyBudgetUsd) : null;
  const row = await prisma.codexDepartmentPool.upsert({
    where: {
      projectId_departmentId: {
        projectId: project.id,
        departmentId,
      },
    },
    create: {
      projectId: project.id,
      departmentId,
      size: normalizedSize,
      dailyBudgetUsd: normalizedBudget,
      enabled: enabled !== false,
    },
    update: {
      size: normalizedSize,
      ...(budgetProvided ? { dailyBudgetUsd: normalizedBudget } : {}),
      enabled: enabled !== false,
    },
  });
  await persistProjectCap({ prisma, project });
  return normalizePool(row);
}

async function removeDepartmentPool({ prisma, project, departmentId }) {
  if (!project?.id || !departmentId) return false;
  if (!prisma?.codexDepartmentPool?.deleteMany) return false;
  const result = await prisma.codexDepartmentPool.deleteMany({
    where: { projectId: project.id, departmentId },
  });
  await persistProjectCap({ prisma, project });
  return Number(result?.count || 0) > 0;
}

module.exports = {
  MAX_DEPARTMENT_POOL_SIZE,
  MAX_PROJECT_POOL_CAPACITY,
  boundedBudget,
  boundedSize,
  checkDepartmentPoolBudget,
  departmentCostTodayUsd,
  findDepartmentPool,
  listDepartmentPools,
  normalizePool,
  persistProjectCap,
  poolCapacity,
  removeDepartmentPool,
  upsertDepartmentPool,
};
