const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const taskStore = require('../src/services/agents/task-store');

test('agent task store: writes and reads a durable task snapshot', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-task-store-'));

  const snapshot = taskStore.writeTaskSnapshot({
    taskId: 'task-1',
    userId: 'user-a',
    chatId: 'chat-a',
    displayGoal: 'Investiga y genera Excel',
    model: 'gpt-4o',
    status: 'running',
    streamState: { steps: [], artifacts: [], finalText: '', done: false },
  });

  assert.equal(snapshot.taskId, 'task-1');
  assert.equal(fs.existsSync(taskStore.snapshotPathFor('task-1')), true);

  const loaded = taskStore.getTaskSnapshotForUser('task-1', 'user-a');
  assert.equal(loaded.displayGoal, 'Investiga y genera Excel');
  assert.equal(loaded.status, 'running');
});

test('agent task store: scopes snapshots by user', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-task-store-'));

  taskStore.writeTaskSnapshot({
    taskId: 'task-owned',
    userId: 'user-a',
    displayGoal: 'Privado',
  });

  assert.equal(taskStore.getTaskSnapshotForUser('task-owned', 'user-b'), null);
  assert.equal(taskStore.getTaskSnapshotForUser('task-owned', 'user-a').taskId, 'task-owned');
});

test('agent task store: appends events and creates checkpoints for important transitions', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-task-store-'));

  const base = taskStore.writeTaskSnapshot({
    taskId: 'task-events',
    userId: 'user-a',
    displayGoal: 'Genera documento',
    streamState: { steps: [], artifacts: [], finalText: '', done: false },
  });

  taskStore.appendTaskEvent(base, {
    type: 'step_start',
    id: 's1',
    label: 'Planificando',
  }, {
    steps: [{ id: 's1', label: 'Planificando', status: 'running', toolCalls: [] }],
    artifacts: [],
    finalText: '',
    done: false,
  });

  const loaded = taskStore.getTaskSnapshotForUser('task-events', 'user-a');
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.checkpoints.length, 1);
  assert.equal(loaded.checkpoints[0].type, 'step_start');
  assert.equal(loaded.streamState.steps.length, 1);
});

test('agent task store: marks terminal status with timestamps and stats', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-task-store-'));

  const base = taskStore.writeTaskSnapshot({
    taskId: 'task-done',
    userId: 'user-a',
    displayGoal: 'Finaliza',
  });
  const done = taskStore.markTaskStatus(base, 'completed', {
    stats: { steps: 4, artifacts: 1, durationMs: 1234 },
  });

  assert.equal(done.status, 'completed');
  assert.equal(done.stats.artifacts, 1);
  assert.ok(done.completedAt);
});

test('agent task store: trims event history to the configured limit', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-task-store-'));

  const base = taskStore.writeTaskSnapshot({
    taskId: 'task-trim',
    userId: 'user-a',
    displayGoal: 'Muchos eventos',
  });

  let current = base;
  for (let i = 0; i < 8; i++) {
    current = taskStore.appendTaskEvent(current, { type: 'tool_output', tool: 'x', ok: true, preview: String(i) }, current.streamState, { eventLimit: 3 });
  }

  const loaded = taskStore.getTaskSnapshotForUser('task-trim', 'user-a');
  assert.equal(loaded.events.length, 3);
  assert.equal(loaded.events[0].preview, '5');
  assert.equal(loaded.events[2].preview, '7');
});
