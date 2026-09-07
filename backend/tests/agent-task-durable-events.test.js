const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const taskStore = require('../src/services/agents/task-store');
const agentTaskRouter = require('../src/routes/agent-task');
const { INTERNAL } = agentTaskRouter;

test('agent task store assigns resumable event sequence ids', () => {
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-agent-seq-'));

  const base = taskStore.writeTaskSnapshot({
    taskId: 'task-seq',
    userId: 'user-a',
    displayGoal: 'Genera un informe largo',
    streamState: INTERNAL.initialAgentState(),
  });

  let state = INTERNAL.reduceAgentState(base.streamState, {
    type: 'queue_status',
    status: 'queued',
    queue: 'siragpt-agent-tasks',
    jobId: 'job-1',
  });
  taskStore.appendTaskEvent(base, {
    type: 'queue_status',
    status: 'queued',
    queue: 'siragpt-agent-tasks',
    jobId: 'job-1',
  }, state);

  state = INTERNAL.reduceAgentState(state, {
    type: 'checkpoint',
    label: 'Plan guardado',
    status: 'saved',
  });
  taskStore.appendTaskEvent({ ...base, streamState: state }, {
    type: 'checkpoint',
    label: 'Plan guardado',
    status: 'saved',
  }, state);

  const loaded = taskStore.getTaskSnapshotForUser('task-seq', 'user-a');
  assert.equal(loaded.events.length, 2);
  assert.equal(loaded.events[0].seq, 1);
  assert.equal(loaded.events[1].seq, 2);
  assert.equal(loaded.events[1].id, 'task-seq:2');
});

test('agent state reducer keeps queue, document policy, gates and repairs', () => {
  let state = INTERNAL.initialAgentState();
  state = INTERNAL.reduceAgentState(state, {
    type: 'queue_status',
    status: 'running',
    queue: 'siragpt-agent-tasks',
    jobId: 'job-2',
  });
  state = INTERNAL.reduceAgentState(state, {
    type: 'document_policy',
    policy: { mode: 'doc_required', format: 'docx', template: 'business' },
  });
  state = INTERNAL.reduceAgentState(state, {
    type: 'quality_gate',
    gate: 'artifact_validation',
    passed: true,
    score: 94,
    summary: 'Validado',
  });
  state = INTERNAL.reduceAgentState(state, {
    type: 'repair_attempt',
    attempt: 1,
    status: 'resolved',
    message: 'Regenerado',
  });

  assert.equal(state.queue.status, 'running');
  assert.equal(state.documentPolicy.format, 'docx');
  assert.equal(state.qualityGates.length, 1);
  assert.equal(state.qualityGates[0].passed, true);
  assert.equal(state.repairs[0].status, 'resolved');
});

const {
  resolveEventCursor,
  resolveTaskLastError,
  isFreshSnapshot,
  isInFlightTaskStatus,
  isTerminalTaskStatus,
  isTerminalLookupStatus,
  buildTaskEventsResumePayload,
  SNAPSHOT_FRESH_MS,
} = require('../src/services/agents/agent-task-event-resume');
const {
  WORKER_STALLED_REASON,
  WORKER_STALLED_MESSAGE,
} = require('../src/services/agents/agent-task-runtime-watchdog');

test('resume cursor prefers numeric after, then Last-Event-ID, then event id', () => {
  const events = [
    { id: 'task-seq:1', seq: 1, type: 'queue_status' },
    { id: 'task-seq:2', seq: 2, type: 'step_start' },
  ];

  assert.equal(resolveEventCursor('2', 'task-seq:1', events), 2);
  assert.equal(resolveEventCursor('', 'task-seq:2', events), 2);
  assert.equal(resolveEventCursor('', '7', events), 7);
  assert.equal(resolveEventCursor('', '', events), 0);
  assert.equal(resolveEventCursor('missing', '', events), 0);
});

test('lastError prefers the latest error event, then streamState, then worker_stalled', () => {
  assert.equal(resolveTaskLastError({
    events: [
      { type: 'step_start', seq: 1 },
      { type: 'error', message: 'primero', seq: 2 },
      { type: 'error', message: WORKER_STALLED_MESSAGE, seq: 3 },
    ],
  }), WORKER_STALLED_MESSAGE);

  assert.equal(resolveTaskLastError({
    events: [],
    streamState: { error: 'stream boom' },
  }), 'stream boom');

  assert.equal(resolveTaskLastError({
    events: [],
    failedReason: WORKER_STALLED_REASON,
  }), WORKER_STALLED_MESSAGE);

  assert.equal(resolveTaskLastError(null), null);
});

test('fresh snapshot + in-flight status keep resume alive after SSE drop', () => {
  assert.equal(isInFlightTaskStatus('running'), true);
  assert.equal(isInFlightTaskStatus('queued'), true);
  assert.equal(isTerminalTaskStatus('failed'), true);
  assert.equal(isTerminalLookupStatus(404), true);
  assert.equal(isTerminalLookupStatus(500), false);

  const now = Date.parse('2026-09-07T16:00:00.000Z');
  assert.equal(isFreshSnapshot(new Date(now - 10_000).toISOString(), { now }), true);
  assert.equal(isFreshSnapshot(new Date(now - SNAPSHOT_FRESH_MS - 1).toISOString(), { now }), false);
  assert.equal(isFreshSnapshot('not-a-date', { now }), false);
});

test('events resume payload slices after cursor and exposes lastError + updatedAt', () => {
  const task = {
    taskId: 'task-resume',
    status: 'error',
    updatedAt: '2026-09-07T16:00:00.000Z',
    lastEventSeq: 3,
    events: [
      { type: 'queue_status', seq: 1 },
      { type: 'step_start', seq: 2 },
      { type: 'error', message: WORKER_STALLED_MESSAGE, seq: 3 },
    ],
  };

  const resume = buildTaskEventsResumePayload(task, { after: 2 });
  assert.equal(resume.events.length, 1);
  assert.equal(resume.events[0].type, 'error');
  assert.equal(resume.lastEventSeq, 3);
  assert.equal(resume.updatedAt, '2026-09-07T16:00:00.000Z');
  assert.equal(resume.lastError, WORKER_STALLED_MESSAGE);
});

test('agent-task events route honors Last-Event-ID and lastError for /agentes resume', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/agent-task.js'), 'utf8');
  assert.match(src, /resolveEventCursor\(req\.query\.after, lastEventId, allEvents\)/);
  assert.match(src, /Last-Event-ID/);
  assert.match(src, /lastError: resume\.lastError/);
  assert.match(src, /updatedAt: resume\.updatedAt/);
});
