'use strict';

/**
 * Idempotent /agentes cancel: reconnect mid-run must not fire Stop twice.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
