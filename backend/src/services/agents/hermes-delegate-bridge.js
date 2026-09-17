'use strict';

/**
 * Hermes delegate bridge — JS port of hermes-agent delegate_task / subagent flows.
 */

const { createSubagentRegistry } = require('./subagent-registry');

const registry = createSubagentRegistry({
  archiveAfterMinutes: process.env.HERMES_SUBAGENT_ARCHIVE_MINUTES || 60,
});

async function delegateTask(opts = {}) {
  const userId = opts.userId;
  const prompt = String(opts.prompt || '').trim();
  if (!userId) throw new Error('delegateTask: userId required');
  if (!prompt) throw new Error('delegateTask: prompt required');

  const depth = Number(opts.depth || 0);
  const maxDepth = Number(process.env.HERMES_DELEGATE_MAX_DEPTH || 3);
  if (depth >= maxDepth) {
    return { ok: false, reason: 'max_delegate_depth', depth, maxDepth };
  }

  const mode = opts.mode || 'async';
  if (mode !== 'sync') {
    return {
      ok: false,
      mode: 'async',
      reason: 'hermes_async_delegate_unavailable',
      error: 'La delegación en segundo plano aún no está disponible. Usa el modo síncrono o continúa en este agente.',
    };
  }
  const taskId = opts.taskId || `sub_${Date.now().toString(36)}`;

  let recorded = false;
  try {
    const { runTurn, resolveHermesModel } = require('./hermes-agent-bridge');
    const model = resolveHermesModel(opts.model);
    registry.record({
      id: taskId,
      parentId: opts.parentTaskId || null,
      mode: opts.policy || 'sandbox',
      model,
      status: 'active',
    });
    recorded = true;
    const result = await runTurn({
      userId,
      prompt,
      thinking: opts.thinking || 'low',
      model,
      provider: opts.provider,
      learning: false,
      maxSteps: opts.maxSteps || 8,
      maxRuntimeMs: opts.maxRuntimeMs,
      signal: opts.signal,
      source: opts.source || `hermes:delegate:${taskId}`,
      depth: depth + 1,
      taskId,
    });
    registry.complete(taskId, { status: 'completed' });
    return { ok: true, mode: 'sync', taskId, result };
  } catch (err) {
    const code = ['E_PARAMS', 'E_PROVIDER', 'E_CANCELLED'].includes(err?.code) ? err.code : 'E_PROVIDER';
    const error = code === 'E_PARAMS'
      ? 'Elige Sira Rápido o Sira Pro con una conexión permitida para ejecutar el agente.'
      : code === 'E_CANCELLED'
        ? 'La ejecución del agente fue cancelada.'
        : 'La ejecución del agente no pudo completarse. Reintenta.';
    if (recorded) registry.complete(taskId, { status: code === 'E_CANCELLED' ? 'cancelled' : 'failed', error });
    return { ok: false, mode: 'sync', taskId, code, error };
  }
}

function listSubagents(opts = {}) {
  return registry.list(opts);
}

function getSubagent(id) {
  return registry.get(id);
}

function status() {
  return {
    active: registry.list({ status: 'active' }).length,
    completed: registry.list({ status: 'completed' }).length,
    total: registry.size(),
  };
}

module.exports = {
  delegateTask,
  listSubagents,
  getSubagent,
  status,
  registry,
};
