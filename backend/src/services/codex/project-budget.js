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

async function costTodayUsd({ prisma, projectId, now = new Date() }) {
  if (!prisma?.codexRunMetric?.aggregate) {
    const error = new Error('codex run metric aggregation unavailable');
    error.code = 'budget_store_unavailable';
    throw error;
  }
  const result = await prisma.codexRunMetric.aggregate({
    where: {
      createdAt: { gte: utcDayStart(now) },
      run: { projectId },
    },
    _sum: { costAppliedUsd: true },
  });
  return Math.max(0, Number(result?._sum?.costAppliedUsd) || 0);
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
}) {
  const dailyBudgetUsd = configuredBudgetUsd(settings, env);
  if (dailyBudgetUsd == null) {
    record('unlimited');
    return {
      allowed: true,
      reason: 'unlimited',
      costTodayUsd: 0,
      dailyBudgetUsd: null,
      remainingUsd: null,
    };
  }
  try {
    const spent = await costTodayUsd({ prisma, projectId, now });
    const allowed = spent < dailyBudgetUsd;
    record(allowed ? 'allowed' : 'blocked');
    return {
      allowed,
      reason: allowed ? 'within_budget' : 'daily_budget_exceeded',
      costTodayUsd: spent,
      dailyBudgetUsd,
      remainingUsd: Math.max(0, dailyBudgetUsd - spent),
    };
  } catch (error) {
    record('error');
    return {
      allowed: env?.NODE_ENV !== 'production',
      reason: 'budget_query_failed',
      error: String(error?.message || error).slice(0, 500),
      costTodayUsd: null,
      dailyBudgetUsd,
      remainingUsd: null,
    };
  }
}

module.exports = {
  CHECKS,
  utcDayStart,
  configuredBudgetUsd,
  costTodayUsd,
  checkProjectBudget,
};
