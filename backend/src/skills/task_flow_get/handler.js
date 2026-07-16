'use strict';

const defaultStore = require('../../services/agents/task-flow-store');

async function execute(args = {}, ctx = {}) {
  if (!ctx.userId) throw new Error('task_flow_get: ctx.userId required');
  const store = ctx.taskFlowStore || defaultStore;
  const flow = store.getTaskFlowForUser(args.flowId, ctx.userId);
  if (!flow) return { ok: false, error: 'flow_not_found' };
  const eventLimit = Math.max(0, Math.min(Number(args.eventLimit ?? 20) || 0, 100));
  return {
    ok: true,
    flow: store.summarizeTaskFlow(flow),
    stateJson: flow.stateJson,
    waitJson: flow.waitJson,
    childTasks: flow.childTasks,
    events: eventLimit > 0 ? flow.events.slice(-eventLimit) : [],
  };
}

module.exports = { execute };
