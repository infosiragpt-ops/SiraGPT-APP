'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-fail-alert-'));

const taskStore = require('../src/services/agents/task-store');
const alertingPath = require.resolve('../src/services/alerting');

// Inject a recording double BEFORE loading the route so failTaskTerminal's
// lazy require picks it up.
const alerts = [];
require.cache[alertingPath] = {
  id: alertingPath,
  filename: alertingPath,
  loaded: true,
  exports: {
    sendAlert: async (payload) => {
      alerts.push(payload);
      return { ok: true };
    },
  },
};

const agentTaskRoute = require('../src/routes/agent-task');

const originalEnv = {
  AGENT_TASK_FAILURE_ALERTS_DISABLED: process.env.AGENT_TASK_FAILURE_ALERTS_DISABLED,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  alerts.length = 0;
  taskStore._resetForTests?.();
});

test('failTaskTerminal emits a team alert when a non-terminal task fails', () => {
  const now = new Date().toISOString();
  taskStore.writeTaskSnapshot({
    taskId: 'task-alert-me',
    userId: 'user-1',
    status: 'running',
    displayGoal: 'generar documento',
    model: 'gpt-4o',
    traceId: 'trace-abc123',
    queueName: 'siragpt-agent-tasks',
    jobId: 'job-1',
    createdAt: now,
    updatedAt: now,
  });

  const result = agentTaskRoute.INTERNAL.failTaskTerminal('task-alert-me', 'user-1', 'provider 500 tras reintentos');
  assert.equal(result, true);

  // The terminal state is still written exactly as before.
  const snapshot = taskStore.getTaskSnapshotForUser('task-alert-me', 'user-1');
  assert.equal(snapshot.status, 'error');
  assert.equal(snapshot.streamState.done, true);

  // New behavior: the team channel sees the permanent failure.
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /^agent_task_permanent_failure:task-alert-/);
  assert.equal(alerts[0].severity, 'warn');
  assert.equal(alerts[0].context.taskId, 'task-alert-me');
  assert.equal(alerts[0].context.model, 'gpt-4o');
});

test('failTaskTerminal stays silent on already-terminal tasks and unknown ids', () => {
  const now = new Date().toISOString();
  taskStore.writeTaskSnapshot({
    taskId: 'task-already-done',
    userId: 'user-2',
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  });

  assert.equal(agentTaskRoute.INTERNAL.failTaskTerminal('task-already-done', 'user-2', 'late error'), false);
  assert.equal(agentTaskRoute.INTERNAL.failTaskTerminal('task-unknown-id', 'user-2', 'boom'), false);
  assert.equal(agentTaskRoute.INTERNAL.failTaskTerminal('', 'user-2', 'boom'), false);
  assert.equal(alerts.length, 0);
});

test('AGENT_TASK_FAILURE_ALERTS_DISABLED=1 suppresses the alert but keeps the terminal write', () => {
  process.env.AGENT_TASK_FAILURE_ALERTS_DISABLED = '1';
  const now = new Date().toISOString();
  taskStore.writeTaskSnapshot({
    taskId: 'task-muted',
    userId: 'user-3',
    status: 'running',
    createdAt: now,
    updatedAt: now,
  });

  const result = agentTaskRoute.INTERNAL.failTaskTerminal('task-muted', 'user-3', 'fallo silenciable');
  assert.equal(result, true);
  assert.equal(taskStore.getTaskSnapshotForUser('task-muted', 'user-3').status, 'error');
  assert.equal(alerts.length, 0);
});
