'use strict';

/**
 * Durable /agentes task resume helpers.
 *
 * After an SSE drop the worker may still be alive — #579 pulses `updatedAt`
 * and `lastEventAt` (OpenClaw-style activity stamp, native rewrite). Clients
 * reconnect with `?sinceSeq=<n>`, `?after=<seq>` or `Last-Event-ID` and keep
 * polling while `alive` is true. Already-acked events (seq <= cursor) are
 * skipped so tool side effects are never applied twice. When the runtime
 * watchdog reaps a dead worker, `lastError` carries `worker_stalled`.
 *
 * Inspired by OpenClaw gateway Last-Event-ID exclusive resume (MIT,
 * github.com/openclaw/openclaw). SiraGPT-owned rewrite; no vendored runtime.
 */

const {
  WORKER_STALLED_REASON,
  WORKER_STALLED_MESSAGE,
} = require('./agent-task-runtime-watchdog');
const {
  authorizeEventReplay,
  emptyResumePayload,
  recordDenialAudit,
} = require('./session-isolation');

const IN_FLIGHT_STATUSES = Object.freeze(['queued', 'running']);
const TERMINAL_STATUSES = Object.freeze(['completed', 'cancelled', 'error', 'failed']);
const SNAPSHOT_FRESH_MS = 90 * 1000;
const TERMINAL_LOOKUP_STATUSES = Object.freeze([401, 403, 404, 410]);

const TOOL_SIDE_EFFECT_TYPES = Object.freeze([
  'tool_call',
  'tool_output',
  'file_artifact',
  'human_approval_resolved',
]);

const TERMINAL_EVENT_TYPES = Object.freeze([
  'done',
  'error',
  'run.succeeded',
  'run.failed',
]);

const RESUME_LABELS = Object.freeze({
  gap: 'Hay un hueco en el historial: faltan eventos entre el cursor y el primer evento conservado.',
  stale: 'El cursor de reanudación está desactualizado: es posterior al último evento.',
});

function isInFlightTaskStatus(status) {
  return IN_FLIGHT_STATUSES.includes(String(status || '').trim().toLowerCase());
}

function isTerminalTaskStatus(status) {
  return TERMINAL_STATUSES.includes(String(status || '').trim().toLowerCase());
}

function isTerminalLookupStatus(statusCode) {
  return TERMINAL_LOOKUP_STATUSES.includes(Number(statusCode) || 0);
}

function eventSeq(event) {
  const seq = Number(event && event.seq);
  return Number.isFinite(seq) && seq > 0 ? seq : 0;
}

function isToolSideEffectEvent(event) {
  return TOOL_SIDE_EFFECT_TYPES.includes(String(event && event.type || '').trim());
}

function isTerminalResumeEvent(event) {
  return TERMINAL_EVENT_TYPES.includes(String(event && event.type || '').trim());
}

function sortEventsBySeq(events) {
  return (Array.isArray(events) ? events.slice() : []).sort((left, right) => {
    const delta = eventSeq(left) - eventSeq(right);
    if (delta !== 0) return delta;
    return String(left && left.id || '').localeCompare(String(right && right.id || ''));
  });
}

function resolveEventCursor(afterRaw, lastEventIdHeader, events) {
  const raw = String(afterRaw || '').trim() || String(lastEventIdHeader || '').trim() || '0';
  if (/^-?\d+$/.test(raw)) {
    const seq = Number(raw);
    return Number.isFinite(seq) ? Math.max(0, seq) : 0;
  }
  const match = Array.isArray(events)
    ? events.find((event) => event && String(event.id) === raw)
    : null;
  const fromId = Number(match && match.seq);
  return Number.isFinite(fromId) ? fromId : 0;
}

/**
 * Exclusive resume cursor. `sinceSeq` (the last acked eventSeq) wins over
 * `after` and `Last-Event-ID`. Replay is always `seq > cursor`.
 */
function resolveResumeCursor({
  sinceSeq,
  after,
  lastEventId,
  events,
} = {}) {
  if (sinceSeq != null && String(sinceSeq).trim() !== '') {
    return resolveEventCursor(sinceSeq, '', events);
  }
  return resolveEventCursor(after, lastEventId, events);
}

function resolveLastEventSeq(task, events) {
  const fromTask = Number(task && task.lastEventSeq);
  if (Number.isFinite(fromTask) && fromTask > 0) return fromTask;
  const seqs = (Array.isArray(events) ? events : []).map(eventSeq);
  return seqs.length ? Math.max(0, ...seqs) : 0;
}

