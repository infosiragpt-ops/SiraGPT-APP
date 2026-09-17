'use strict';

/**
 * Gateway-style session isolation for /agentes + agent-gateway.
 *
 * Native rewrite of OpenClaw multi-user session-scope ideas (MIT,
 * github.com/openclaw/openclaw — per-peer DM isolation, owner-scoped
 * abort, Last-Event-ID exclusive to that session). SiraGPT-owned
 * CommonJS: fail-closed owner checks, no cross-user eventSeq leak,
 * Spanish denial audit lines. Not a dump of `gateway/` or `sessions/`.
 *
 * Internal abort without an actor stays compatible with leftover
 * callers (cron timeout / 3H2). HTTP always passes the actor.
 */

const { redactString } = require('../../utils/secret-redactor');

const DENIAL_KINDS = Object.freeze({
  CIRCUIT: 'circuit',
  LEASE: 'lease',
  RECEIPT: 'receipt',
  ABORT: 'abort',
  REPLAY: 'replay',
});

const DENIAL_LABELS_ES = Object.freeze({
  abort_forbidden: 'No puedes abortar la sesión de otro usuario.',
  abort_unowned: 'No se puede abortar una sesión sin propietario.',
  abort_unknown: 'La sesión no existe.',
  abort_actor_required: 'Falta el usuario que aborta la sesión.',
  replay_forbidden: 'No puedes reanudar el historial de otra sesión.',
  replay_unowned: 'No se puede reanudar una sesión sin propietario.',
  replay_unknown: 'La sesión no existe.',
  replay_actor_required: 'Falta el usuario que reanuda el historial.',
  cancel_forbidden: 'No puedes cancelar la tarea de otro usuario.',
});

const KIND_ES = Object.freeze({
  circuit: 'circuito',
  lease: 'lease',
  receipt: 'recibo',
  abort: 'aborto',
  replay: 'reanudación',
});

const AUDIT_PREFIX = '[DENEGACIÓN]';
const VENDOR_LEAK = /openclaw|openrouter|deepseek|sk-|Bearer|AKIA|BEGIN /i;
const RECENT_CAP = 64;

const _recent = [];

function trimId(value) {
  if (value == null) return '';
  return String(value).trim();
}

function actorProvided(actorUserId) {
  return actorUserId !== undefined && actorUserId !== null;
}

function idsMatch(left, right) {
  const a = trimId(left);
  const b = trimId(right);
  return Boolean(a) && a === b;
}

function denyAuth({ code, reason, message }) {
  return {
    allowed: false,
    ok: false,
    code,
    reason,
    message,
  };
}

function allowAuth() {
  return {
    allowed: true,
    ok: true,
    code: null,
    reason: null,
    message: null,
  };
}

/**
 * Owner-scoped abort. Omitting actorUserId (internal leftover) is
 * allowed. When the actor is present the session must exist and the
 * owner must match — no abort of a guessed lane.
 */
function authorizeSessionAbort({
  ownerUserId,
  actorUserId,
  sessionKnown = false,
} = {}) {
  const owner = trimId(ownerUserId);
  const actor = trimId(actorUserId);
  const provided = actorProvided(actorUserId);

  if (!provided) return allowAuth();

  if (!sessionKnown) {
    return denyAuth({
      code: 'not_found',
      reason: 'abort_unknown',
      message: DENIAL_LABELS_ES.abort_unknown,
    });
  }
  if (!actor) {
    return denyAuth({
      code: 'forbidden',
      reason: 'abort_actor_required',
      message: DENIAL_LABELS_ES.abort_actor_required,
    });
  }
  if (!owner) {
    return denyAuth({
      code: 'forbidden',
      reason: 'abort_unowned',
      message: DENIAL_LABELS_ES.abort_unowned,
    });
  }
  if (owner !== actor) {
    return denyAuth({
      code: 'forbidden',
      reason: 'abort_forbidden',
      message: DENIAL_LABELS_ES.abort_forbidden,
    });
  }
  return allowAuth();
}

/**
 * Owner-scoped eventSeq resume. Fail-closed: missing actor, unknown
 * session, or missing owner never returns another user's frames.
 */
