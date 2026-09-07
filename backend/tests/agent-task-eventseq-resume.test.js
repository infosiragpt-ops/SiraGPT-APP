'use strict';

/**
 * Durable eventSeq resume cursors for /agentes SSE reconnect.
 * Exclusive skip of already-acked events so tool side effects never
 * double-apply. Spanish labels for gap / stale cursors.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  RESUME_LABELS,
  resolveResumeCursor,
  classifyResumeCursor,
  selectResumeEvents,
  hasAckedTerminal,
  skippedAckedEvents,
  isToolSideEffectEvent,
  isTerminalResumeEvent,
  sortEventsBySeq,
  eventSeq,
  beginSseResume,
  formatSseEventFrame,
  buildTaskEventsResumePayload,
} = require('../src/services/agents/agent-task-event-resume');

function replaySse(opts) {
  const started = beginSseResume(opts);
  const writes = [];
  if (started.advisory) writes.push(formatSseEventFrame(started.advisory));
  let lastSeq = started.lastSeq;
  for (const event of started.pending) {
    const seq = eventSeq(event);
    if (seq <= lastSeq) continue;
    lastSeq = seq;
    writes.push(formatSseEventFrame(event));
  }
  return { started, writes, joined: writes.join(''), lastSeq };
}

function sideEffectLog() {
  return [
    { id: 't:1', seq: 1, type: 'queue_status', status: 'running' },
    { id: 't:2', seq: 2, type: 'tool_call', tool: 'web_search', stepId: 's1' },
    { id: 't:3', seq: 3, type: 'tool_output', tool: 'web_search', stepId: 's1', ok: true },
    { id: 't:4', seq: 4, type: 'file_artifact', artifact: { id: 'a1', filename: 'informe.docx' } },
    { id: 't:5', seq: 5, type: 'step_done', ok: true },
    { id: 't:6', seq: 6, type: 'done', stoppedReason: 'completed' },
  ];
}

function runningTask(events, extra = {}) {
  return {
    taskId: extra.taskId || 'task-seq',
    status: extra.status || 'running',
    lastEventSeq: extra.lastEventSeq != null
      ? extra.lastEventSeq
      : Math.max(0, ...events.map((evt) => Number(evt.seq) || 0)),
    updatedAt: extra.updatedAt || '2026-09-07T16:00:00.000Z',
    lastEventAt: extra.lastEventAt || '2026-09-07T16:00:00.000Z',
    events,
    streamState: extra.streamState || { steps: [], artifacts: [], done: false },
    ...extra,
  };
}

test('resolveResumeCursor prefers sinceSeq over after and Last-Event-ID', () => {
  const events = sideEffectLog();
  assert.equal(resolveResumeCursor({ sinceSeq: '4', after: '1', lastEventId: '2', events }), 4);
  assert.equal(resolveResumeCursor({ after: '3', lastEventId: '1', events }), 3);
  assert.equal(resolveResumeCursor({ lastEventId: 't:5', events }), 5);
  assert.equal(resolveResumeCursor({ lastEventId: '7', events }), 7);
  assert.equal(resolveResumeCursor({}), 0);
});

test('sinceSeq of 0 is a valid exclusive cursor, not an empty fallback', () => {
  assert.equal(resolveResumeCursor({ sinceSeq: 0, after: '9' }), 0);
  assert.equal(resolveResumeCursor({ sinceSeq: '0', lastEventId: '4' }), 0);
});

test('invalid sinceSeq falls back to 0 and does not invent a replay window', () => {
  assert.equal(resolveResumeCursor({ sinceSeq: 'nope', after: '3' }), 0);
  assert.equal(resolveResumeCursor({ sinceSeq: 'task:missing', events: sideEffectLog() }), 0);
});

test('negative cursors clamp to 0', () => {
  assert.equal(resolveResumeCursor({ sinceSeq: '-4' }), 0);
  assert.equal(resolveResumeCursor({ after: '-1', lastEventId: '-9' }), 0);
});

test('out-of-order event arrays sort by seq before exclusive skip', () => {
  const shuffled = [
    { seq: 3, type: 'tool_output', tool: 'web_search' },
    { seq: 1, type: 'tool_call', tool: 'web_search' },
    { seq: 2, type: 'step_start' },
  ];
  const ordered = sortEventsBySeq(shuffled);
  assert.deepEqual(ordered.map(eventSeq), [1, 2, 3]);
  const pending = selectResumeEvents(shuffled, 1);
  assert.deepEqual(pending.map((evt) => evt.type), ['step_start', 'tool_output']);
});

test('already-acked tool side effects are skipped on reconnect', () => {
  const pending = selectResumeEvents(sideEffectLog(), 4);
  assert.equal(pending.some(isToolSideEffectEvent), false);
  assert.deepEqual(pending.map((evt) => evt.type), ['step_done', 'done']);
  const acked = skippedAckedEvents(sideEffectLog(), 4);
  assert.equal(acked.filter(isToolSideEffectEvent).length, 3);
});

test('cursor equal to last tool_output never re-emits that output', () => {
  const pending = selectResumeEvents(sideEffectLog(), 3);
  assert.equal(pending.some((evt) => evt.type === 'tool_output'), false);
  assert.equal(pending[0].type, 'file_artifact');
});

test('gap cursor reports Spanish label and still resumes from first retained seq', () => {
  const retained = [
    { seq: 8, type: 'tool_call', tool: 'create_document' },
    { seq: 9, type: 'tool_output', tool: 'create_document', ok: true },
    { seq: 10, type: 'done' },
  ];
  const classified = classifyResumeCursor({ cursor: 3, events: retained, lastEventSeq: 10 });
  assert.equal(classified.resumeStatus, 'gap');
  assert.equal(classified.resumeLabel, RESUME_LABELS.gap);
  assert.match(classified.resumeLabel, /hueco/);
  assert.equal(classified.gapFrom, 4);
  assert.equal(classified.gapTo, 7);
  assert.equal(classified.firstRetainedSeq, 8);

  const payload = buildTaskEventsResumePayload(runningTask(retained, { lastEventSeq: 10 }), { sinceSeq: 3 });
  assert.equal(payload.resumeStatus, 'gap');
  assert.equal(payload.resumeLabel, RESUME_LABELS.gap);
  assert.deepEqual(payload.events.map((evt) => evt.seq), [8, 9, 10]);
  assert.equal(payload.events.filter(isToolSideEffectEvent).every((evt) => evt.seq > 3), true);
});

test('contiguous retained events after cursor are not a gap', () => {
  const classified = classifyResumeCursor({
    cursor: 2,
    events: sideEffectLog(),
    lastEventSeq: 6,
  });
  assert.equal(classified.resumeStatus, 'ok');
  assert.equal(classified.resumeLabel, null);
});

test('stale cursor ahead of lastEventSeq emits nothing and Spanish stale label', () => {
  const events = sideEffectLog();
  const classified = classifyResumeCursor({ cursor: 40, events, lastEventSeq: 6 });
  assert.equal(classified.resumeStatus, 'stale');
  assert.equal(classified.resumeLabel, RESUME_LABELS.stale);
  assert.match(classified.resumeLabel, /desactualizado/);

  const payload = buildTaskEventsResumePayload(runningTask(events), { sinceSeq: 40 });
  assert.equal(payload.resumeStatus, 'stale');
  assert.equal(payload.events.length, 0);
  assert.equal(payload.ackedTerminal, true);
});

test('stale cursor on an empty log is stale, not a gap', () => {
  const classified = classifyResumeCursor({ cursor: 4, events: [], lastEventSeq: 0 });
  assert.equal(classified.resumeStatus, 'stale');
  assert.equal(classified.resumeLabel, RESUME_LABELS.stale);
});

test('reconnect mid-stream resumes only events after the acked seq', () => {
  const payload = buildTaskEventsResumePayload(runningTask(sideEffectLog()), {
    sinceSeq: 2,
    lastEventId: 't:1',
  });
  assert.equal(payload.sinceSeq, 2);
  assert.deepEqual(payload.events.map((evt) => evt.seq), [3, 4, 5, 6]);
  assert.equal(payload.events.some((evt) => evt.seq <= 2), false);
  assert.equal(payload.skippedSideEffects, 1);
});

test('Last-Event-ID reconnect uses the event id when sinceSeq is absent', () => {
  const payload = buildTaskEventsResumePayload(runningTask(sideEffectLog()), {
    lastEventId: 't:4',
  });
  assert.equal(payload.sinceSeq, 4);
  assert.deepEqual(payload.events.map((evt) => evt.type), ['step_done', 'done']);
});

test('no double terminal — only the last honest terminal after the cursor is replayed', () => {
  const events = [
    { seq: 1, type: 'tool_call', tool: 'web_search' },
    { seq: 2, type: 'error', message: 'fallo temporal' },
    { seq: 3, type: 'done', stoppedReason: 'completed' },
  ];
  const pending = selectResumeEvents(events, 0);
  assert.equal(pending.filter(isTerminalResumeEvent).length, 1);
  assert.equal(pending.at(-1).type, 'done');
  assert.equal(pending.some((evt) => evt.type === 'error'), false);
});

test('already-acked terminal is not replayed a second time', () => {
  const events = [
    { seq: 1, type: 'step_done' },
    { seq: 2, type: 'done', stoppedReason: 'completed' },
  ];
  assert.equal(hasAckedTerminal(events, 2), true);
  assert.deepEqual(selectResumeEvents(events, 2), []);
  const payload = buildTaskEventsResumePayload(runningTask(events, {
    status: 'completed',
    streamState: { done: true },
  }), { sinceSeq: 2 });
  assert.equal(payload.events.length, 0);
  assert.equal(payload.ackedTerminal, true);
  assert.equal(payload.alive, false);
});

test('cancel after resume delivers the cancel event once and never a second terminal', () => {
  process.env.AGENT_TASK_PRISMA_SYNC = '0';
  process.env.AGENT_TASK_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sgpt-eventseq-cancel-'));
  const taskStore = require('../src/services/agents/task-store');

  const base = taskStore.writeTaskSnapshot({
    taskId: 'task-cancel-resume',
    userId: 'user-a',
    status: 'running',
    displayGoal: 'Busca fuentes',
    events: [
      { type: 'queue_status', seq: 1 },
      { type: 'tool_call', seq: 2, tool: 'web_search' },
      { type: 'tool_output', seq: 3, tool: 'web_search', ok: true },
    ],
    lastEventSeq: 3,
    streamState: { steps: [], artifacts: [], done: false },
  });

  const mid = buildTaskEventsResumePayload(base, { sinceSeq: 3 });
  assert.equal(mid.events.length, 0);
  assert.equal(mid.skippedSideEffects, 2);

  const cancelEvent = {
    type: 'error',
    code: 'E_CANCELLED',
    reason: 'aborted',
    message: 'Tarea cancelada por el usuario.',
  };
  const cancelled = taskStore.appendTaskEvent(base, cancelEvent, {
    ...base.streamState,
    done: true,
    error: cancelEvent.message,
    errorCode: 'E_CANCELLED',
  });
  taskStore.markTaskStatus(cancelled, 'cancelled', { streamState: cancelled.streamState });

  const afterCancel = buildTaskEventsResumePayload(
    taskStore.getTaskSnapshotForUser('task-cancel-resume', 'user-a'),
    { sinceSeq: 3 },
  );
  assert.equal(afterCancel.events.length, 1);
  assert.equal(afterCancel.events[0].type, 'error');
  assert.equal(afterCancel.events[0].code, 'E_CANCELLED');
  assert.equal(afterCancel.events.filter(isTerminalResumeEvent).length, 1);
  assert.equal(afterCancel.events.some(isToolSideEffectEvent), false);

  const secondLook = buildTaskEventsResumePayload(
    taskStore.getTaskSnapshotForUser('task-cancel-resume', 'user-a'),
    { sinceSeq: afterCancel.events[0].seq },
  );
  assert.equal(secondLook.events.length, 0);
  assert.equal(secondLook.ackedTerminal, true);
  assert.equal(secondLook.alive, false);
});

test('duplicate cancel terminals collapse to a single honest error', () => {
  const events = [
    { seq: 4, type: 'tool_call', tool: 'web_search' },
    { seq: 5, type: 'error', code: 'E_CANCELLED', message: 'Tarea cancelada por el usuario.' },
    { seq: 6, type: 'error', code: 'E_CANCELLED', message: 'Tarea cancelada por el usuario.' },
  ];
  const pending = selectResumeEvents(events, 4);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].seq, 6);
  assert.equal(pending[0].type, 'error');
});

test('isToolSideEffectEvent covers tool_call, tool_output and file_artifact', () => {
  assert.equal(isToolSideEffectEvent({ type: 'tool_call' }), true);
  assert.equal(isToolSideEffectEvent({ type: 'tool_output' }), true);
  assert.equal(isToolSideEffectEvent({ type: 'file_artifact' }), true);
  assert.equal(isToolSideEffectEvent({ type: 'human_approval_resolved' }), true);
  assert.equal(isToolSideEffectEvent({ type: 'heartbeat' }), false);
  assert.equal(isToolSideEffectEvent({ type: 'step_start' }), false);
});

test('heartbeat frames are not sequenced side effects and do not move the cursor', () => {
  assert.equal(eventSeq({ type: 'heartbeat', at: Date.now() }), 0);
  assert.equal(isToolSideEffectEvent({ type: 'heartbeat' }), false);
  const pending = selectResumeEvents([
    { seq: 1, type: 'tool_call', tool: 'web_search' },
    { type: 'heartbeat', at: 1 },
    { seq: 2, type: 'step_done' },
  ], 1);
  assert.deepEqual(pending.map((evt) => evt.type), ['step_done']);
});

test('buildTaskEventsResumePayload exposes skipped side-effect counts', () => {
  const payload = buildTaskEventsResumePayload(runningTask(sideEffectLog()), { sinceSeq: 4 });
  assert.equal(payload.skippedCount, 4);
  assert.equal(payload.skippedSideEffects, 3);
  assert.equal(payload.resumeStatus, 'ok');
  assert.equal(payload.resumeLabel, null);
});

test('SSE reconnect mid-stream emits id frames and skips already-acked tool events', () => {
  const { joined, started } = replaySse({
    sinceSeq: '3',
    lastEventId: '3',
    events: sideEffectLog(),
    lastEventSeq: 6,
  });
  assert.equal(started.lastSeq, 3);
  assert.match(joined, /id: 4\n/);
  assert.match(joined, /file_artifact/);
  assert.doesNotMatch(joined, /"type":"tool_call"/);
  assert.doesNotMatch(joined, /"type":"tool_output"/);
  assert.match(joined, /"type":"done"/);
  assert.equal((joined.match(/"type":"tool_call"/g) || []).length, 0);
  assert.equal((joined.match(/"type":"done"/g) || []).length, 1);
});

test('SSE Last-Event-ID reconnect after a terminal does not invent a second error', () => {
  const events = [
    { seq: 1, type: 'step_done' },
    { seq: 2, type: 'done', stoppedReason: 'completed' },
  ];
  const { joined, started } = replaySse({
    lastEventId: '2',
    events,
    lastEventSeq: 2,
  });
  assert.equal(started.ackedTerminal, true);
  assert.equal(started.pending.length, 0);
  assert.doesNotMatch(joined, /"type":"done"/);
  assert.doesNotMatch(joined, /se cerró sin completar/);
  assert.equal((joined.match(/"type":"error"/g) || []).length, 0);
});

test('SSE gap reconnect emits Spanish resume_advisory and does not replay acked tools', () => {
  const retained = [
    { seq: 8, type: 'step_done' },
    { seq: 9, type: 'done' },
  ];
  const { joined, started } = replaySse({
    sinceSeq: '3',
    events: retained,
    lastEventSeq: 9,
  });
  assert.equal(started.advisory.resumeStatus, 'gap');
  assert.match(joined, /"type":"resume_advisory"/);
  assert.match(joined, /Hay un hueco en el historial/);
  assert.match(joined, /"resumeStatus":"gap"/);
  assert.doesNotMatch(joined, /"type":"tool_call"/);
  assert.equal((joined.match(/"type":"done"/g) || []).length, 1);
});

test('SSE stale cursor emits Spanish advisory and no replayed terminal', () => {
  const { joined, started } = replaySse({
    sinceSeq: '99',
    events: sideEffectLog(),
    lastEventSeq: 6,
  });
  assert.equal(started.advisory.resumeStatus, 'stale');
  assert.equal(started.pending.length, 0);
  assert.match(joined, /"resumeStatus":"stale"/);
  assert.match(joined, /desactualizado/);
  assert.doesNotMatch(joined, /"type":"tool_call"/);
  assert.doesNotMatch(joined, /"type":"done"/);
  assert.doesNotMatch(joined, /se cerró sin completar/);
});

test('events route source accepts sinceSeq and resume labels', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/agent-task.js'), 'utf8');
  assert.match(src, /sinceSeq: req\.query\.sinceSeq/);
  assert.match(src, /resumeLabel: resume\.resumeLabel/);
  assert.match(src, /beginSseResume/);
  assert.match(src, /formatSseEventFrame/);
  assert.match(src, /selectResumeEvents/);
});

test('human_approval_resolved is treated as a side effect and skipped when acked', () => {
  const events = [
    { seq: 1, type: 'human_approval_resolved', decision: 'approve' },
    { seq: 2, type: 'tool_call', tool: 'create_document' },
  ];
  const pending = selectResumeEvents(events, 1);
  assert.equal(pending.some((evt) => evt.type === 'human_approval_resolved'), false);
  assert.equal(pending[0].type, 'tool_call');
});

test('after remains compatible when sinceSeq is omitted', () => {
  const payload = buildTaskEventsResumePayload(runningTask(sideEffectLog()), { after: 5 });
  assert.equal(payload.sinceSeq, 5);
  assert.deepEqual(payload.events.map((evt) => evt.type), ['done']);
});
