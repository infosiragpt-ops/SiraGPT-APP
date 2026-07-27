'use strict';

const defaultStore = require('../../services/agents/task-flow-store');
const defaultTaskStore = require('../../services/agents/task-store');

const OPERATIONS = Object.freeze({
  set_waiting: 'setTaskFlowWaiting',
  block: 'blockTaskFlow',
  resume: 'resumeTaskFlow',
  finish: 'finishTaskFlow',
  fail: 'failTaskFlow',
  request_cancel: 'requestTaskFlowCancel',
  cancel: 'cancelTaskFlow',
  link_task: 'linkTaskFlowChild',
});

async function execute(args = {}, ctx = {}) {
  if (!ctx.userId) throw new Error('task_flow_update: ctx.userId required');
  const store = ctx.taskFlowStore || defaultStore;
  const method = OPERATIONS[args.action];
  if (!method || typeof store[method] !== 'function') {
    return { ok: false, error: 'unsupported_action' };
  }

  if (args.action === 'link_task') {
    if (!args.childTask?.taskId) return { ok: false, error: 'child_task_required' };
    const taskStore = ctx.taskStore || defaultTaskStore;
    const child = taskStore.getTaskSnapshotForUser(args.childTask.taskId, ctx.userId);
    if (!child) return { ok: false, error: 'child_task_not_found' };
    args = {
      ...args,
      childTask: {
        ...args.childTask,
        status: args.childTask.status || child.status,
        sessionId: args.childTask.sessionId || child.chatId || null,
        runId: args.childTask.runId || child.jobId || null,
        startedAt: args.childTask.startedAt || child.createdAt || null,
        lastEventAt: args.childTask.lastEventAt || child.updatedAt || null,
        completedAt: args.childTask.completedAt || child.completedAt || null,
      },
    };
  }

  try {
    const flow = await store[method]({ ...args, userId: ctx.userId });
    return {
      ok: true,
      flow: store.summarizeTaskFlow(flow),
      stateJson: flow.stateJson,
      waitJson: flow.waitJson,
      childTasks: flow.childTasks,
    };
  } catch (error) {
    if (error instanceof store.TaskFlowError || error?.name === 'TaskFlowError') {
      return { ok: false, error: error.code, message: error.message, ...error.details };
    }
    throw error;
  }
}

module.exports = { execute, OPERATIONS };
