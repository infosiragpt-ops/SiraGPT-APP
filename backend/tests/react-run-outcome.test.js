'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function isolatedStore(t) {
  const previous = {
    AGENT_TASK_STORE_DIR: process.env.AGENT_TASK_STORE_DIR,
    AGENT_TASK_PRISMA_SYNC: process.env.AGENT_TASK_PRISMA_SYNC,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-outcome-'));
  process.env.AGENT_TASK_STORE_DIR = dir;
  process.env.AGENT_TASK_PRISMA_SYNC = '0';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = require('../src/services/agents/task-store');
  const metrics = require('../src/services/agents/metrics');
  metrics._reset();
  return { store, metrics };
}

const failures = [
  'verification_failed', 'verification_failed:missing_evidence',
  'invalid_resume_checkpoint', 'resume_budget_exhausted',
  'finalized_guard_breaker:3/5', 'finalized_guard_breaker:plain_text:3/5',
  'finalized_last_step_guard_override', 'model_error: provider unavailable',
  'invalid_tool_calls', 'runtime_budget_exhausted', 'degraded_no_finalize:web',
  'control_plane_error:unavailable', 'run_failed', 'cost_budget_exhausted',
  'no_message', 'tool_unavailable:docintel_retrieve',
  'source_preserving_document_edit_failed', 'agent_runner_failed',
];

for (const reason of failures) {
  test(`outcome classifies ${reason} as failed`, () => {
    const { isFailedAgentStopReason, statusForAgentStopReason } = require('../src/services/agents/react-run-outcome');
    assert.equal(isFailedAgentStopReason(reason), true);
    assert.equal(statusForAgentStopReason(reason), 'failed');
  });
}

test('outcome preserves explicit cancellation and established successful reasons', () => {
  const { isFailedAgentStopReason, statusForAgentStopReason } = require('../src/services/agents/react-run-outcome');
  for (const reason of ['aborted', 'cancelled_by_user']) {
    assert.equal(statusForAgentStopReason(reason), 'cancelled');
    assert.equal(isFailedAgentStopReason(reason), false);
  }
  for (const reason of [undefined, null, '', 'finalized', 'completed', 'plain_text_finalize', 'attachment_inline_recovery']) {
    assert.equal(statusForAgentStopReason(reason), 'completed');
    assert.equal(isFailedAgentStopReason(reason), false);
  }
  assert.equal(isFailedAgentStopReason('verification_failedness'), false);
});

test('outcome recovery never bypasses verification, resume, cancellation or budget boundaries', () => {
  const { canRecoverAgentStopReason } = require('../src/services/agents/react-run-outcome');
  for (const reason of [...failures.filter((reason) => !/^(model_error|tool_unavailable):/.test(reason)), 'aborted', 'cancelled_by_user']) {
    assert.equal(canRecoverAgentStopReason(reason), false, reason);
  }
  for (const reason of ['model_error:temporarily unavailable', 'tool_unavailable:docintel_retrieve', 'finalized']) {
    assert.equal(canRecoverAgentStopReason(reason), true, reason);
  }
});

test('store: failed done is persisted before later status write, with no success metric or lost checkpoint', (t) => {
  const { store, metrics } = isolatedStore(t);
  const task = store.writeTaskSnapshot({ taskId: 'guard-failed', userId: 'owner', status: 'running', runnerCheckpoint: { stepsCompleted: 3 } });
  const state = { done: true, stoppedReason: 'verification_failed:missing_evidence', steps: [] };
  const first = store.appendTaskEvent(task, { type: 'done', stoppedReason: state.stoppedReason }, state);
  assert.equal(first.status, 'failed');
  assert.equal(first.terminalMetricStatus, 'error');
  assert.ok(first.failedAt);
  assert.equal(first.completedAt, null);
  assert.equal(store.readTaskSnapshot(task.taskId).status, 'failed');

  // The producer can still hold the pre-event snapshot while persisting a
  // final message/checkpoint. It must not relabel this same failed attempt.
  store.appendTaskEvent(task, { type: 'checkpoint', label: 'Mensaje persistido' }, state);
  const final = store.markTaskStatus(task, 'completed', { streamState: state });
  assert.equal(final.status, 'failed');
  assert.deepEqual(final.runnerCheckpoint, { stepsCompleted: 3 });
  assert.equal(final.completedAt, null);
  assert.equal(metrics.registry.get('agent_task_terminal_total').series.get('status=error'), 1);
  assert.equal(metrics.registry.get('agent_task_terminal_total').series.get('status=success'), undefined);
});

