/**
 * agent-collaboration — lightweight multi-agent coordination layer.
 *
 * Decouples complex tasks across specialised sub-agents without any
 * UI changes. Each sub-agent receives its own goal + context, executes
 * independently (or sequentially when chaining), and the results are
 * merged into a single structured response.
 *
 * Coordination Patterns:
 *   FORK_JOIN   — Run N agents in parallel, merge results (reports, analysis)
 *   CHAIN       — Agent N receives Agent N-1's output as context
 *   FORK_VOTE   — Run N agents, pick best via voting/review
 *   FORK_REVIEW — Run N agents, review each, pick or merge best
 *
 * Pure JS, zero runtime deps beyond the existing agent-core.
 */

const { runAgentTaskJob } = require('./agent-task-runner');
const { TASK_STATUS } = require('./task-store');

// Maximum sub-agents per coordination
const MAX_SUB_AGENTS = 5;

/**
 * Coordinate multiple agents using the FORK_JOIN pattern.
 * All agents run in parallel (via Promise.allSettled).
 */
async function forkJoin({ subTasks = [], user, options = {} }) {
  if (!Array.isArray(subTasks) || subTasks.length === 0) {
    return { ok: false, error: 'no_sub_tasks', results: [] };
  }
  if (subTasks.length > MAX_SUB_AGENTS) {
    return { ok: false, error: `max ${MAX_SUB_AGENTS} sub-tasks allowed`, results: [] };
  }

  const results = await Promise.allSettled(
    subTasks.map((task, idx) =>
      runAgentTaskJob(
        {
          taskId: task.taskId || `collab-${Date.now()}-${idx}`,
          goal: task.goal,
          chatId: options.chatId,
          user,
          maxSteps: task.maxSteps || options.maxSteps || 25,
          maxRuntimeMs: task.maxRuntimeMs || options.maxRuntimeMs || 120_000,
          context: task.context,
        },
        null
      ).catch((err) => ({ error: err?.message || String(err) }))
    )
  );

  const merged = results.map((r, idx) => ({
    index: idx,
    goal: subTasks[idx]?.goal,
    ok: r.status === 'fulfilled' && r.value?.ok !== false,
    result: r.status === 'fulfilled' ? r.value : null,
    error: r.status === 'rejected' ? r.reason?.message || String(r.reason) : null,
  }));

  return {
    ok: merged.some((m) => m.ok),
    pattern: 'fork_join',
    results: merged,
    totalSubAgents: subTasks.length,
  };
}

/**
 * Coordinate multiple agents using the CHAIN pattern.
 * Each agent receives the previous agent's output as context.
 */
async function chain({ subTasks = [], user, options = {} }) {
  if (!Array.isArray(subTasks) || subTasks.length === 0) {
    return { ok: false, error: 'no_sub_tasks', results: [] };
  }

  const results = [];
  let context = null;

  for (let idx = 0; idx < subTasks.length; idx++) {
    const task = subTasks[idx];
    const taskContext = context
      ? { previousOutput: context, ...(task.context || {}) }
      : task.context;

    const result = await runAgentTaskJob(
      {
        taskId: task.taskId || `chain-${Date.now()}-${idx}`,
        goal: task.goal,
        chatId: options.chatId,
        user,
        maxSteps: task.maxSteps || options.maxSteps || 25,
        maxRuntimeMs: task.maxRuntimeMs || options.maxRuntimeMs || 180_000,
        context: taskContext,
      },
      null
    ).catch((err) => ({ error: err?.message || String(err) }));

    results.push({
      index: idx,
      goal: task.goal,
      ok: result?.ok !== false,
      result,
    });

    // Pass output to next step
    context = result?.output || result?.markdown || result?.summary || result;
  }

  return {
    ok: results.every((r) => r.ok),
    pattern: 'chain',
    results,
    totalSubAgents: subTasks.length,
  };
}

/**
 * Decompose a complex goal into sub-tasks automatically.
 * Returns an array of { goal, context? } suitable for forkJoin or chain.
 */
function decomposeGoal(goal, { maxParts = 4 } = {}) {
  if (!goal || typeof goal !== 'string') return [];
  const text = goal.trim();

  // Simple heuristic: split by transition words into sub-tasks
  const separators = [
    /\b(y\s|and\s+also|además|también|por otro lado)\b/i,
    /\b(luego|then|next|después|a continuación)\b/i,
    /\b(finalmente|finally|por último|en resumen)\b/i,
    /\b(primero|first|en primer lugar)\b/i,
  ];

  let parts = [text];

  for (const sep of separators) {
    if (parts.length >= maxParts) break;
    const newParts = [];
    for (const part of parts) {
      const split = part.split(sep);
      for (const s of split) {
        const trimmed = s.trim();
        if (trimmed) newParts.push(trimmed);
        if (newParts.length >= maxParts) break;
      }
    }
    if (newParts.length > parts.length) parts = newParts;
  }

  return parts.slice(0, maxParts).map((g, idx) => ({
    goal: g,
    context: { partIndex: idx, totalParts: Math.min(parts.length, maxParts) },
  }));
}

module.exports = {
  forkJoin,
  chain,
  decomposeGoal,
  MAX_SUB_AGENTS,
};
