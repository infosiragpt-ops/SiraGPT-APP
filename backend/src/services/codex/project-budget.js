'use strict';

const metrics = require('../../utils/metrics');

const CHECKS = 'siragpt_codex_project_budget_checks_total';

metrics.registerCounter(CHECKS, {
  help: 'Codex project daily-budget preflight results',
  labels: ['outcome'],
  maxSeries: 8,
});

function utcDayStart(now = new Date()) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

function configuredBudgetUsd(settings, env = process.env) {
  const projectValue = settings?.budget?.dailyUsd;
  if (projectValue != null && Number.isFinite(Number(projectValue))) {
    return Math.max(0, Number(projectValue));
  }
  const envValue = Number(env?.CODEX_PROJECT_DAILY_BUDGET_USD);
  if (Number.isFinite(envValue) && envValue >= 0) return envValue;
  return env?.NODE_ENV === 'production' ? 10 : null;
}

function configuredCompanyBudgetUsd(project, env = process.env) {
  const projectValue = project?.brief?.proactive?.configuredDailyBudgetUsd;
  if (projectValue != null && Number.isFinite(Number(projectValue))) {
    return Math.max(0, Number(projectValue));
  }
  const envValue = Number(env?.CODEX_PROACTIVE_DAILY_BUDGET_USD);
  return Number.isFinite(envValue) && envValue >= 0 ? envValue : 25;
}

function rowCostUsd(row) {
  const original = Number(row?.costOriginalUsd);
  const applied = Number(row?.costAppliedUsd);
  return Math.max(
    0,
    Number.isFinite(original) ? original : 0,
    Number.isFinite(applied) ? applied : 0,
  );
}

async function usageLedgerCostUsd({
  prisma,
  projectId,
  departmentPoolId = undefined,
  now = new Date(),
}) {
  if (!prisma?.codexUsageEntry?.findMany) {
    const error = new Error('codex autonomous usage aggregation unavailable');
    error.code = 'budget_store_unavailable';
    throw error;
  }
  const rows = await prisma.codexUsageEntry.findMany({
    where: {
      projectId,
      createdAt: { gte: utcDayStart(now) },
      ...(departmentPoolId === undefined ? {} : { departmentPoolId }),
    },
    select: { costOriginalUsd: true, costAppliedUsd: true },
  });
  return rows.reduce((total, row) => total + rowCostUsd(row), 0);
}

async function costTodayUsd({ prisma, projectId, now = new Date() }) {
  let runCostUsd;
  if (prisma?.codexRunMetric?.findMany) {
    const rows = await prisma.codexRunMetric.findMany({
      where: {
        createdAt: { gte: utcDayStart(now) },
        run: { projectId },
      },
      select: { costOriginalUsd: true, costAppliedUsd: true },
    });
    runCostUsd = rows.reduce((total, row) => total + rowCostUsd(row), 0);
  } else if (!prisma?.codexRunMetric?.aggregate) {
    const error = new Error('codex run metric aggregation unavailable');
    error.code = 'budget_store_unavailable';
    throw error;
  } else {
    const result = await prisma.codexRunMetric.aggregate({
      where: {
        createdAt: { gte: utcDayStart(now) },
        run: { projectId },
      },
      _sum: { costOriginalUsd: true, costAppliedUsd: true },
    });
    const original = Number(result?._sum?.costOriginalUsd);
    const applied = Number(result?._sum?.costAppliedUsd);
    // Aggregate is retained for older stores and narrow test doubles. New
    // stores sum max(original, applied) per row so mixed legacy data is kept.
    runCostUsd = Math.max(
      0,
      Number.isFinite(original) && original > 0 ? original : (applied || 0),
    );
  }
  const autonomousCostUsd = await usageLedgerCostUsd({ prisma, projectId, now });
  return runCostUsd + autonomousCostUsd;
}

