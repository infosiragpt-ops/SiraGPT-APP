'use strict';

/**
 * Runtime watchdog: live reaper for in-flight /agentes tasks whose worker
 * died without writing a terminal snapshot. Complements boot recovery
 * (which only runs on process restart).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const taskStore = require('../src/services/agents/task-store');
const {
  DEFAULT_WATCHDOG_STALE_MS,
  WORKER_STALLED_REASON,
  WORKER_STALLED_MESSAGE,
  sweepStaleAgentTasks,
  startAgentTaskRuntimeWatchdog,
  stopAgentTaskRuntimeWatchdog,
  isAgentTaskRuntimeWatchdogRunning,
} = require('../src/services/agents/agent-task-runtime-watchdog');

const originalEnv = {
  AGENT_TASK_STORE_DIR: process.env.AGENT_TASK_STORE_DIR,
  AGENT_TASK_RUNTIME_WATCHDOG_DISABLED: process.env.AGENT_TASK_RUNTIME_WATCHDOG_DISABLED,
  AGENT_TASK_RUNTIME_WATCHDOG_STALE_MS: process.env.AGENT_TASK_RUNTIME_WATCHDOG_STALE_MS,
  AGENT_TASK_RUNTIME_WATCHDOG_INTERVAL_MS: process.env.AGENT_TASK_RUNTIME_WATCHDOG_INTERVAL_MS,
  REDIS_URL: process.env.REDIS_URL,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  stopAgentTaskRuntimeWatchdog();
  restoreEnv();
});

function useTempStore(prefix = 'sgpt-runtime-watchdog-') {
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

test('runtime watchdog marks stale in-flight snapshots terminal so Pensando cannot hang', () => {
  useTempStore();
  const logger = captureLogger();

  taskStore.writeTaskSnapshot({ taskId: 'dead-worker', userId: 'u', status: 'running', jobId: 'bull-9', displayGoal: 'old' });
  taskStore.writeTaskSnapshot({ taskId: 'live-worker', userId: 'u', status: 'running', jobId: 'bull-10', displayGoal: 'fresh' });
  taskStore.writeTaskSnapshot({ taskId: 'already-done', userId: 'u', status: 'completed', displayGoal: 'done' });
  ageTask('dead-worker', 'u', 2 * DEFAULT_WATCHDOG_STALE_MS);

  const result = sweepStaleAgentTasks({ logger, env: process.env });

  assert.equal(result.count, 1);
  assert.equal(result.reason, WORKER_STALLED_REASON);
  assert.deepEqual(result.recovered.map((row) => row.taskId), ['dead-worker']);

  const recovered = taskStore.getTaskSnapshotForUser('dead-worker', 'u');
  assert.equal(recovered.status, 'error');
  assert.equal(recovered.streamState.done, true);
  assert.equal(recovered.streamState.error, WORKER_STALLED_REASON);
  assert.equal(recovered.events.at(-1).message, WORKER_STALLED_MESSAGE);

  assert.equal(taskStore.getTaskSnapshotForUser('live-worker', 'u').status, 'running');
  assert.equal(taskStore.getTaskSnapshotForUser('already-done', 'u').status, 'completed');
  assert.equal(logger.entries.at(-1).message, 'agent_task_runtime_watchdog_reaped');
  assert.deepEqual(logger.entries.at(-1).fields.taskIds, ['dead-worker']);
});

test('runtime watchdog is idempotent — a second sweep finds nothing', () => {
  useTempStore();
  taskStore.writeTaskSnapshot({ taskId: 'once', userId: 'u', status: 'queued', displayGoal: 'old' });
  ageTask('once', 'u', 2 * DEFAULT_WATCHDOG_STALE_MS);

  const first = sweepStaleAgentTasks({ env: process.env });
  const second = sweepStaleAgentTasks({ env: process.env });

  assert.equal(first.count, 1);
  assert.equal(second.count, 0);
  assert.equal(taskStore.getTaskSnapshotForUser('once', 'u').status, 'error');
});

test('a live heartbeat keeps the snapshot out of the stale window', () => {
  useTempStore();
  taskStore.writeTaskSnapshot({ taskId: 'pulsing', userId: 'u', status: 'running', displayGoal: 'live' });
  ageTask('pulsing', 'u', 2 * DEFAULT_WATCHDOG_STALE_MS);

  const touched = taskStore.touchTaskHeartbeat('pulsing', 'u');
  assert.ok(touched);
  const ageMs = Date.now() - Date.parse(touched.updatedAt);
  assert.ok(ageMs < 5_000, `heartbeat should be fresh, age=${ageMs}`);

  const result = sweepStaleAgentTasks({ env: process.env });
  assert.equal(result.count, 0);
  assert.equal(taskStore.getTaskSnapshotForUser('pulsing', 'u').status, 'running');
});

test('runtime watchdog can be disabled by environment flag', () => {
  useTempStore();
  process.env.AGENT_TASK_RUNTIME_WATCHDOG_DISABLED = 'true';
  taskStore.writeTaskSnapshot({ taskId: 'keep', userId: 'u', status: 'running', displayGoal: 'old' });
  ageTask('keep', 'u', 2 * DEFAULT_WATCHDOG_STALE_MS);

  const result = sweepStaleAgentTasks({ env: process.env });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'disabled');
  assert.equal(taskStore.getTaskSnapshotForUser('keep', 'u').status, 'running');
});

test('runtime watchdog honors a larger stale window', () => {
  useTempStore();
  process.env.AGENT_TASK_RUNTIME_WATCHDOG_STALE_MS = String(10 * DEFAULT_WATCHDOG_STALE_MS);
  taskStore.writeTaskSnapshot({ taskId: 'not-old', userId: 'u', status: 'running', displayGoal: 'fresh-ish' });
  ageTask('not-old', 'u', 2 * DEFAULT_WATCHDOG_STALE_MS);

  const result = sweepStaleAgentTasks({ env: process.env });
  assert.equal(result.count, 0);
  assert.equal(result.staleAfterMs, 10 * DEFAULT_WATCHDOG_STALE_MS);
  assert.equal(taskStore.getTaskSnapshotForUser('not-old', 'u').status, 'running');
});

test('runtime watchdog fails open when the store throws', () => {
  const logger = captureLogger();
  const result = sweepStaleAgentTasks({
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
  assert.equal(logger.entries.at(-1).message, 'agent_task_runtime_watchdog_failed');
});

test('start/stop installs one interval and is idempotent', () => {
  const logger = captureLogger();
  const calls = [];
  const fakeTimer = { unref() { this.unrefed = true; } };
  const setIntervalFn = (fn, ms) => {
    calls.push({ fn, ms });
    return fakeTimer;
  };

  const first = startAgentTaskRuntimeWatchdog({
    logger,
    env: { AGENT_TASK_RUNTIME_WATCHDOG_INTERVAL_MS: '15000' },
    setIntervalFn,
    taskStore: { recoverStaleRunningTasks() { return { recovered: [], count: 0 }; } },
  });
  const second = startAgentTaskRuntimeWatchdog({
    logger,
    env: { AGENT_TASK_RUNTIME_WATCHDOG_INTERVAL_MS: '15000' },
    setIntervalFn,
    taskStore: { recoverStaleRunningTasks() { return { recovered: [], count: 0 }; } },
  });

  assert.equal(first, fakeTimer);
  assert.equal(second, fakeTimer);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ms, 15_000);
  assert.equal(fakeTimer.unrefed, true);
  assert.equal(isAgentTaskRuntimeWatchdogRunning(), true);
  assert.equal(logger.entries.some((row) => row.message === 'agent_task_runtime_watchdog_started'), true);

  assert.equal(stopAgentTaskRuntimeWatchdog(), true);
  assert.equal(isAgentTaskRuntimeWatchdogRunning(), false);
  assert.equal(stopAgentTaskRuntimeWatchdog(), false);
});

test('start is a no-op when the watchdog is disabled', () => {
  const logger = captureLogger();
  let installed = 0;
  const handle = startAgentTaskRuntimeWatchdog({
    logger,
    env: { AGENT_TASK_RUNTIME_WATCHDOG_DISABLED: '1' },
    setIntervalFn: () => { installed += 1; return {}; },
  });
  assert.equal(handle, null);
  assert.equal(installed, 0);
  assert.equal(isAgentTaskRuntimeWatchdogRunning(), false);
  assert.equal(logger.entries.at(-1).message, 'agent_task_runtime_watchdog_skipped');
});

test('touchTaskHeartbeat no-ops on missing, foreign, or terminal snapshots', () => {
  useTempStore();
  taskStore.writeTaskSnapshot({ taskId: 'done', userId: 'u', status: 'completed', displayGoal: 'x' });
  const before = taskStore.getTaskSnapshotForUser('done', 'u').updatedAt;

  assert.equal(taskStore.touchTaskHeartbeat(null, 'u'), null);
  assert.equal(taskStore.touchTaskHeartbeat('done', 'other'), null);
  assert.equal(taskStore.touchTaskHeartbeat('missing', 'u'), null);

  const terminal = taskStore.touchTaskHeartbeat('done', 'u');
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.updatedAt, before);
});
