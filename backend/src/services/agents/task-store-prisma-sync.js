'use strict';

/**
 * Dual-write agent task snapshots to Postgres when Prisma is available.
 * File store remains source of truth for SSE replay; DB enables multi-replica queries.
 */

let _persistence;
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

  setImmediate(async () => {
    try {
      await persistence.upsertAgentTask({
        taskId: snapshot.taskId,
        userId: snapshot.userId,
        chatId: snapshot.chatId,
        jobId: snapshot.jobId,
        status: snapshot.status,
        displayGoal: snapshot.displayGoal,
        goal: snapshot.agentGoal || snapshot.displayGoal,
        model: snapshot.model,
        traceId: snapshot.traceId,
        documentPolicy: snapshot.documentPolicy || snapshot.streamState?.documentPolicy,
        streamState: snapshot.streamState,
        state: snapshot.streamState,
        completedAt: snapshot.completedAt,
        cancelledAt: snapshot.cancelledAt,
        failedAt: snapshot.failedAt,
      });
      if (event?.type && persistence.appendAgentTaskEvent) {
        await persistence.appendAgentTaskEvent(snapshot, event);
      }
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[task-store-prisma-sync] skipped:', err?.message || err);
      }
    }
  });
}

module.exports = {
  enabled,
  schedulePrismaSync,
};
