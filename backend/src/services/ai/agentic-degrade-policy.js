'use strict';

/**
 * agentic-degrade-policy — what /api/ai/generate does when the agentic loop
 * ends degraded (not isHandledAgenticChatResult).
 *
 * Pure and synchronous: it only reads the loop's result and the turn's facts.
 * Three actions:
 *   - 'none'           the user stopped the turn or the client is gone: no
 *                      regeneration, no error frame.
 *   - 'honest_close'   end the turn with a typed error frame + Spanish copy.
 *                      Used when a regeneration cannot help: the model's
 *                      provider has no credit, rejects the key, forbids the
 *                      model, has no connection, its breaker is open or it is
 *                      in a per-minute window (owner policy: a model the user
 *                      picked is never switched, and the user is told exactly
 *                      which model and which cause); a GitHub/sandbox failure;
 *                      or a run that ran out of time.
 *   - 'plain_fallback' today's behaviour: regenerate once through the plain
 *                      stream (a tool-payload 400, a 5xx, max_steps…). Its own
 *                      failure is still reported transparently by ai-service.
 *
 * A step timeout regenerates only for turns without attachments or generated
 * files and within SIRAGPT_AGENTIC_PLAIN_FALLBACK_MAX_MS of the turn start:
 * a plain regeneration of a document/Office turn used to let the model invent
 * answers or refusals.
 */

const {
  AGENTIC_TIMEOUT_MESSAGE,
  classifyGenerateError,
} = require('./generate-sse-close');

const DEFAULT_PLAIN_FALLBACK_MAX_MS = 150_000;

// What a Stop that landed mid model call leaves persisted instead of the
// loop's generic «Hubo un problema temporal con el modelo…» apology (same copy
// as react-agent's buildDegradedAnswer('aborted')).
const STOPPED_MESSAGE = 'La tarea se canceló antes de completarse.';

// Causes (billing-failover.failureCauseFor) for which re-asking the same
// provider right now cannot succeed: close honestly instead.
const TERMINAL_CAUSES = new Set(['billing', 'auth', 'forbidden', 'unconfigured', 'breaker', 'rate_limit']);

