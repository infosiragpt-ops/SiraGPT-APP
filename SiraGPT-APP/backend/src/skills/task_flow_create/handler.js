'use strict';

const defaultStore = require('../../services/agents/task-flow-store');

async function execute(args = {}, ctx = {}) {
  if (!ctx.userId) throw new Error('task_flow_create: ctx.userId required');
  const store = ctx.taskFlowStore || defaultStore;
  const flow = store.createManagedTaskFlow({
    userId: ctx.userId,
    chatId: args.chatId || ctx.chatId || null,
    controllerId: args.controllerId || 'siragpt/agent',
    goal: args.goal,
    currentStep: args.currentStep || null,
    stateJson: args.stateJson || {},
  });
  return { ok: true, flow: store.summarizeTaskFlow(flow), stateJson: flow.stateJson };
}

module.exports = { execute };
