'use strict';

/**
 * Dual-write agent task snapshots to Postgres when Prisma is available.
 * File store remains source of truth for SSE replay; DB enables multi-replica queries.
 */

let _persistence;
const tails = new Map();
function loadPersistence() {
  if (!_persistence) {
    try {
      _persistence = require('./agent-task-persistence');
    } catch {
      _persistence = null;
    }
  }
  return _persistence;
}

function enabled() {
  return process.env.AGENT_TASK_PRISMA_SYNC !== '0';
}

function schedulePrismaSync(snapshot, event) {
  if (!enabled() || !snapshot?.taskId || !snapshot?.userId) return;
  const persistence = loadPersistence();
  if (!persistence?.upsertAgentTask) return;

  // Immutable cumulative snapshots, ordered per task. A slow earlier upsert
  // cannot overwrite a terminal state, and individual events are never coalesced.
  const value = structuredClone(snapshot);
  const stamped = event ? structuredClone(event) : null;
  const previous = tails.get(value.taskId) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    try {
      await persistence.upsertAgentTask({
        taskId: value.taskId,
        userId: value.userId,
        chatId: value.chatId,
        jobId: value.jobId,
        status: value.status,
        displayGoal: value.displayGoal,
        goal: value.agentGoal || value.displayGoal,
        model: value.model,
        traceId: value.traceId,
        documentPolicy: value.documentPolicy || value.streamState?.documentPolicy,
        streamState: value.streamState,
        state: value.streamState,
        completedAt: value.completedAt,
        cancelledAt: value.cancelledAt,
        failedAt: value.failedAt,
      });
      if (stamped?.type && persistence.appendAgentTaskEvent) {
        await persistence.appendAgentTaskEvent(value, stamped);
      }
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[task-store-prisma-sync] skipped:', err?.code || 'DB_WRITE_FAILED');
      }
    }
  });
  tails.set(value.taskId, next);
  next.finally(() => { if (tails.get(value.taskId) === next) tails.delete(value.taskId); }).catch(() => {});
}

async function flushPrismaSync() {
  while (tails.size) await Promise.all([...tails.values()]);
}

module.exports = {
  enabled,
  flushPrismaSync,
  schedulePrismaSync,
};