test('store: cancelling done is cancelled at its first durable observation', (t) => {
  const { store } = isolatedStore(t);
  const task = store.writeTaskSnapshot({ taskId: 'cancelled', userId: 'owner', status: 'running' });
  const first = store.appendTaskEvent(task, { type: 'done', stoppedReason: 'cancelled_by_user' }, { done: true, stoppedReason: 'cancelled_by_user' });
  assert.equal(first.status, 'cancelled');
  assert.ok(first.cancelledAt);
  assert.equal(first.terminalMetricStatus, 'cancelled');
});

test('store: every late progress event preserves failed terminal state, not just checkpoints', (t) => {
  const { store } = isolatedStore(t);
  const task = store.writeTaskSnapshot({ taskId: 'late-progress', userId: 'owner', status: 'running' });
  const state = { done: true, stoppedReason: 'verification_failed' };
  store.appendTaskEvent(task, { type: 'done', stoppedReason: state.stoppedReason }, state);
  for (const type of ['step_start', 'step_done', 'final_text', 'heartbeat', 'checkpoint']) {
    const result = store.appendTaskEvent(task, { type }, { done: false });
    assert.equal(result.status, 'failed', type);
    assert.deepEqual(result.streamState, state, type);
  }
});

test('store: stale success after user cancellation cannot change the outcome or its reason', (t) => {
  const { store } = isolatedStore(t);
  const task = store.writeTaskSnapshot({ taskId: 'late-success', userId: 'owner', status: 'running' });
  const state = { done: true, stoppedReason: 'aborted' };
  store.markTaskStatus(task, 'cancelled', { streamState: state });
  const late = store.appendTaskEvent(task, { type: 'done', stoppedReason: 'finalized' }, { done: true, stoppedReason: 'finalized' });
  assert.equal(late.status, 'cancelled');
  assert.deepEqual(late.streamState, state);
  const marked = store.markTaskStatus(task, 'completed', { streamState: { done: true, stoppedReason: 'finalized' } });
  assert.equal(marked.status, 'cancelled');
  assert.deepEqual(marked.streamState, state);
});

test('store: explicit queued retry with a new job id resets the old done state', (t) => {
  const { store } = isolatedStore(t);
  const task = store.writeTaskSnapshot({ taskId: 'job-retry', jobId: 'job-first', userId: 'owner', status: 'running' });
  const state = { done: true, stoppedReason: 'verification_failed' };
  store.appendTaskEvent(task, { type: 'done', stoppedReason: state.stoppedReason }, state);
  const retried = store.appendTaskEvent({ ...task, status: 'queued', jobId: 'job-retry' }, { type: 'repair_attempt', status: 'queued' }, state);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.jobId, 'job-retry');
  assert.equal(retried.streamState.done, false);
  assert.equal(retried.streamState.stoppedReason, undefined);
});

test('store: explicit retry may finish successfully after an earlier verification failure', (t) => {
  const { store } = isolatedStore(t);
  const task = store.writeTaskSnapshot({ taskId: 'retry', userId: 'owner', status: 'running' });
  store.appendTaskEvent(task, { type: 'done', stoppedReason: 'verification_failed' }, { done: true, stoppedReason: 'verification_failed' });
  const retried = store.markTaskStatus(task, 'running', { streamState: { done: false, steps: [] } });
  const state = { done: true, stoppedReason: 'finalized', steps: [] };
  store.appendTaskEvent(retried, { type: 'done', stoppedReason: 'finalized' }, state);
  assert.equal(store.markTaskStatus(retried, 'completed', { streamState: state }).status, 'completed');
});