function plainFallbackMaxMs(env = process.env) {
  const n = Number(env && env.SIRAGPT_AGENTIC_PLAIN_FALLBACK_MAX_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PLAIN_FALLBACK_MAX_MS;
}

/** The 3-digit HTTP status after «model_error:», or null. */
function modelErrorStatus(stoppedReason) {
  const m = /^model_error:\s*(\d{3})\b/i.exec(String(stoppedReason || '').trim());
  return m ? Number(m[1]) : null;
}

function isStepTimeout(reason) {
  return /step_timeout_\d+|request timed out/i.test(reason);
}

/**
 * A Stop that lands while the model call is in flight ends react-agent with
 * «model_error: Request was aborted.» (OpenAI SDK APIUserAbortError) or
 * «model_error: This operation was aborted» (fetch AbortError) and no
 * structured modelError. That is the user's Stop, not a provider failure: no
 * regeneration and no error frame. A real HTTP failure carries a status.
 */
function isAbortReason(reason, modelError) {
  const r = String(reason || '').trim();
  if (r === 'aborted') return true;
  if (!/^model_error:/i.test(r) || modelErrorStatus(r)) return false;
  if (modelError && typeof modelError === 'object' && Number(modelError.status) >= 100) return false;
  return /\b(?:was\s+)?aborted\b|\babort(?:ed)?error\b/i.test(r);
}

/**
 * An Error-like object for billing-failover.failureCauseFor, from the loop's
 * structured modelError ({status, code, message, reason}) or, without it, from
 * the «model_error: <status> <message>» stop reason.
 */
function providerErrorOf({ stoppedReason, modelError }) {
  if (modelError && typeof modelError === 'object') {
    const err = new Error(String(modelError.message || ''));
    if (modelError.status != null) err.status = Number(modelError.status) || undefined;
    if (modelError.code != null) err.code = String(modelError.code);
    return err;
  }
  const reason = String(stoppedReason || '').trim();
  if (!/^model_error:/i.test(reason) || isStepTimeout(reason)) return null;
  const err = new Error(reason.replace(/^model_error:\s*/i, ''));
  const status = modelErrorStatus(reason);
  if (status) err.status = status;
  return err;
}

function failureCause(providerErr, modelError) {
  let bf;
  try { bf = require('./billing-failover'); } catch (_) { return { cause: null, retryAfterSeconds: null }; }
  let cause = null;
  try { cause = providerErr ? bf.failureCauseFor(providerErr) : null; } catch (_) { cause = null; }
  // The loop's own reason (failoverReasonFor on the real error object, which
  // had headers and the full text) when the text alone is not enough.
  if (!cause && modelError && typeof modelError.reason === 'string' && modelError.reason) {
    cause = modelError.reason === 'unfunded_memo' ? 'billing' : modelError.reason;
  }
  let retryAfterSeconds = null;
  if (cause === 'rate_limit' && providerErr) {
    try {
      const ms = bf.retryAfterMs(providerErr);
      if (Number.isFinite(ms) && ms > 0) retryAfterSeconds = Math.max(1, Math.ceil(ms / 1000));
    } catch (_) { retryAfterSeconds = null; }
  }
  return { cause, retryAfterSeconds };
}

function timeoutMessage(modelLabel) {
  const label = String(modelLabel || '').trim();
  if (!label) return AGENTIC_TIMEOUT_MESSAGE;
  return `${label} tardó más de lo previsto y no pude terminar la respuesta. No cambié de modelo; reintenta o elige un modelo más rápido.`;
}

// The run's own time budget (tools, web fetches, sandbox, RAG and the model
// together) ran out: never blamed on the model's speed.
const RUNTIME_BUDGET_MESSAGE = 'La tarea agotó el tiempo disponible antes de terminar. No cambié de modelo; reintenta o divide el pedido en partes más pequeñas.';

// Causes a retry right now cannot fix: the client must not auto-retry.
const NON_RETRYABLE_CAUSES = new Set(['billing', 'auth', 'forbidden', 'unconfigured']);

function reasonCodeOf(reason) {
  const r = String(reason || '').trim().toLowerCase();
  if (!r) return 'unknown';
  if (r === 'aborted') return 'aborted';
  if (isStepTimeout(r)) return 'step_timeout';
  if (r.startsWith('model_error')) return 'model_error';
  if (r.startsWith('runtime_budget')) return 'runtime_budget';
  if (r === 'no_message') return 'no_message';
  if (r === 'max_steps' || r.startsWith('degraded_no_finalize')) return 'max_steps';
  if (r === 'invalid_tool_calls') return 'invalid_tool_calls';
  if (r.startsWith('tool_circuit_open')) return 'tool_circuit_open';
  if (r.startsWith('verification_failed')) return 'verification_failed';
  return 'unknown';
}

/**
 * Decide the route's action for a degraded agentic result.
 *
 * @param {object} p
 * @param {string} p.stoppedReason   react-agent / runAgenticChat stop reason
 * @param {string} [p.finalAnswer]   the loop's (degraded) answer
 * @param {string} [p.error]         a loop error string, when any
 * @param {object} [p.modelError]    react-agent result.modelError
 * @param {number} [p.elapsedMs]     ms since the turn started
 * @param {boolean} [p.clientGone]   the response already ended / SSE closed
 * @param {boolean} [p.userStopped]  the user pressed Stop (the turn's signal
 *                                   aborted)
 * @param {boolean} [p.hasAttachments] uploads or generated files in the turn
 * @param {string} [p.modelLabel]    the model's display name (never a raw id)
 * @param {object} [p.env]
 * @returns {{ action: 'plain_fallback'|'honest_close'|'none', code: string|null,
 *   reasonCode: string, message: string|null, billing: boolean,
 *   status: number|null, failureReason: string|null,
 *   retryAfterSeconds: number|null, retryable: false|null }}
 */
function decideAgenticDegrade({
  stoppedReason = '',
  finalAnswer = '',
  error = '',
  modelError = null,
  elapsedMs = 0,
  clientGone = false,
  userStopped = false,
  hasAttachments = false,
  modelLabel = '',
  env = process.env,
} = {}) {
  const reason = String(stoppedReason || '').trim();
  const status = modelErrorStatus(reason) || (modelError && Number(modelError.status)) || null;
  const out = (fields) => ({
    action: 'plain_fallback',
    code: null,
    reasonCode: reasonCodeOf(reason),
    message: null,
    billing: false,
    status: Number.isFinite(status) && status >= 100 && status <= 599 ? status : null,
    failureReason: null,
    retryAfterSeconds: null,
    retryable: null,
    ...fields,
  });

  const stopped = Boolean(userStopped) || isAbortReason(reason, modelError);
  if (clientGone || stopped) {
    // A Stop mid model call leaves only the loop's generic model_error
    // apology as finalAnswer: persist the cancel copy instead.
    const message = stopped && /^model_error:/i.test(reason) ? STOPPED_MESSAGE : null;
    return out({ action: 'none', reasonCode: 'aborted', message });
  }

  // GitHub / sandbox failures keep their current, specific copy.
  const classified = classifyGenerateError({
    message: String(finalAnswer || error || reason || ''),
    code: reason,
  });
  if (classified.code === 'E_GITHUB_CONNECT') {
    return out({ action: 'honest_close', code: classified.code, message: classified.message, reasonCode: 'github_connect' });
  }
  if (classified.code === 'E_SANDBOX') {
    return out({ action: 'honest_close', code: classified.code, message: classified.message, reasonCode: 'sandbox' });
  }

  // The model's provider could not answer: tell exactly which model and why.
  const providerErr = providerErrorOf({ stoppedReason: reason, modelError });
  if (providerErr || (modelError && typeof modelError === 'object')) {
    const { cause, retryAfterSeconds } = failureCause(providerErr, modelError);
    if (cause && TERMINAL_CAUSES.has(cause)) {
      let message = null;
      try {
        message = require('./billing-failover').buildFailureMessage({ modelLabel, reason: cause, retryAfterSeconds });
      } catch (_) { message = null; }
      if (message) {
        return out({
          action: 'honest_close',
          code: 'E_PROVIDER',
          message,
          reasonCode: cause,
          billing: cause === 'billing',
          failureReason: cause,
          retryAfterSeconds: cause === 'rate_limit' ? retryAfterSeconds : null,
          retryable: NON_RETRYABLE_CAUSES.has(cause) ? false : null,
        });
      }
    }
  }

  if (isStepTimeout(reason)) {
    if (!hasAttachments && Number(elapsedMs) < plainFallbackMaxMs(env)) {
      return out({ action: 'plain_fallback', reasonCode: 'step_timeout' });
    }
    return out({ action: 'honest_close', code: 'E_TIMEOUT', message: timeoutMessage(modelLabel), reasonCode: 'step_timeout' });
  }
  if (/^runtime_budget/i.test(reason)) {
    return out({ action: 'honest_close', code: 'E_TIMEOUT', message: RUNTIME_BUDGET_MESSAGE, reasonCode: 'runtime_budget' });
  }

  return out({ action: 'plain_fallback' });
}

module.exports = {
  decideAgenticDegrade,
  plainFallbackMaxMs,
  modelErrorStatus,
  isAbortReason,
  STOPPED_MESSAGE,
  RUNTIME_BUDGET_MESSAGE,
  DEFAULT_PLAIN_FALLBACK_MAX_MS,
  TERMINAL_CAUSES,
};
