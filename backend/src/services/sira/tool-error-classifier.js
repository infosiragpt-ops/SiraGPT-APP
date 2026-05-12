'use strict';

/**
 * tool-error-classifier — turns raw tool failures into actionable
 * recovery decisions.
 *
 * Why this exists:
 *  `tool-resilience.js` retries with backoff. `agent-task-runner.js`
 *  classifies generic task errors. Neither produces a structured "what
 *  happened, why, and what should we do next?" answer that the cortex
 *  orchestrator (or a planner) can route on. This module fills that
 *  gap with a single deterministic function that:
 *
 *    1. Reads the raw error (object, string, or fetch Response).
 *    2. Classifies it along three axes:
 *         - category   : network | timeout | rate_limit | auth |
 *                        validation | quota | tool_internal |
 *                        upstream_5xx | not_found | conflict |
 *                        permission_denied | unknown
 *         - severity   : transient | permanent | user_fixable | system
 *         - retryable  : boolean (with optional retryAfterMs hint)
 *    3. Decides a recovery strategy from a fixed vocabulary:
 *         - retry_with_backoff
 *         - retry_with_fallback_model
 *         - retry_with_different_tool
 *         - ask_user_for_input
 *         - escalate_to_operator
 *         - abort_and_surface_error
 *    4. Produces a short, user-friendly explanation (Spanish, fall
 *       back to English when the upstream message is English).
 *
 *  All output is plain JSON, no LLM, no network. The orchestrator
 *  applies the strategy; this module is the brain that decides which.
 *
 * Public API:
 *   classifyToolError(error, context?) → ToolErrorDecision
 *
 * ToolErrorDecision shape:
 *   {
 *     category:           string,   // taxonomy below
 *     severity:           string,   // 'transient' | 'permanent' |
 *                                   // 'user_fixable' | 'system'
 *     retryable:          boolean,
 *     retryAfterMs:       number|null,
 *     strategy:           string,   // strategy vocabulary
 *     reasons:            string[], // why we landed here (audit)
 *     userMessage:        string,   // safe to render in chat UI
 *     telemetry:          { code, status, toolName, attempts },
 *   }
 */

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT',
  'ENETUNREACH', 'EPIPE', 'EHOSTUNREACH', 'ESOCKETTIMEDOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);
const PERMISSION_STATUSES = new Set([401, 403]);
const VALIDATION_STATUSES = new Set([400, 422]);
const NOT_FOUND_STATUSES = new Set([404, 410]);
const CONFLICT_STATUSES = new Set([409, 423]);
const QUOTA_STATUSES = new Set([402, 429]); // 429 may also be rate-limit

const TIMEOUT_RE = /(?:timed?\s?out|timeout|deadline\s+exceeded|aborted|signal\s+aborted)/i;
const RATE_LIMIT_RE = /(?:rate\s?limit|too\s+many\s+requests|throttl(?:ed|ing)|429)/i;
const AUTH_RE = /(?:unauthor(?:i[sz]ed|i[sz]ation\s+failed)|invalid\s+(?:api[\s_-]?key|token|credentials)|expired\s+token|forbidden|access\s+denied)/i;
const QUOTA_RE = /(?:quota|insufficient\s+(?:credit|balance|funds)|payment\s+required|spend\s+limit|usage\s+limit)/i;
const VALIDATION_RE = /(?:invalid\s+(?:argument|parameter|schema|input|json|payload)|missing\s+(?:field|parameter|required)|bad\s+request|malformed)/i;
const NOT_FOUND_RE = /(?:not\s+found|no\s+such|does\s+not\s+exist|404|gone)/i;
const NETWORK_RE = /(?:network|dns|socket|connection\s+(?:refused|reset|closed))/i;

// ─── Helpers ─────────────────────────────────────────────────────────

function pickStatus(err) {
  if (!err) return null;
  if (typeof err === 'object') {
    if (Number.isFinite(err.status)) return err.status;
    if (Number.isFinite(err.statusCode)) return err.statusCode;
    if (err.response && Number.isFinite(err.response.status)) return err.response.status;
    if (err.cause && Number.isFinite(err.cause.status)) return err.cause.status;
  }
  return null;
}

function pickCode(err) {
  if (!err) return null;
  if (typeof err === 'object') {
    if (typeof err.code === 'string') return err.code;
    if (err.cause && typeof err.cause.code === 'string') return err.cause.code;
  }
  return null;
}

function pickMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || '';
  if (typeof err === 'object') {
    if (typeof err.message === 'string') return err.message;
    if (err.error && typeof err.error.message === 'string') return err.error.message;
  }
  return String(err);
}

function pickRetryAfter(err) {
  if (!err || typeof err !== 'object') return null;
  // Standard HTTP header
  const headers = err.headers
    || (err.response && err.response.headers)
    || (err.cause && err.cause.headers)
    || null;
  if (headers && typeof headers.get === 'function') {
    const raw = headers.get('retry-after');
    if (raw) return parseRetryAfter(raw);
  }
  if (headers && typeof headers === 'object') {
    const raw = headers['retry-after'] || headers['Retry-After'];
    if (raw) return parseRetryAfter(raw);
  }
  if (typeof err.retryAfterMs === 'number' && Number.isFinite(err.retryAfterMs)) return err.retryAfterMs;
  if (typeof err.retryAfter === 'number' && Number.isFinite(err.retryAfter)) return err.retryAfter * 1000;
  return null;
}

function parseRetryAfter(raw) {
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  // HTTP-date form
  const t = Date.parse(raw);
  if (Number.isFinite(t)) {
    const delta = t - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

function detectCategoryFromMessage(message) {
  if (!message) return null;
  if (RATE_LIMIT_RE.test(message)) return 'rate_limit';
  if (TIMEOUT_RE.test(message)) return 'timeout';
  if (AUTH_RE.test(message)) return 'auth';
  if (QUOTA_RE.test(message)) return 'quota';
  if (VALIDATION_RE.test(message)) return 'validation';
  if (NOT_FOUND_RE.test(message)) return 'not_found';
  if (NETWORK_RE.test(message)) return 'network';
  return null;
}

function categoryFromStatus(status) {
  if (PERMISSION_STATUSES.has(status)) return 'permission_denied';
  if (QUOTA_STATUSES.has(status) && status === 402) return 'quota';
  if (status === 429) return 'rate_limit';
  if (NOT_FOUND_STATUSES.has(status)) return 'not_found';
  if (CONFLICT_STATUSES.has(status)) return 'conflict';
  if (VALIDATION_STATUSES.has(status)) return 'validation';
  if (status >= 500 && status < 600) return 'upstream_5xx';
  return null;
}

function categoryFromCode(code) {
  if (!code) return null;
  if (TRANSIENT_NETWORK_CODES.has(code)) return 'network';
  if (/timeout/i.test(code)) return 'timeout';
  if (/abort/i.test(code)) return 'timeout';
  return null;
}

// ─── Severity, retryability, strategy ───────────────────────────────

const TRANSIENT_CATEGORIES = new Set(['network', 'timeout', 'rate_limit', 'upstream_5xx']);
const USER_FIXABLE_CATEGORIES = new Set(['auth', 'permission_denied', 'quota']);
const SYSTEM_CATEGORIES = new Set(['tool_internal', 'unknown']);
const PERMANENT_CATEGORIES = new Set(['validation', 'not_found', 'conflict']);

function deriveSeverity(category) {
  if (TRANSIENT_CATEGORIES.has(category)) return 'transient';
  if (USER_FIXABLE_CATEGORIES.has(category)) return 'user_fixable';
  if (PERMANENT_CATEGORIES.has(category)) return 'permanent';
  return 'system';
}

function deriveRetryable({ category, status, code, attempts, maxAttempts }) {
  const cap = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 3;
  if (attempts >= cap) return false;
  if (TRANSIENT_CATEGORIES.has(category)) return true;
  if (status && RETRYABLE_STATUSES.has(status)) return true;
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return false;
}

function deriveStrategy({ category, severity, retryable, status, attempts, hasFallbackModel, hasFallbackTool }) {
  if (category === 'rate_limit' || category === 'upstream_5xx' || category === 'timeout' || category === 'network') {
    if (retryable && attempts <= 1) return 'retry_with_backoff';
    if (hasFallbackModel) return 'retry_with_fallback_model';
    if (hasFallbackTool) return 'retry_with_different_tool';
    return 'abort_and_surface_error';
  }
  if (category === 'quota') {
    return hasFallbackModel ? 'retry_with_fallback_model' : 'escalate_to_operator';
  }
  if (category === 'auth' || category === 'permission_denied') {
    return 'ask_user_for_input';
  }
  if (category === 'validation' || category === 'not_found' || category === 'conflict') {
    return hasFallbackTool ? 'retry_with_different_tool' : 'ask_user_for_input';
  }
  if (severity === 'transient' && retryable) return 'retry_with_backoff';
  void status;
  return 'abort_and_surface_error';
}

// ─── User-facing message ────────────────────────────────────────────

const MESSAGES = {
  network: 'Hubo un problema de red al contactar la herramienta. Reintentando…',
  timeout: 'La herramienta tardó demasiado en responder. Probaré una vía alternativa.',
  rate_limit: 'La herramienta nos limitó la velocidad. Esperaré unos segundos y reintentaré.',
  upstream_5xx: 'El servicio externo tuvo un fallo temporal. Reintentando.',
  auth: 'La herramienta requiere reautenticación. Revisa la conexión o los permisos del servicio.',
  permission_denied: 'No tengo permiso para ejecutar esa acción con el usuario actual.',
  quota: 'Se agotó la cuota disponible para esa herramienta. Sugiero cambiar a una alternativa o ampliar el plan.',
  validation: 'La herramienta rechazó los datos enviados. Voy a reformular el llamado.',
  not_found: 'El recurso solicitado no existe o ya no está disponible. Puedo intentar con otro identificador si me lo das.',
  conflict: 'La acción entró en conflicto con el estado actual. Necesito que confirmes cómo proceder.',
  tool_internal: 'La herramienta interna falló inesperadamente. Voy a reintentar con una alternativa.',
  unknown: 'Ocurrió un fallo no clasificado en la herramienta. Voy a reintentar.',
};

function deriveUserMessage(category, fallbackMessage) {
  return MESSAGES[category] || fallbackMessage || MESSAGES.unknown;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Classify a tool failure and propose a recovery strategy.
 *
 * @param {unknown} err
 *   The raw error. Accepts Error instances, plain objects with
 *   `{ code, message, status }`, fetch Response-like objects, or strings.
 *
 * @param {object} [context]
 * @param {string} [context.toolName]        Used only for telemetry.
 * @param {number} [context.attempts=1]      Number of attempts so far.
 * @param {number} [context.maxAttempts=3]   Retry cap.
 * @param {boolean} [context.hasFallbackModel=false]
 * @param {boolean} [context.hasFallbackTool=false]
 * @returns {ToolErrorDecision}
 */
function classifyToolError(err, context = {}) {
  const message = pickMessage(err);
  const status = pickStatus(err);
  const code = pickCode(err);
  const retryAfterMs = pickRetryAfter(err);

  const reasons = [];
  let category = null;

  // Layer 1: HTTP status mapping (highest signal)
  if (status) {
    const cat = categoryFromStatus(status);
    if (cat) { category = cat; reasons.push(`http_status:${status}→${cat}`); }
  }
  // Layer 2: Node.js error code
  if (!category && code) {
    const cat = categoryFromCode(code);
    if (cat) { category = cat; reasons.push(`code:${code}→${cat}`); }
  }
  // Layer 3: Pattern match on the message
  if (!category && message) {
    const cat = detectCategoryFromMessage(message);
    if (cat) { category = cat; reasons.push(`message:${cat}`); }
  }
  // Layer 4: tool-internal fallback when an explicit toolName context is
  // present and we still can't classify.
  if (!category) {
    if (context.toolName) {
      category = 'tool_internal';
      reasons.push('fallback:tool_internal');
    } else {
      category = 'unknown';
      reasons.push('fallback:unknown');
    }
  }

  const severity = deriveSeverity(category);
  const attempts = Number.isFinite(context.attempts) ? Number(context.attempts) : 1;
  const retryable = deriveRetryable({
    category, status, code, attempts, maxAttempts: context.maxAttempts,
  });
  const strategy = deriveStrategy({
    category, severity, retryable, status, attempts,
    hasFallbackModel: Boolean(context.hasFallbackModel),
    hasFallbackTool: Boolean(context.hasFallbackTool),
  });

  return {
    category,
    severity,
    retryable,
    retryAfterMs,
    strategy,
    reasons,
    userMessage: deriveUserMessage(category, message),
    telemetry: {
      code: code || null,
      status: status || null,
      toolName: context.toolName || null,
      attempts,
      messageSnippet: String(message).slice(0, 160) || null,
    },
  };
}

module.exports = {
  classifyToolError,
  TRANSIENT_NETWORK_CODES,
  RETRYABLE_STATUSES,
  _internal: {
    pickStatus, pickCode, pickMessage, pickRetryAfter,
    detectCategoryFromMessage, categoryFromStatus, categoryFromCode,
    deriveSeverity, deriveRetryable, deriveStrategy,
    MESSAGES,
  },
};
