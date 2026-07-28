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
  const projectValue = project?.brief?.proactive?.dailyBudgetUsd;
  if (projectValue != null && Number.isFinite(Number(projectValue))) {
    return Math.max(0, Number(projectValue));
  }
  const envValue = Number(env?.CODEX_PROACTIVE_DAILY_BUDGET_USD);
  return Number.isFinite(envValue) && envValue >= 0 ? envValue : 25;
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
    _sum: { costOriginalUsd: true, costAppliedUsd: true },
  });
  const original = Number(result?._sum?.costOriginalUsd);
  const applied = Number(result?._sum?.costAppliedUsd);
  // A project budget is an operator kill-switch for provider spend, not the
  // discounted amount shown to the customer. Fall back to the legacy applied
  // field for rows/fakes created before costOriginalUsd was populated.
  return Math.max(0, Number.isFinite(original) && original > 0 ? original : (applied || 0));
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
  checkProjectBudget,
  checkCompanyDailyBudget,
};