test('route: a persisted failed task closes SSE immediately and cannot be overwritten by worker error cleanup', (t) => {
  const { store } = isolatedStore(t);
  const { EventEmitter } = require('node:events');
  const { INTERNAL } = require('../src/routes/agent-task');
  const task = store.writeTaskSnapshot({
    taskId: 'failed-sse', userId: 'owner', status: 'failed',
    streamState: { done: true, stoppedReason: 'verification_failed' },
    events: [{ type: 'done', stoppedReason: 'verification_failed', seq: 1 }],
  });
  const req = new EventEmitter();
  req.headers = {};
  req.query = {};
  const res = new EventEmitter();
  const chunks = [];
  res.setHeader = () => {};
  res.setTimeout = () => {};
  res.write = (text) => { chunks.push(text); return true; };
  res.end = () => { res.writableEnded = true; };
  t.after(() => res.emit('close'));
  INTERNAL.streamTaskEvents(req, res, task.taskId, task.userId);
  assert.equal(res.writableEnded, true);
  assert.ok(chunks.some((text) => text.includes('verification_failed')));
  assert.equal(INTERNAL.failTaskTerminal(task.taskId, task.userId, 'late worker cleanup'), false);
  assert.equal(store.readTaskSnapshot(task.taskId).status, 'failed');
});

test('route: terminal replay excludes every late success, text, artifact and progress event', (t) => {
  const { store } = isolatedStore(t);
  const { EventEmitter } = require('node:events');
  const { INTERNAL } = require('../src/routes/agent-task');
  const task = store.writeTaskSnapshot({ taskId: 'terminal-replay', userId: 'owner', status: 'running' });
  const state = { done: true, stoppedReason: 'verification_failed', finalText: 'No se pudo verificar.' };
  const finished = store.appendTaskEvent(task, { type: 'done', stoppedReason: state.stoppedReason }, state);
  const persistedBefore = fs.readFileSync(store.snapshotPathFor(task.taskId), 'utf8');
  const sync = t.mock.method(require('../src/services/agents/task-store-prisma-sync'), 'schedulePrismaSync', () => {});
  const lateEvents = [
    { type: 'done', stoppedReason: 'finalized' },
    { type: 'final_text', markdown: 'LATE_SUCCESS_TEXT' },
    { type: 'file_artifact', artifact: { id: 'LATE_ARTIFACT', filename: 'late.docx' } },
    { type: 'step_start', label: 'LATE_PROGRESS' },
    { type: 'checkpoint', label: 'LATE_CHECKPOINT' },
  ];
  for (const event of lateEvents) {
    const result = store.appendTaskEvent(task, event, { done: true, stoppedReason: 'finalized', finalText: 'LATE_SUCCESS_TEXT' });
    assert.deepEqual(result, finished, event.type);
  }
  assert.equal(fs.readFileSync(store.snapshotPathFor(task.taskId), 'utf8'), persistedBefore);
  assert.equal(sync.mock.callCount(), 0, 'a dropped event must not enqueue a database dual-write');

  const req = new EventEmitter();
  req.headers = {};
  req.query = {};
  const res = new EventEmitter();
  const chunks = [];
  res.setHeader = () => {};
  res.setTimeout = () => {};
  res.write = (text) => { chunks.push(text); return true; };
  res.end = () => { res.writableEnded = true; };
  t.after(() => res.emit('close'));
  INTERNAL.streamTaskEvents(req, res, task.taskId, task.userId);
  assert.equal(res.writableEnded, true);
  // SSE frames may start with `id:` (eventSeq resume cursor) before `data:`.
  const frames = chunks
    .flatMap((text) => String(text).split('\n\n'))
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'done');
  assert.equal(frames[0].stoppedReason, 'verification_failed');
  assert.doesNotMatch(chunks.join(''), /LATE_|finalized/);
});
