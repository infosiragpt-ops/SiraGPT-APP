'use strict';

/**
 * Read-only specialist swarm for proactive builds.
 *
 * The swarm can fan out market/repository/QA analysis because those agents
 * cannot mutate the checkout. Their reports are consolidated into the main
 * loop before the single writer starts. This is the safe scaling boundary
 * until every writer receives an isolated worktree.
 */

const agentSdk = require('./agent-sdk');
const progressLedger = require('./progress-ledger');

const DEFAULT_MAX_PARALLEL = 6;
const HARD_MAX_PARALLEL = 32;

function parallelLimit(env = process.env) {
  const parsed = Number.parseInt(env.CODEX_PROACTIVE_SWARM_MAX ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_PARALLEL;
  return Math.max(0, Math.min(HARD_MAX_PARALLEL, parsed));
}

function selectSpecialists(meta, env = process.env) {
  const limit = parallelLimit(env);
  if (limit === 0) return [];
  return progressLedger.normalizeSwarm(meta?.swarm)
    .filter((item) => agentSdk.getSubagent(item.agent)?.readOnly === true)
    .slice(0, limit);
}

async function runSpecialist({
  specialist,
  task,
  context,
  deps,
}) {
  let live = null;
  if (typeof deps.emitAgent === 'function') {
    live = await Promise.resolve(deps.emitAgent({
      agent: specialist.agent,
      task: specialist.task,
    })).catch(() => null);
  }
  const outcome = await agentSdk.runSubagent({
    name: specialist.agent,
    task: specialist.task,
    context: [task, context].filter(Boolean).join('\n\n'),
    model: deps.model || null,
    effort: deps.effort || null,
    deps: {
      runner: deps.runner,
      project: deps.project,
      webSearch: deps.webSearch,
      llmTurn: deps.llmTurn,
      env: deps.env,
      signal: deps.signal,
      tier: deps.tier,
      model: deps.model,
      projectSettings: deps.projectSettings,
      companySoul: deps.companySoul,
      onUsage: deps.onUsage,
      emitAction: deps.emitAction,
    },
  });
  if (live && typeof live.end === 'function') {
    await Promise.resolve(live.end({
      status: outcome.ok ? 'done' : 'error',
      outputSummary: String(outcome.result || '').slice(0, 500),
    })).catch(() => {});
  }
  return outcome;
}

async function runProactiveSwarm({
  meta,
  task,
  context = '',
  deps = {},
}) {
  const specialists = selectSpecialists(meta, deps.env);
  if (!specialists.length) {
    return {
      requested: 0,
      completed: 0,
      failed: 0,
      reports: [],
      text: '',
    };
  }

  const settled = await Promise.allSettled(
    specialists.map((specialist) => runSpecialist({
      specialist,
      task,
      context,
      deps,
    })),
  );
  const reports = settled.map((entry, index) => {
    if (entry.status === 'fulfilled') return entry.value;
    return {
      ok: false,
      agent: specialists[index].agent,
      result: String(entry.reason?.message || entry.reason || 'fallo no identificado').slice(0, 1000),
      steps: 0,
      toolCallsCount: 0,
      actions: [],
      durationMs: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
  });
  const completed = reports.filter((report) => report.ok).length;
  return {
    requested: specialists.length,
    completed,
    failed: specialists.length - completed,
    reports,
    text: [
      `[SWARM DE ESPECIALISTAS · ${completed}/${specialists.length} completados]`,
      ...reports.map(agentSdk.formatSubagentReport),
      'Usa estos informes como contexto. Confirma con herramientas cualquier estado mutable antes de escribir.',
    ].join('\n\n').slice(0, 24_000),
  };
}

module.exports = {
  DEFAULT_MAX_PARALLEL,
  HARD_MAX_PARALLEL,
  parallelLimit,
  runProactiveSwarm,
  selectSpecialists,
};