function classifyResumeCursor({ cursor = 0, events = [], lastEventSeq = 0 } = {}) {
  const sorted = sortEventsBySeq(events);
  const seqs = sorted.map(eventSeq).filter((seq) => seq > 0);
  const firstRetainedSeq = seqs.length ? seqs[0] : 0;
  const newest = Number(lastEventSeq) > 0
    ? Number(lastEventSeq)
    : (seqs.length ? seqs[seqs.length - 1] : 0);
  const sinceSeq = Math.max(0, Number(cursor) || 0);

  if (sinceSeq > newest) {
    return {
      resumeStatus: 'stale',
      resumeLabel: RESUME_LABELS.stale,
      sinceSeq,
      firstRetainedSeq,
      lastEventSeq: newest,
      gapFrom: null,
      gapTo: null,
    };
  }

  if (sinceSeq > 0 && firstRetainedSeq > sinceSeq + 1) {
    return {
      resumeStatus: 'gap',
      resumeLabel: RESUME_LABELS.gap,
      sinceSeq,
      firstRetainedSeq,
      lastEventSeq: newest,
      gapFrom: sinceSeq + 1,
      gapTo: firstRetainedSeq - 1,
    };
  }

  return {
    resumeStatus: 'ok',
    resumeLabel: null,
    sinceSeq,
    firstRetainedSeq,
    lastEventSeq: newest,
    gapFrom: null,
    gapTo: null,
  };
}

function selectResumeEvents(events, cursor) {
  const sinceSeq = Math.max(0, Number(cursor) || 0);
  const pending = sortEventsBySeq(events).filter((event) => eventSeq(event) > sinceSeq);
  const nonTerminal = pending.filter((event) => !isTerminalResumeEvent(event));
  const terminals = pending.filter(isTerminalResumeEvent);
  const lastTerminal = terminals.length ? terminals[terminals.length - 1] : null;
  return lastTerminal ? nonTerminal.concat(lastTerminal) : nonTerminal;
}

function hasAckedTerminal(events, cursor) {
  const sinceSeq = Math.max(0, Number(cursor) || 0);
  return sortEventsBySeq(events).some((event) => (
    isTerminalResumeEvent(event) && eventSeq(event) > 0 && eventSeq(event) <= sinceSeq
  ));
}

function skippedAckedEvents(events, cursor) {
  const sinceSeq = Math.max(0, Number(cursor) || 0);
  return sortEventsBySeq(events).filter((event) => {
    const seq = eventSeq(event);
    return seq > 0 && seq <= sinceSeq;
  });
}

function resolveTaskLastError(task) {
  if (!task || typeof task !== 'object') return null;

  const events = Array.isArray(task.events) ? task.events : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const evt = events[i];
    if (!evt || (evt.type !== 'error' && evt.type !== 'run.failed')) continue;
    const message = String(evt.message || '').trim();
    if (message) return message;
  }

  const streamError = String(task.streamState && task.streamState.error || '').trim();
  if (streamError) return streamError;

  const statsError = String(task.stats && task.stats.error || '').trim();
  if (statsError) return statsError;

  const reason = String(task.failedReason || task.errorReason || '').trim();
  if (reason === WORKER_STALLED_REASON) return WORKER_STALLED_MESSAGE;
  if (reason) return reason;
  return null;
}

function isFreshSnapshot(updatedAt, { now = Date.now(), freshMs = SNAPSHOT_FRESH_MS } = {}) {
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return false;
  return (now - ts) <= freshMs;
}

function toIsoTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Prefer the dedicated lastEventAt pulse, then stream-state stamps, then
 * updatedAt. Used by pollers after SSE drop so a quiet-but-live worker
 * still looks alive.
 */
function resolveTaskLastEventAt(task) {
  if (!task || typeof task !== 'object') return null;
  const stream = task.streamState && typeof task.streamState === 'object'
    ? task.streamState
    : {};
  const candidates = [
    task.lastEventAt,
    stream.lastEventAt,
    stream.heartbeatAt,
    task.updatedAt,
    task.createdAt,
  ];
  for (const value of candidates) {
    const iso = toIsoTimestamp(value);
    if (iso) return iso;
  }
  return null;
}

function isTaskStillAlive(task, { now = Date.now(), freshMs = SNAPSHOT_FRESH_MS } = {}) {
  if (!isInFlightTaskStatus(task && task.status)) return false;
  return isFreshSnapshot(resolveTaskLastEventAt(task), { now, freshMs });
}

