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

  const { runAgent, enqueueDelegatedTask } = require('./agent-entry');
  const mode = opts.mode || 'async';
  const taskId = opts.taskId || `sub_${Date.now().toString(36)}`;

  registry.record({
    id: taskId,
    parentId: opts.parentTaskId || null,
    mode: opts.policy || 'sandbox',
    model: opts.model || null,
    status: 'active',
  });

  if (mode === 'sync') {
    try {
      const result = await runAgent({
        userId,
        prompt,
        thinking: opts.thinking || 'low',
        model: opts.model || 'gpt-4o',
        maxSteps: opts.maxSteps || 8,
        source: opts.source || `hermes:delegate:${taskId}`,
        depth: depth + 1,
        taskId,
      });
      registry.complete(taskId, { status: 'completed' });
      return { ok: true, mode: 'sync', taskId, result };
    } catch (err) {
      registry.complete(taskId, { status: 'failed', error: err.message });
      return { ok: false, mode: 'sync', taskId, error: err.message };
    }
  }

  const queued = await enqueueDelegatedTask(prompt, {
    userId,
    collection: opts.collection || 'default',
    taskId,
    depth,
  }, {
    taskId,
    taskType: opts.taskType || 'hermes_delegate',
    thinking: opts.thinking || 'low',
    model: opts.model || 'gpt-4o',
    maxSteps: opts.maxSteps || 8,
    source: opts.source || `hermes:delegate:${taskId}`,
    parentTaskId: opts.parentTaskId || null,
    metadata: opts.metadata || {},
  });

  return { ok: true, mode: 'async', taskId: queued.taskId, status: queued.status };
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
