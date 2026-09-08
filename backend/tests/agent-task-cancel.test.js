'use strict';

/**
 * Idempotent /agentes cancel: reconnect mid-run must not fire Stop twice.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const {
  CANCEL_CODE,
  CANCEL_REASONS,
  decideTaskCancel,
  claimTaskCancel,
  hasCancelEvent,
  isCancelAck,
  buildCancelAck,
} = require('../src/services/agents/agent-task-cancel');

test('missing task is not a cancel ack', () => {
  const decision = decideTaskCancel(null);
  assert.equal(decision.apply, false);
  assert.equal(decision.already, false);
  assert.equal(decision.reason, CANCEL_REASONS.NOT_FOUND);
  assert.equal(isCancelAck(decision), false);
});

test('already-cancelled snapshot is a no-op success after reconnect', () => {
  const decision = decideTaskCancel({
    taskId: 't-1',
    status: 'cancelled',
    cancelledAt: '2026-09-07T22:00:00.000Z',
  });
  assert.equal(decision.apply, false);
  assert.equal(decision.already, true);
  assert.equal(decision.reason, CANCEL_REASONS.ALREADY_CANCELLED);
  assert.equal(decision.status, 'cancelled');
  assert.equal(decision.code, CANCEL_CODE);
  assert.equal(isCancelAck(decision), true);
});

test('cancelledAt without a status flip still counts as already cancelled', () => {
  const decision = decideTaskCancel({
    taskId: 't-2',
    status: 'running',
    cancelledAt: '2026-09-07T22:00:00.000Z',
  });
  assert.equal(decision.apply, false);
  assert.equal(decision.reason, CANCEL_REASONS.ALREADY_CANCELLED);
});

test('completed and failed snapshots are not rewritten as cancelled', () => {
  const done = decideTaskCancel({ taskId: 't-3', status: 'completed' });
  assert.equal(done.apply, false);
  assert.equal(done.reason, CANCEL_REASONS.ALREADY_TERMINAL);
  assert.equal(done.status, 'completed');
  assert.equal(isCancelAck(done), false);

  const failed = decideTaskCancel({ taskId: 't-4', status: 'error' });
  assert.equal(failed.reason, CANCEL_REASONS.ALREADY_TERMINAL);
  assert.equal(failed.status, 'error');
});

test('a prior E_CANCELLED event is enough to skip a reconnect retry', () => {
  const task = {
    taskId: 't-5',
    status: 'running',
    events: [
      { type: 'step_start', seq: 1 },
      { type: 'error', code: CANCEL_CODE, reason: 'aborted', message: 'Tarea detenida por el usuario.', seq: 2 },
    ],
  };
  assert.equal(hasCancelEvent(task), true);
  const decision = decideTaskCancel(task);
  assert.equal(decision.apply, false);
  assert.equal(decision.reason, CANCEL_REASONS.ALREADY_SIGNALLED);
});

test('an aborted controller alone does not skip — timeout is not Stop', () => {
  const controller = new AbortController();
  controller.abort();
  const decision = decideTaskCancel({
    taskId: 't-6',
    status: 'running',
    controller,
  });
  assert.equal(decision.apply, true);
  assert.equal(decision.reason, CANCEL_REASONS.APPLY);
});

test('first claim applies; second claim from a reconnect is already_requested', () => {
  const task = { taskId: 't-7', status: 'running' };
  const now = Date.parse('2026-09-07T22:10:00.000Z');

  const first = claimTaskCancel(task, { now });
  assert.equal(first.apply, true);
  assert.equal(first.already, false);
  assert.equal(task.cancelClaimed, true);
  assert.equal(task.cancelRequestedAt, '2026-09-07T22:10:00.000Z');

  const second = claimTaskCancel(task, { now: now + 250 });
  assert.equal(second.apply, false);
  assert.equal(second.already, true);
  assert.equal(second.reason, CANCEL_REASONS.ALREADY_REQUESTED);
  assert.equal(isCancelAck(second), true);
});

test('queued in-flight tasks can still take the first cancel', () => {
  const decision = decideTaskCancel({ taskId: 't-8', status: 'queued' });
  assert.equal(decision.apply, true);
  assert.equal(decision.status, 'cancelled');
});

test('cancel ack keeps the real status so a completed job is not reported cancelled', () => {
  const task = { taskId: 't-9', status: 'completed' };
  const decision = decideTaskCancel(task);
  const ack = buildCancelAck(task, decision);
  assert.deepEqual(ack, {
    ok: true,
    taskId: 't-9',
    status: 'completed',
    already: true,
    reason: CANCEL_REASONS.ALREADY_TERMINAL,
    code: CANCEL_CODE,
  });
});

test('persisted cancelRequestedAt survives a snapshot reload after SSE drop', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-cancel-latch-'));
  const prev = process.env.AGENT_TASK_STORE_DIR;
  process.env.AGENT_TASK_STORE_DIR = dir;
  try {
    const taskStore = require('../src/services/agents/task-store');
    const written = taskStore.writeTaskSnapshot({
      taskId: 't-persist',
      userId: 'user-a',
      status: 'running',
      displayGoal: 'Informe largo',
    });
    const first = claimTaskCancel(written, { now: Date.parse('2026-09-07T22:20:00.000Z') });
    assert.equal(first.apply, true);
    taskStore.updateTaskSnapshot(written.taskId, written.userId, {
      cancelRequestedAt: written.cancelRequestedAt,
    });
    const reloaded = taskStore.getTaskSnapshotForUser('t-persist', 'user-a');
    assert.equal(reloaded.cancelRequestedAt, '2026-09-07T22:20:00.000Z');
    const second = decideTaskCancel(reloaded);
    assert.equal(second.apply, false);
    assert.equal(second.reason, CANCEL_REASONS.ALREADY_REQUESTED);
  } finally {
    if (prev == null) delete process.env.AGENT_TASK_STORE_DIR;
    else process.env.AGENT_TASK_STORE_DIR = prev;
  }
});

test('cancel route and worker claim before abort so a reconnect cannot double-Stop', () => {
  const routeSrc = fs.readFileSync(path.join(__dirname, '../src/routes/agent-task.js'), 'utf8');
  const workerSrc = fs.readFileSync(path.join(__dirname, '../src/services/agents/agent-task-worker.js'), 'utf8');
  assert.match(routeSrc, /claimTaskCancel/);
  assert.match(routeSrc, /buildCancelAck/);
  assert.match(routeSrc, /persistCancelRequest/);
  assert.match(workerSrc, /claimTaskCancel/);
  assert.match(workerSrc, /isCancelAck/);
});

// Run the actual retry/cancel handlers against the real disk snapshot store.
// Queue, persistence mirrors and worker transport are isolated synthetic ports.
function retryFixture(t, { workerStartsBeforeAck = false, failRetryMirror = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-cancel-retry-'));
  const previousDir = process.env.AGENT_TASK_STORE_DIR;
  process.env.AGENT_TASK_STORE_DIR = dir;
  t.after(() => {
    if (previousDir == null) delete process.env.AGENT_TASK_STORE_DIR;
    else process.env.AGENT_TASK_STORE_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const taskStore = require('../src/services/agents/task-store');
  const active = new Map();
  const controller = new AbortController();
  controller.abort();
  const oldTask = taskStore.writeTaskSnapshot({
    taskId: 'retry-task', userId: 'owner-a', jobId: 'attempt-1',
    status: 'cancelled', cancelledAt: '2026-09-07T22:00:00.000Z',
    cancelRequestedAt: '2026-09-07T22:00:00.000Z',
    streamState: { done: true, error: 'Stopped', errorCode: CANCEL_CODE },
    events: [{ type: 'error', code: CANCEL_CODE, seq: 1 }], lastEventSeq: 1,
  });
  oldTask.controller = controller;
  oldTask.cancelClaimed = true;
  active.set(oldTask.taskId, oldTask);
  const handlers = new Map();
  const cancelledJobs = [];
  const mirroredTasks = [];
  let retryTask = null;
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/agent-task.js'), 'utf8');
  const context = {
    router: { post: (route, ...args) => handlers.set(route, args.at(-1)) },
    authenticateToken() {}, requireRedisUrl() {},
    crypto: require('node:crypto'), ACTIVE_AGENT_TASKS: active,
    getTaskForUser: (id, userId) => {
      const row = active.get(id);
      return row && row.userId === userId ? row : null;
    },
    taskStore: {
      ...taskStore,
      appendTaskEvent: (...args) => {
        const row = taskStore.appendTaskEvent(...args);
        if (workerStartsBeforeAck && !retryTask && args[1].type === 'repair_attempt') {
          retryTask = { ...row, status: 'running', controller: new AbortController() };
          active.set(retryTask.taskId, retryTask);
        }
        return row;
      },
    }, claimTaskCancel, buildCancelAck,
    persistCancelRequest: (row) => taskStore.updateTaskSnapshot(row.taskId, row.userId, { cancelRequestedAt: row.cancelRequestedAt }),
    resolveUserSkillClearance: () => 'authenticated',
    enqueueAgentTask: async () => ({ id: 'attempt-2' }),
    getQueueName: () => 'synthetic-queue',
    agentTaskPersistence: {
      appendAgentTaskEvent: async (row, event) => {
        if (failRetryMirror && event.type === 'repair_attempt') throw new Error('synthetic mirror failure');
      },
      upsertAgentTask: async (row) => { mirroredTasks.push(row); },
    },
    cancelQueuedTask: async (id) => { cancelledJobs.push(id); return { cancelled: true }; },
    cancelRunningTask: async () => ({ cancelled: false, reason: 'not_found' }),
    initialAgentState: () => ({}),
    reduceAgentState: (state) => ({ ...state }),
    TASK_EVENT_LIMIT: 1000,
    appendTaskEvent: (row, event, state) => {
      row.events.push(event);
      taskStore.appendTaskEvent(row, event, state);
    },
    durableExecutionStore: {}, metrics: { counter() {} }, console,
  };
  for (const route of ['cancel', 'retry']) {
    const start = src.indexOf(`router.post('/task/:taskId/${route}',`);
    const end = src.indexOf('\n// ───', start);
    assert.ok(start >= 0 && end > start);
    vm.runInNewContext(src.slice(start, end), context);
  }
  return {
    active, oldTask, cancelledJobs, mirroredTasks, taskStore,
    get retryTask() { return retryTask; },
    async request(route) {
      let body;
      const res = { status() { return res; }, json(value) { body = value; return res; } };
      await handlers.get(`/task/:taskId/${route}`)({ params: { taskId: oldTask.taskId }, user: { id: oldTask.userId } }, res);
      return body;
    },
  };
}

test('Cancel → Retry → Cancel removes the new queued job once and retains history', async (t) => {
  const f = retryFixture(t);
  const retry = await f.request('retry');
  assert.equal(retry.status, 'queued');
  assert.equal(f.active.has(f.oldTask.taskId), false);
  const queued = f.taskStore.getTaskSnapshotForUser(f.oldTask.taskId, f.oldTask.userId);
  assert.equal(queued.cancelledAt, null);
  assert.equal(queued.cancelRequestedAt, null);
  assert.equal(f.mirroredTasks[0].cancelledAt, null);
  assert.equal(f.mirroredTasks[0].cancelRequestedAt, null);
  assert.equal(queued.events.filter((event) => event.code === CANCEL_CODE).length, 1);
  assert.equal(decideTaskCancel(queued).apply, true);

  const first = await f.request('cancel');
  const second = await f.request('cancel');
  assert.equal(first.status, 'cancelled');
  assert.equal(first.already, false);
  assert.equal(second.already, true);
  assert.deepEqual(f.cancelledJobs, ['attempt-2']);
  const stopped = f.taskStore.getTaskSnapshotForUser(f.oldTask.taskId, f.oldTask.userId);
  assert.equal(stopped.events.filter((event) => event.code === CANCEL_CODE).length, 2);
});

test('Retry preserves a new active worker and Stop aborts that attempt once', async (t) => {
  const f = retryFixture(t, { workerStartsBeforeAck: true });
  await f.request('retry');
  assert.equal(f.active.get(f.oldTask.taskId), f.retryTask);
  assert.equal(f.retryTask.controller.signal.aborted, false);
  const first = await f.request('cancel');
  const second = await f.request('cancel');
  assert.equal(first.already, false);
  assert.equal(second.already, true);
  assert.equal(f.retryTask.controller.signal.aborted, true);
  assert.equal(f.retryTask.events.filter((event) => event.code === CANCEL_CODE).length, 2);
});

test('a Stop event after the retry boundary still deduplicates the same attempt', () => {
  const events = [
    { type: 'error', code: CANCEL_CODE, seq: 1 },
    { type: 'repair_attempt', status: 'queued', seq: 2 },
    { type: 'queue_status', status: 'queued', seq: 3 },
  ];
  assert.equal(hasCancelEvent({ events }), false);
  events.push({ type: 'error', code: CANCEL_CODE, seq: 4 });
  assert.equal(hasCancelEvent({ events }), true);
  assert.equal(decideTaskCancel({ status: 'running', events }).apply, false);
});

test('an accepted queued retry remains stoppable when its persistence mirror fails', async (t) => {
  const f = retryFixture(t, { failRetryMirror: true });
  const response = await f.request('retry');
  assert.equal(response.error, 'synthetic mirror failure');
  assert.equal(f.active.has(f.oldTask.taskId), false);
  const cancelled = await f.request('cancel');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.already, false);
  assert.deepEqual(f.cancelledJobs, ['attempt-2']);
});