function beginSseResume({
  sinceSeq,
  after,
  lastEventId,
  events = [],
  lastEventSeq = 0,
  actorUserId,
  ownerUserId,
} = {}) {
  if (actorUserId != null) {
    const auth = authorizeEventReplay({
      ownerUserId,
      actorUserId,
      sessionKnown: true,
    });
    if (!auth.allowed) {
      recordDenialAudit({
        kind: 'replay',
        code: auth.code,
        reason: auth.reason,
        label: auth.message,
      });
      return {
        lastSeq: 0,
        ackedTerminal: false,
        pending: [],
        advisory: null,
      };
    }
  }
  const cursor = resolveResumeCursor({ sinceSeq, after, lastEventId, events });
  const classified = classifyResumeCursor({
    cursor,
    events,
    lastEventSeq: resolveLastEventSeq({ lastEventSeq }, events),
  });
  const pending = classified.resumeStatus === 'stale'
    ? []
    : selectResumeEvents(events, cursor);
  return {
    lastSeq: cursor,
    ackedTerminal: hasAckedTerminal(events, cursor),
    pending,
    advisory: classified.resumeStatus === 'ok' ? null : {
      type: 'resume_advisory',
      resumeStatus: classified.resumeStatus,
      resumeLabel: classified.resumeLabel,
      sinceSeq: cursor,
      gapFrom: classified.gapFrom,
      gapTo: classified.gapTo,
    },
  };
}

function formatSseEventFrame(obj, stringify = JSON.stringify) {
  const seq = eventSeq(obj);
  const serialized = stringify(obj);
  return (seq > 0 ? `id: ${seq}\n` : '') + `data: ${serialized}\n\n`;
}

function buildTaskEventsResumePayload(task, {
  after = 0,
  sinceSeq,
  lastEventId,
  now = Date.now(),
  freshMs = SNAPSHOT_FRESH_MS,
  actorUserId,
} = {}) {
  if (actorUserId != null) {
    const auth = authorizeEventReplay({
      ownerUserId: task && task.userId,
      actorUserId,
      sessionKnown: Boolean(task && (task.taskId || task.userId)),
    });
    if (!auth.allowed) {
      recordDenialAudit({
        kind: 'replay',
        code: auth.code,
        reason: auth.reason,
        label: auth.message,
      });
      return emptyResumePayload(auth);
    }
  }
  const allEvents = Array.isArray(task && task.events) ? task.events : [];
  const cursor = resolveResumeCursor({
    sinceSeq,
    after,
    lastEventId,
    events: allEvents,
  });
  const lastEventSeq = resolveLastEventSeq(task, allEvents);
  const lastEventAt = resolveTaskLastEventAt(task);
  const classified = classifyResumeCursor({
    cursor,
    events: allEvents,
    lastEventSeq,
  });
  const events = classified.resumeStatus === 'stale'
    ? []
    : selectResumeEvents(allEvents, cursor);
  const acked = skippedAckedEvents(allEvents, cursor);
  return {
    events,
    lastEventSeq,
    sinceSeq: cursor,
    resumeStatus: classified.resumeStatus,
    resumeLabel: classified.resumeLabel,
    gapFrom: classified.gapFrom,
    gapTo: classified.gapTo,
    firstRetainedSeq: classified.firstRetainedSeq,
    skippedCount: acked.length,
    skippedSideEffects: acked.filter(isToolSideEffectEvent).length,
    ackedTerminal: hasAckedTerminal(allEvents, cursor),
    updatedAt: (task && task.updatedAt) || null,
    lastEventAt,
    alive: isTaskStillAlive(task, { now, freshMs }),
    lastError: resolveTaskLastError(task),
  };
}

module.exports = {
  IN_FLIGHT_STATUSES,
  TERMINAL_STATUSES,
  TERMINAL_EVENT_TYPES,
  TOOL_SIDE_EFFECT_TYPES,
  SNAPSHOT_FRESH_MS,
  RESUME_LABELS,
  isInFlightTaskStatus,
  isTerminalTaskStatus,
  isTerminalLookupStatus,
  isToolSideEffectEvent,
  isTerminalResumeEvent,
  eventSeq,
  sortEventsBySeq,
  resolveEventCursor,
  resolveResumeCursor,
  resolveLastEventSeq,
  classifyResumeCursor,
  selectResumeEvents,
  hasAckedTerminal,
  skippedAckedEvents,
  resolveTaskLastError,
  resolveTaskLastEventAt,
  isFreshSnapshot,
  isTaskStillAlive,
  beginSseResume,
  formatSseEventFrame,
  buildTaskEventsResumePayload,
};
