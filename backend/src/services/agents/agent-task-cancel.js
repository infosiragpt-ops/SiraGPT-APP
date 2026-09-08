'use strict';

/**
 * Idempotent /agentes task cancel.
 *
 * After an SSE drop (#588) the client reconnects while the worker may still
 * be winding down from Stop. A second POST /cancel must not abort twice,
 * append a second E_CANCELLED, or rewrite a completed/error snapshot as
 * cancelled. The in-process latch (`cancelClaimed`) collapses a reconnect
 * retry and a double-Stop into one apply.
 *
 * Inspired by OpenClaw "already aborted" + idempotent run-handle clear
 * (MIT, github.com/openclaw/openclaw — infra/abort-signal.js,
 * agents/pi-embedded-runner/runs.ts). SiraGPT-owned rewrite; no vendored
 * runtime, no OpenRouter, no extra env.
 */

const { isInFlightTaskStatus } = require('./agent-task-event-resume');

const CANCEL_CODE = 'E_CANCELLED';

const CANCEL_REASONS = Object.freeze({
  APPLY: 'apply',
  NOT_FOUND: 'not_found',
  ALREADY_CANCELLED: 'already_cancelled',
  ALREADY_REQUESTED: 'already_requested',
  ALREADY_SIGNALLED: 'already_signalled',
  ALREADY_TERMINAL: 'already_terminal',
});

function normalizeStatus(task) {
  return String(task && task.status || '').trim().toLowerCase();
}

function hasCancelEvent(task) {
  const events = Array.isArray(task && task.events) ? task.events : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const evt = events[i];
    if (!evt) continue;
    // A manual retry starts a new attempt while retaining the replay history.
    // Stop markers before that boundary belong to the completed attempt.
    if (evt.type === 'repair_attempt' && evt.status === 'queued') return false;
    if (evt.code === CANCEL_CODE) return true;
    if (evt.reason === 'aborted' && (evt.type === 'error' || evt.type === 'run.failed')) return true;
  }
  return false;
}

function result({ apply, already, reason, status }) {
  return {
    apply: Boolean(apply),
    already: Boolean(already),
    reason,
    status: status || null,
    code: CANCEL_CODE,
  };
}

/**
 * Pure decision: should this cancel mutate the task?
 * An AbortSignal that is already aborted (timeout / orphan close) is NOT
 * enough to skip — only a prior Stop marker is.
 */
function decideTaskCancel(task) {
  if (!task || typeof task !== 'object') {
    return result({
      apply: false,
      already: false,
      reason: CANCEL_REASONS.NOT_FOUND,
      status: null,
    });
  }

  const status = normalizeStatus(task);

  if (status === 'cancelled' || task.cancelledAt) {
    return result({
      apply: false,
      already: true,
      reason: CANCEL_REASONS.ALREADY_CANCELLED,
      status: status || 'cancelled',
    });
  }

  if (task.cancelClaimed || task.cancelRequestedAt) {
    return result({
      apply: false,
      already: true,
      reason: CANCEL_REASONS.ALREADY_REQUESTED,
      status: status || 'cancelled',
    });
  }

  if (hasCancelEvent(task)) {
    return result({
      apply: false,
      already: true,
      reason: CANCEL_REASONS.ALREADY_SIGNALLED,
      status: status || 'cancelled',
    });
  }

  if (status && !isInFlightTaskStatus(status)) {
    return result({
      apply: false,
      already: true,
      reason: CANCEL_REASONS.ALREADY_TERMINAL,
      status,
    });
  }

  return result({
    apply: true,
    already: false,
    reason: CANCEL_REASONS.APPLY,
    status: 'cancelled',
  });
}

/**
 * Same decision, then latch the task so a concurrent reconnect retry
 * cannot apply a second cancel. Safe to call twice.
 */
function claimTaskCancel(task, { now = Date.now() } = {}) {
  const decision = decideTaskCancel(task);
  if (!decision.apply || !task || typeof task !== 'object') return decision;
  task.cancelClaimed = true;
  task.cancelRequestedAt = new Date(now).toISOString();
  return decision;
}

function isCancelAck(decision) {
  if (!decision) return false;
  if (decision.reason === CANCEL_REASONS.NOT_FOUND) return false;
  if (decision.reason === CANCEL_REASONS.ALREADY_TERMINAL) return false;
  return decision.apply || decision.already;
}

function buildCancelAck(task, decision) {
  return {
    ok: true,
    taskId: (task && task.taskId) || null,
    status: decision.status || normalizeStatus(task) || 'cancelled',
    already: decision.already,
    reason: decision.reason,
    code: CANCEL_CODE,
  };
}

module.exports = {
  CANCEL_CODE,
  CANCEL_REASONS,
  decideTaskCancel,
  claimTaskCancel,
  hasCancelEvent,
  isCancelAck,
  buildCancelAck,
};