function authorizeEventReplay({
  ownerUserId,
  actorUserId,
  sessionKnown = false,
} = {}) {
  const owner = trimId(ownerUserId);
  const actor = trimId(actorUserId);

  if (!actor) {
    return denyAuth({
      code: 'user_required',
      reason: 'replay_actor_required',
      message: DENIAL_LABELS_ES.replay_actor_required,
    });
  }
  if (!sessionKnown) {
    return denyAuth({
      code: 'forbidden',
      reason: 'replay_unknown',
      message: DENIAL_LABELS_ES.replay_unknown,
    });
  }
  if (!owner) {
    return denyAuth({
      code: 'forbidden',
      reason: 'replay_unowned',
      message: DENIAL_LABELS_ES.replay_unowned,
    });
  }
  if (owner !== actor) {
    return denyAuth({
      code: 'forbidden',
      reason: 'replay_forbidden',
      message: DENIAL_LABELS_ES.replay_forbidden,
    });
  }
  return allowAuth();
}

function emptyResumePayload(auth = {}) {
  return {
    events: [],
    lastEventSeq: 0,
    sinceSeq: 0,
    resumeStatus: 'forbidden',
    resumeLabel: auth.message || DENIAL_LABELS_ES.replay_forbidden,
    gapFrom: null,
    gapTo: null,
    firstRetainedSeq: 0,
    skippedCount: 0,
    skippedSideEffects: 0,
    ackedTerminal: false,
    updatedAt: null,
    lastEventAt: null,
    alive: false,
    lastError: null,
  };
}

function resumeLeaksEventSeq(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (Number(payload.lastEventSeq) > 0) return true;
  if (Number(payload.firstRetainedSeq) > 0) return true;
  if (Number(payload.sinceSeq) > 0) return true;
  if (Number(payload.gapFrom) > 0 || Number(payload.gapTo) > 0) return true;
  const events = Array.isArray(payload.events) ? payload.events : [];
  return events.some((event) => Number(event && (event.seq != null ? event.seq : event.id)) > 0);
}

function sanitizeAuditPart(value, max = 160) {
  let raw = '';
  try {
    raw = redactString(String(value == null ? '' : value).trim());
  } catch {
    return '';
  }
  if (!raw) return '';
  if (VENDOR_LEAK.test(raw)) return '';
  if (/eventSeq|lastEventSeq|sinceSeq/i.test(raw)) return '';
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

function formatDenialAuditLine(input = {}) {
  const kindKey = String(input.kind || '').trim().toLowerCase();
  const kindLabel = KIND_ES[kindKey] || 'denegación';
  const parts = [`${AUDIT_PREFIX} ${kindLabel}`];
  const code = sanitizeAuditPart(input.code);
  if (code) parts.push(`código=${code}`);
  const scope = sanitizeAuditPart(input.scope);
  if (scope) parts.push(`alcance=${scope}`);
  const channel = sanitizeAuditPart(input.channel);
  if (channel) parts.push(`canal=${channel}`);
  const jobId = sanitizeAuditPart(input.jobId);
  if (jobId) parts.push(`trabajo=${jobId}`);
  const reason = sanitizeAuditPart(input.label || input.message || input.reason);
  if (reason) parts.push(`motivo=${reason}`);
  return parts.join(' ');
}

function recordDenialAudit(input, { sink } = {}) {
  const line = formatDenialAuditLine(input);
  const entry = {
    at: Date.now(),
    line,
    kind: input && input.kind ? String(input.kind) : null,
    code: input && input.code ? String(input.code) : null,
  };
  _recent.push(entry);
  if (_recent.length > RECENT_CAP) _recent.shift();
  const underNodeTest = Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === 'test';
  if (typeof sink === 'function') {
    try { sink(line); } catch { /* isolate */ }
  } else if (!underNodeTest) {
    console.warn(line);
  }
  return entry;
}

function recentDenialAudits() {
  return _recent.slice();
}

function resetDenialAudits() {
  _recent.length = 0;
  return { ok: true, remaining: 0 };
}

function attachAuditLine(target, input) {
  if (!target || typeof target !== 'object') return target;
  const entry = recordDenialAudit(input);
  target.auditLine = entry.line;
  return target;
}

module.exports = {
  DENIAL_KINDS,
  DENIAL_LABELS_ES,
  KIND_ES,
  AUDIT_PREFIX,
  trimId,
  actorProvided,
  idsMatch,
  authorizeSessionAbort,
  authorizeEventReplay,
  emptyResumePayload,
  resumeLeaksEventSeq,
  sanitizeAuditPart,
  formatDenialAuditLine,
  recordDenialAudit,
  recentDenialAudits,
  resetDenialAudits,
  attachAuditLine,
};
