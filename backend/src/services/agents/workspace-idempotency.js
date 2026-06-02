'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync, readJsonSafe } = require('../../utils/atomic-json-write');

const WINDOW_MS = Number.parseInt(process.env.WORKFLOW_IDEMPOTENCY_WINDOW_MS || `${6 * 60 * 60 * 1000}`, 10);
const STORE_DIR = process.env.WORKFLOW_IDEMPOTENCY_DIR
  || path.join(process.cwd(), 'uploads', 'workflow-idempotency');

function hashGoal(userId, goal, chatId) {
  const payload = `${userId}|${String(chatId || '')}|${String(goal || '').trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function recordPath(userId, key) {
  const safeUser = String(userId || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
  return path.join(STORE_DIR, safeUser, `${key}.json`);
}

/**
 * Returns existing in-flight workflow { taskId, jobId } if the same goal was
 * enqueued recently for this user.
 */
function findExistingWorkflow(userId, goal, chatId) {
  if (!userId || !goal) return null;
  const key = hashGoal(userId, goal, chatId);
  const file = recordPath(userId, key);
  const row = readJsonSafe(file, null);
  if (!row) return null;
  if (!row?.taskId) return null;
  const age = Date.now() - Number(row.createdAt || 0);
  if (age > WINDOW_MS) {
    try { fs.unlinkSync(file); } catch {}
    return null;
  }
  if (['completed', 'failed', 'cancelled', 'error'].includes(String(row.status || ''))) {
    return null;
  }
  return row;
}

function registerWorkflow(userId, goal, chatId, meta = {}) {
  if (!userId || !goal) return null;
  const key = hashGoal(userId, goal, chatId);
  const row = {
    idempotencyKey: key,
    userId: String(userId),
    chatId: chatId || null,
    taskId: meta.taskId || null,
    jobId: meta.jobId || null,
    status: meta.status || 'queued',
    createdAt: Date.now(),
  };
  writeJsonAtomicSync(recordPath(userId, key), row, { pretty: true, ensureDir: true });
  return row;
}

function updateWorkflowStatus(userId, goal, chatId, status) {
  const existing = findExistingWorkflow(userId, goal, chatId);
  if (!existing) return;
  registerWorkflow(userId, goal, chatId, { ...existing, status });
}

module.exports = {
  WINDOW_MS,
  hashGoal,
  findExistingWorkflow,
  registerWorkflow,
  updateWorkflowStatus,
};
