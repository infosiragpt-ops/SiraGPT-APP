'use strict';

/**
 * Durable /agentes task resume helpers.
 *
 * After an SSE drop the worker may still be alive — #579 pulses `updatedAt`
 * and `lastEventAt` (OpenClaw-style activity stamp, native rewrite). Clients
 * reconnect with `?after=<seq>` or `Last-Event-ID` and keep polling while
 * `alive` is true. When the runtime watchdog reaps a dead worker, `lastError`
 * carries `worker_stalled` so the chat can close.
 *
 * Inspired by OpenClaw `agent.wait` / task `lastEventAt` (MIT,
 * github.com/openclaw/openclaw). SiraGPT-owned rewrite; no vendored runtime.
 */

const {
  WORKER_STALLED_REASON,
  WORKER_STALLED_MESSAGE,
} = require('./agent-task-runtime-watchdog');

const IN_FLIGHT_STATUSES = Object.freeze(['queued', 'running']);
const TERMINAL_STATUSES = Object.freeze(['completed', 'cancelled', 'error', 'failed']);
const SNAPSHOT_FRESH_MS = 90 * 1000;
const TERMINAL_LOOKUP_STATUSES = Object.freeze([401, 403, 404, 410]);

function isInFlightTaskStatus(status) {
  return IN_FLIGHT_STATUSES.includes(String(status || '').trim().toLowerCase());
}

function isTerminalTaskStatus(status) {
  return TERMINAL_STATUSES.includes(String(status || '').trim().toLowerCase());
}

function isTerminalLookupStatus(statusCode) {
  return TERMINAL_LOOKUP_STATUSES.includes(Number(statusCode) || 0);
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

function buildTaskEventsResumePayload(task, {
  after = 0,
  now = Date.now(),
  freshMs = SNAPSHOT_FRESH_MS,
} = {}) {
  const allEvents = Array.isArray(task && task.events) ? task.events : [];
  const cursor = Math.max(0, Number(after) || 0);
  const lastEventSeq = Number(task && task.lastEventSeq)
    || Math.max(0, ...allEvents.map((evt) => Number(evt && evt.seq) || 0), 0);
  const lastEventAt = resolveTaskLastEventAt(task);
  return {
    events: allEvents.filter((event) => (Number(event && event.seq) || 0) > cursor),
    lastEventSeq,
    updatedAt: (task && task.updatedAt) || null,
    lastEventAt,
    alive: isTaskStillAlive(task, { now, freshMs }),
    lastError: resolveTaskLastError(task),
  };
}

module.exports = {
  IN_FLIGHT_STATUSES,
  TERMINAL_STATUSES,
  SNAPSHOT_FRESH_MS,
  isInFlightTaskStatus,
  isTerminalTaskStatus,
  isTerminalLookupStatus,
  resolveEventCursor,
  resolveTaskLastError,
  resolveTaskLastEventAt,
  isFreshSnapshot,
  isTaskStillAlive,
  buildTaskEventsResumePayload,
};