async function costTodayUsdForPool({
  prisma,
  projectId,
  departmentPoolId,
  now = new Date(),
}) {
  if (!prisma?.codexRunMetric?.findMany) {
    const error = new Error('codex pool metric aggregation unavailable');
    error.code = 'pool_budget_store_unavailable';
    throw error;
  }
  const rows = await prisma.codexRunMetric.findMany({
    where: {
      createdAt: { gte: utcDayStart(now) },
      run: {
        projectId,
        departmentPoolId,
      },
    },
    select: { costOriginalUsd: true, costAppliedUsd: true },
  });
  const runCostUsd = rows.reduce((total, row) => total + rowCostUsd(row), 0);
  const autonomousCostUsd = await usageLedgerCostUsd({
    prisma,
    projectId,
    departmentPoolId,
    now,
  });
  return runCostUsd + autonomousCostUsd;
}

function boundedNonNegative(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function taskBudgetReservationUsd(task, defaultReservationUsd = 0) {
  if (!task) return 0;
  const input = task?.input && typeof task.input === 'object' && !Array.isArray(task.input)
    ? task.input
    : {};
  const explicit = boundedNonNegative(
    input.projectBudgetReservationUsd ?? input.poolBudgetReservationUsd,
  );
  return explicit > 0 ? explicit : boundedNonNegative(defaultReservationUsd);
}

function taskDepartmentPoolId(task) {
  const input = task?.input && typeof task.input === 'object' && !Array.isArray(task.input)
    ? task.input
    : {};
  return String(input.departmentPoolId || '').trim() || null;
}

async function checkSwarmClaimBudget({
  prisma,
  projectId,
  task,
  projectDailyBudgetUsd = null,
  companyDailyBudgetUsd = null,
  defaultReservationUsd = 0,
  now = new Date(),
}) {
  const projectLimit = projectDailyBudgetUsd == null
    ? null
    : boundedNonNegative(projectDailyBudgetUsd);
  const companyLimit = companyDailyBudgetUsd == null
    ? null
    : boundedNonNegative(companyDailyBudgetUsd);
  const departmentPoolId = taskDepartmentPoolId(task);
  if (projectLimit == null && companyLimit == null && !departmentPoolId) {
    return { allowed: true, reason: 'unlimited' };
  }
  if (!prisma?.codexSwarmTask?.findMany) {
    return { allowed: false, reason: 'swarm_budget_store_unavailable' };
  }
  try {
    const runningTasks = await prisma.codexSwarmTask.findMany({
      where: {
        status: 'running',
        leaseExpiresAt: { gt: now },
        swarm: { projectId },
      },
      select: { id: true, input: true },
    });
    const activeReservationsUsd = runningTasks.reduce(
      (total, row) => (
        row.id === task?.id
          ? total
          : total + taskBudgetReservationUsd(row, defaultReservationUsd)
      ),
      0,
    );
    const reservationUsd = taskBudgetReservationUsd(task, defaultReservationUsd);
    const persistedCostTodayUsd = await costTodayUsd({ prisma, projectId, now });
    const projectedCostUsd = persistedCostTodayUsd + activeReservationsUsd + reservationUsd;
    if (projectLimit != null && projectedCostUsd > projectLimit) {
      return {
        allowed: false,
        reason: 'project_budget_limit',
        projectDailyBudgetUsd: projectLimit,
        companyDailyBudgetUsd: companyLimit,
        persistedCostTodayUsd,
        activeReservationsUsd,
        reservationUsd,
        projectedCostUsd,
      };
    }
    if (companyLimit != null && projectedCostUsd > companyLimit) {
      return {
        allowed: false,
        reason: 'company_budget_limit',
        projectDailyBudgetUsd: projectLimit,
        companyDailyBudgetUsd: companyLimit,
        persistedCostTodayUsd,
        activeReservationsUsd,
        reservationUsd,
        projectedCostUsd,
      };
    }
    if (departmentPoolId) {
      const poolBudget = await checkDepartmentPoolBudget({
        prisma,
        projectId,
        departmentPoolId,
        swarmTaskId: task?.id || null,
        admissionReservationUsd: reservationUsd,
        now,
      });
      if (!poolBudget.allowed) {
        return {
          ...poolBudget,
          projectDailyBudgetUsd: projectLimit,
          companyDailyBudgetUsd: companyLimit,
          projectPersistedCostTodayUsd: persistedCostTodayUsd,
          projectActiveReservationsUsd: activeReservationsUsd,
          projectReservationUsd: reservationUsd,
          projectProjectedCostUsd: projectedCostUsd,
        };
      }
    }
    return {
      allowed: true,
      reason: 'swarm_budget_available',
      projectDailyBudgetUsd: projectLimit,
      companyDailyBudgetUsd: companyLimit,
      departmentPoolId,
      persistedCostTodayUsd,
      activeReservationsUsd,
      reservationUsd,
      projectedCostUsd,
    };
  } catch (error) {
    return {
      allowed: false,
      reason: 'swarm_budget_query_failed',
      error: String(error?.message || error).slice(0, 500),
    };
  }
}

async function activePoolReservationsUsd({
  prisma,
  projectId,
  departmentPoolId,
  excludeTaskId = null,
  now = new Date(),
}) {
  if (!prisma?.codexSwarmTask?.findMany) {
    const error = new Error('codex pool reservation store unavailable');
    error.code = 'pool_budget_store_unavailable';
    throw error;
  }
  const rows = await prisma.codexSwarmTask.findMany({
    where: {
      status: 'running',
      leaseExpiresAt: { gt: now },
      swarm: { projectId },
      ...(excludeTaskId ? { id: { not: excludeTaskId } } : {}),
    },
    select: { input: true },
  });
  return rows.reduce((total, row) => {
    const input = row?.input && typeof row.input === 'object' && !Array.isArray(row.input)
      ? row.input
      : {};
    if (String(input.departmentPoolId || '') !== String(departmentPoolId)) return total;
    return total + boundedNonNegative(input.poolBudgetReservationUsd);
  }, 0);
}

async function checkDepartmentPoolBudget({
  prisma,
  projectId,
  departmentPoolId,
  swarmTaskId = null,
  reservationUsd = null,
  reservationUsageUsd = null,
  admissionReservationUsd = null,
  now = new Date(),
  inRunCostUsd = 0,
}) {
  const poolId = String(departmentPoolId || '').trim();
  if (!poolId) return { allowed: true, reason: 'not_pooled' };
  const runningCost = boundedNonNegative(inRunCostUsd);
  if (!prisma?.codexDepartmentPool?.findUnique) {
    return {
      allowed: false,
      reason: 'department_pool_budget_store_unavailable',
      inRunCostUsd: runningCost,
    };
  }
  try {
    const pool = await prisma.codexDepartmentPool.findUnique({ where: { id: poolId } });
    if (!pool || String(pool.projectId) !== String(projectId)) {
      return { allowed: false, reason: 'department_pool_missing', inRunCostUsd: runningCost };
    }
    if (pool.enabled === false) {
      return { allowed: false, reason: 'department_pool_paused', inRunCostUsd: runningCost };
    }
    const reservedForRunUsd = reservationUsd == null
      ? null
      : boundedNonNegative(reservationUsd);
    const reservationUsage = reservationUsageUsd == null
      ? runningCost
      : boundedNonNegative(reservationUsageUsd);
    const reservationExceeded = reservedForRunUsd != null
      && reservationUsage >= reservedForRunUsd;
    if (pool.dailyBudgetUsd == null) {
      return {
        allowed: !reservationExceeded,
        reason: reservationExceeded
          ? 'department_pool_run_reservation_exceeded'
          : 'department_pool_unlimited',
        persistedCostTodayUsd: null,
        activeReservationsUsd: null,
        admissionReservationUsd: boundedNonNegative(admissionReservationUsd),
        inRunCostUsd: runningCost,
        reservationUsageUsd: reservationUsage,
        reservationUsd: reservedForRunUsd,
        costTodayUsd: runningCost,
        dailyBudgetUsd: null,
        remainingUsd: null,
      };
    }
    const dailyBudgetUsd = boundedNonNegative(pool.dailyBudgetUsd);
    if (dailyBudgetUsd === 0) {
      return {
        allowed: false,
        reason: 'department_pool_budget_blocked',
        dailyBudgetUsd,
        inRunCostUsd: runningCost,
      };
    }
    const [persistedCostTodayUsd, activeReservationsUsd] = await Promise.all([
      costTodayUsdForPool({ prisma, projectId, departmentPoolId: poolId, now }),
      activePoolReservationsUsd({
        prisma,
        projectId,
        departmentPoolId: poolId,
        excludeTaskId: swarmTaskId,
        now,
      }),
    ]);
    const admissionReservation = boundedNonNegative(admissionReservationUsd);
    const costTodayUsd = persistedCostTodayUsd
      + activeReservationsUsd
      + runningCost
      + admissionReservation;
    const allowed = !reservationExceeded && costTodayUsd < dailyBudgetUsd;
    return {
      allowed,
      reason: reservationExceeded
        ? 'department_pool_run_reservation_exceeded'
        : allowed
          ? 'department_pool_budget_available'
          : 'department_pool_budget_limit',
      persistedCostTodayUsd,
      activeReservationsUsd,
      admissionReservationUsd: admissionReservation,
      inRunCostUsd: runningCost,
      reservationUsageUsd: reservationUsage,
      reservationUsd: reservedForRunUsd,
      costTodayUsd,
      dailyBudgetUsd,
      remainingUsd: Math.max(0, dailyBudgetUsd - costTodayUsd),
    };
  } catch (error) {
    return {
      allowed: false,
      reason: 'department_pool_budget_query_failed',
      error: String(error?.message || error).slice(0, 500),
      inRunCostUsd: runningCost,
    };
  }
}

function record(outcome) {
  try { metrics.counter(CHECKS, { outcome }, 1); } catch { /* no-op */ }
}

async function checkProjectBudget({
  prisma,
  projectId,
  settings,
  env = process.env,
  now = new Date(),
  inRunCostUsd = 0,
}) {
  const dailyBudgetUsd = configuredBudgetUsd(settings, env);
  const runningCost = Math.max(0, Number(inRunCostUsd) || 0);
  if (dailyBudgetUsd == null) {
    record('unlimited');
    return {
      allowed: true,
      reason: 'unlimited',
      costTodayUsd: runningCost,
      persistedCostTodayUsd: 0,
      inRunCostUsd: runningCost,
      dailyBudgetUsd: null,
      remainingUsd: null,
    };
  }
  try {
    const persistedCost = await costTodayUsd({ prisma, projectId, now });
    const spent = persistedCost + runningCost;
    const allowed = spent < dailyBudgetUsd;
    record(allowed ? 'allowed' : 'blocked');
    return {
      allowed,
      reason: allowed ? 'within_budget' : 'daily_budget_exceeded',
      costTodayUsd: spent,
      persistedCostTodayUsd: persistedCost,
      inRunCostUsd: runningCost,
      dailyBudgetUsd,
      remainingUsd: Math.max(0, dailyBudgetUsd - spent),
    };
  } catch (error) {
    record('error');
    return {
      // A spend limit is a safety control, not telemetry. If its durable
      // counter cannot be read, every caller (manual, proactive or pooled)
      // must stop regardless of environment.
      allowed: false,
      reason: 'budget_query_failed',
      error: String(error?.message || error).slice(0, 500),
      costTodayUsd: null,
      persistedCostTodayUsd: null,
      inRunCostUsd: runningCost,
      dailyBudgetUsd,
      remainingUsd: null,
    };
  }
}

async function checkCompanyDailyBudget({
  prisma,
  project,
  env = process.env,
  now = new Date(),
  inRunCostUsd = 0,
}) {
  const dailyBudgetUsd = configuredCompanyBudgetUsd(project, env);
  return checkProjectBudget({
    prisma,
    projectId: project.id,
    settings: { budget: { dailyUsd: dailyBudgetUsd } },
    env,
    now,
    inRunCostUsd,
  });
}

module.exports = {
  CHECKS,
  utcDayStart,
  configuredBudgetUsd,
  configuredCompanyBudgetUsd,
  costTodayUsd,
  costTodayUsdForPool,
  usageLedgerCostUsd,
  taskBudgetReservationUsd,
  taskDepartmentPoolId,
  checkSwarmClaimBudget,
  activePoolReservationsUsd,
  checkProjectBudget,
  checkCompanyDailyBudget,
  checkDepartmentPoolBudget,
};
