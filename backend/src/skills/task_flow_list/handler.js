'use strict';

const defaultStore = require('../../services/agents/task-flow-store');

async function execute(args = {}, ctx = {}) {
  if (!ctx.userId) throw new Error('task_flow_list: ctx.userId required');
  const store = ctx.taskFlowStore || defaultStore;
  const rows = store.listTaskFlowsForUser(ctx.userId, {
    limit: args.limit,
    status: args.status,
  });
  return { ok: true, flows: rows.map(store.summarizeTaskFlow), count: rows.length };
}

module.exports = { execute };
