'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const taskStore = require('../src/services/agents/task-store');
const {
  DEFAULT_BOOT_RECOVERY_STALE_MS,
  recoverAgentTasksAfterBoot,
} = require('../src/services/agents/agent-task-boot-recovery');

const originalEnv = {
  AGENT_TASK_STORE_DIR: process.env.AGENT_TASK_STORE_DIR,
  AGENT_TASK_BOOT_RECOVERY_DISABLED: process.env.AGENT_TASK_BOOT_RECOVERY_DISABLED,
  AGENT_TASK_BOOT_RECOVERY_STALE_MS: process.env.AGENT_TASK_BOOT_RECOVERY_STALE_MS,
  REDIS_URL: process.env.REDIS_URL,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
});

function useTempStore(prefix = 'sgpt-boot-recovery-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.AGENT_TASK_STORE_DIR = dir;
  return dir;
}

function ageTask(taskId, userId, ageMs) {
  taskStore.updateTaskSnapshot(taskId, userId, {
    updatedAt: new Date(Date.now() - ageMs).toISOString(),
  });
}

function captureLogger() {
  const entries = [];
  return {
    entries,
    info(fields, message) { entries.push({ level: 'info', fields, message }); },
    warn(fields, message) { entries.push({ level: 'warn', fields, message }); },
  };
}

test('agent task boot recovery marks stale in-flight snapshots as terminal after restart', () => {
  useTempStore();
  const logger = captureLogger();

  taskStore.writeTaskSnapshot({ taskId: 'stale-running', userId: 'u', status: 'running', displayGoal: 'old' });
  taskStore.writeTaskSnapshot({ taskId: 'fresh-running', userId: 'u', status: 'running', displayGoal: 'fresh' });
  taskStore.writeTaskSnapshot({ taskId: 'completed', userId: 'u', status: 'completed', displayGoal: 'done' });
  ageTask('stale-running', 'u', 2 * DEFAULT_BOOT_RECOVERY_STALE_MS);

  const result = recoverAgentTasksAfterBoot({ logger, env: process.env });

  assert.equal(result.count, 1);
  assert.equal(result.staleAfterMs, DEFAULT_BOOT_RECOVERY_STALE_MS);
  assert.equal(result.skipJobBacked, false);
  assert.deepEqual(result.recovered.map((row) => row.taskId), ['stale-running']);

  const recovered = taskStore.getTaskSnapshotForUser('stale-running', 'u');
  assert.equal(recovered.status, 'error');
  assert.equal(recovered.streamState.done, true);
  assert.equal(recovered.streamState.error, 'recovered_after_boot');
  assert.match(recovered.events.at(-1).message, /recovered_after_boot/);

  assert.equal(taskStore.getTaskSnapshotForUser('fresh-running', 'u').status, 'running');
  assert.equal(taskStore.getTaskSnapshotForUser('completed', 'u').status, 'completed');
  assert.equal(logger.entries.at(-1).message, 'agent_task_boot_recovery_completed');
  assert.deepEqual(logger.entries.at(-1).fields.taskIds, ['stale-running']);
});

test('agent task boot recovery is idempotent', () => {
  useTempStore();
  taskStore.writeTaskSnapshot({ taskId: 'stale-once', userId: 'u', status: 'queued', displayGoal: 'old' });
  ageTask('stale-once', 'u', 2 * DEFAULT_BOOT_RECOVERY_STALE_MS);

  const first = recoverAgentTasksAfterBoot({ env: process.env });
  const second = recoverAgentTasksAfterBoot({ env: process.env });

  assert.equal(first.count, 1);
  assert.equal(second.count, 0);
  assert.equal(taskStore.getTaskSnapshotForUser('stale-once', 'u').status, 'error');
});

test('agent task boot recovery skips BullMQ-backed snapshots when Redis is configured', () => {
  useTempStore();
  process.env.REDIS_URL = 'redis://localhost:6379/0';

  taskStore.writeTaskSnapshot({ taskId: 'job-backed', userId: 'u', status: 'running', jobId: 'job-1', displayGoal: 'queue' });
  taskStore.writeTaskSnapshot({ taskId: 'local-only', userId: 'u', status: 'running', displayGoal: 'local' });
  ageTask('job-backed', 'u', 2 * DEFAULT_BOOT_RECOVERY_STALE_MS);
  ageTask('local-only', 'u', 2 * DEFAULT_BOOT_RECOVERY_STALE_MS);

  const result = recoverAgentTasksAfterBoot({ env: process.env });

  assert.equal(result.count, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.skipJobBacked, true);
  assert.equal(taskStore.getTaskSnapshotForUser('local-only', 'u').status, 'error');
  assert.equal(taskStore.getTaskSnapshotForUser('job-backed', 'u').status, 'running');
});

test('agent task boot recovery can be disabled by environment flag', () => {
  useTempStore();
  process.env.AGENT_TASK_BOOT_RECOVERY_DISABLED = 'true';
  taskStore.writeTaskSnapshot({ taskId: 'stale-disabled', userId: 'u', status: 'running', displayGoal: 'old' });
  ageTask('stale-disabled', 'u', 2 * DEFAULT_BOOT_RECOVERY_STALE_MS);

  const result = recoverAgentTasksAfterBoot({ env: process.env });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'disabled');
  assert.equal(taskStore.getTaskSnapshotForUser('stale-disabled', 'u').status, 'running');
});

test('agent task boot recovery honors stale window override', () => {
  useTempStore();
  process.env.AGENT_TASK_BOOT_RECOVERY_STALE_MS = String(10 * DEFAULT_BOOT_RECOVERY_STALE_MS);
  taskStore.writeTaskSnapshot({ taskId: 'not-old-enough', userId: 'u', status: 'running', displayGoal: 'fresh-ish' });
  ageTask('not-old-enough', 'u', 2 * DEFAULT_BOOT_RECOVERY_STALE_MS);

  const result = recoverAgentTasksAfterBoot({ env: process.env });

  assert.equal(result.count, 0);
  assert.equal(result.staleAfterMs, 10 * DEFAULT_BOOT_RECOVERY_STALE_MS);
  assert.equal(taskStore.getTaskSnapshotForUser('not-old-enough', 'u').status, 'running');
});

test('agent task boot recovery fails open when the store throws', () => {
  const logger = captureLogger();
  const result = recoverAgentTasksAfterBoot({
    logger,
    env: process.env,
    taskStore: {
      recoverStaleRunningTasks() {
        throw new Error('snapshot dir unreadable');
      },
    },
  });

  assert.equal(result.count, 0);
  assert.equal(result.error, 'snapshot dir unreadable');
  assert.equal(logger.entries.at(-1).level, 'warn');
  assert.equal(logger.entries.at(-1).message, 'agent_task_boot_recovery_failed');
});
