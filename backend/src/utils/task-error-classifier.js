'use strict';

/**
 * Unified task error classification for agent workers, graphs, and retries.
 * Single source of truth — agent-task-runner re-exports this module.
 *
 * Upstream 429 / Retry-After handling is a SiraGPT-owned rewrite of the
 * OpenClaw idea (MIT, github.com/openclaw/openclaw — parse Retry-After /
 * retry-after-ms / HTTP-date and do not retry before the hint). No
 * OpenClaw transport, SDK, env, or vendor names are imported.
 */

const RATE_LIMIT_USER_MESSAGE =
  'El proveedor está recibiendo demasiadas solicitudes. Espera unos segundos y reintenta.';
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;

function withJitter(baseMs) {
  if (!baseMs || baseMs <= 0) return baseMs;
  const spread = baseMs * 0.2;
  return Math.max(100, Math.round(baseMs + (Math.random() * 2 - 1) * spread));
}

function includesAny(value, needles) {
  return needles.some((needle) => value.includes(needle));
}

const NON_RETRYABLE_RULES = [
  {
    reason: 'aborted',
    patterns: [
      'aborted', 'aborterror', 'abort_err', 'cancelled', 'canceled', 'err_canceled',
      'operation was canceled', 'context canceled', 'context deadline exceeded',
      'client closed request', 'user interrupted', 'shutdown in progress',
    ],
  },
  {
    reason: 'context-length',
    patterns: [
      'context_length_exceeded', 'context length', 'context window', 'maximum context',
      'prompt is too long', 'too many tokens', 'token limit exceeded', 'input token limit',
      'output token limit', 'token budget exceeded', 'maximum prompt length',
      'reduce the length',
    ],
  },
  {
    reason: 'content-policy',
    patterns: [
      'content_policy', 'content policy', 'policy_violation', 'safety filter',
      'safety system', 'flagged by', 'moderation', 'terms of service',
      'responsible ai policy', 'unsafe content', 'guardrail intervention',
      'jailbreak detected', 'disallowed content',
    ],
  },
  {
    reason: 'auth-failure',
    codes: ['401', '403'],
    patterns: [
      'api_key', 'api key', 'authentication', 'permission denied', 'forbidden',
      'unauthorized', 'unauthorized_client', 'invalid bearer token', 'expired token',
      'missing authorization header', 'does not have access', 'not entitled',
    ],
  },
  {
    reason: 'validation-error',
    patterns: [
      'missing required', 'required field', 'invalid json', 'schema validation failed',
      'malformed request body', 'unsupported file type', 'invalid enum',
      'request body must be an object', 'zod validation', 'not configured',
      'invalid webhook signature',
    ],
  },
  {
    reason: 'model-unavailable',
    patterns: [
      'model_not_found', 'model not found', 'does not exist', 'deployment not found',
      'deprecated model', 'decommissioned', 'has been retired', 'no such model',
      'engine not found', 'model is not enabled', 'unknown model alias',
      'model temporarily disabled',
    ],
  },
  {
    reason: 'payload-too-large',
    codes: ['413'],
    patterns: [
      'payload too large', 'request entity too large', 'content too large',
      'body exceeded', 'max upload size exceeded', 'file size exceeds',
      'response too large', 'artifact exceeds max bytes', 'image is too large',
      'multipart body exceeded',
    ],
  },
  {
    reason: 'quota-exhausted',
    codes: ['402'],
    patterns: [
      'insufficient_quota', 'insufficient quota', 'quota exceeded', 'billing',
      'payment required', 'monthly usage limit', 'credits exhausted',
      'no available credits', 'subscription inactive', 'free tier limit', 'spend cap exceeded',
    ],
  },
  {
    reason: 'not-implemented',
    codes: ['501'],
    patterns: ['not implemented'],
  },
];

const RETRYABLE_RULES = [
  {
    reason: 'rate-limited',
    ttlMs: 15_000,
    codes: ['429'],
    patterns: [
      'rate limit', 'rate_limit', 'too many requests', 'resource exhausted',
      'rpm limit', 'tpm limit', 'concurrency limit', 'throttled', 'slow down',
      'burst limit', 'server busy, retry after',
    ],
  },
  {
    reason: 'dns-failure',
    ttlMs: 5_000,
    patterns: ['enotfound', 'eai_again', 'getaddrinfo', 'dns_probe_finished_nxdomain'],
  },
  {
    reason: 'network-timeout',
    ttlMs: 5_000,
    codes: ['408', '504'],
    patterns: [
      'timeout', 'timed out', 'etimedout', 'econnreset', 'econnrefused',
      'econnaborted', 'epipe', 'hang up', 'socket', 'gateway timeout',
    ],
  },
  {
    reason: 'ssl-error',
    ttlMs: 8_000,
    patterns: [
      'cert_has_expired', 'unable to verify', 'self signed certificate',
      'self-signed certificate', 'depth_zero_self_signed', 'ssl handshake',
      'tls handshake', 'handshake failure',
    ],
  },
  {
    reason: 'server-error',
    ttlMs: 10_000,
    codePrefix: '5',
    // 'overloaded'/'overloaded_error' = provider capacity pressure (e.g.
    // Anthropic HTTP 529) — transient, should be retried. Previously bare
    // 'overloaded' fell through to 'unknown' (non-retryable).
    patterns: ['internal server', 'service unavailable', 'bad gateway', 'upstream 503', '502 bad gateway', 'overloaded', 'overloaded_error', 'server is overloaded'],
  },
];

function matchesByCode(rule, code) {
  if (!code) return false;
  if (rule.codePrefix && code.startsWith(rule.codePrefix)) return true;
  if (rule.codes && rule.codes.some((c) => code === c || code.startsWith(c))) return true;
  return false;
}

function matchesByMessage(rule, combined) {
  return includesAny(combined, rule.patterns || []);
}

function matchesRule(rule, msg, code, errName) {
  return matchesByCode(rule, code) || matchesByMessage(rule, `${errName} ${code} ${msg}`);
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name) || headers.get(String(name).toLowerCase()) || null;
  }
  const lower = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return value;
  }
  return null;
}

/**
 * Read a provider cooldown hint. Accepts Headers, a plain object,
 * `retryAfterMs` / `retryAfter`, `retry-after`, and `retry-after-ms`.
 * Returns milliseconds or null. Never throws.
 */
function pickRetryAfterMs(err) {
  if (!err || typeof err !== 'object') return null;
  if (typeof err.retryAfterMs === 'number' && Number.isFinite(err.retryAfterMs) && err.retryAfterMs >= 0) {
    return err.retryAfterMs;
  }
  if (typeof err.retryAfter === 'number' && Number.isFinite(err.retryAfter) && err.retryAfter >= 0) {
    return err.retryAfter * 1000;
  }

  const headers = err.headers
    || (err.response && err.response.headers)
    || (err.cause && err.cause.headers)
    || null;
  const msRaw = headerValue(headers, 'retry-after-ms');
  if (msRaw != null && msRaw !== '') {
    const milliseconds = Number.parseFloat(msRaw);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
  }

  const raw = headerValue(headers, 'retry-after');
  if (raw == null || raw === '') return null;
  const trimmed = String(raw).trim();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber * 1000;
  const retryAt = Date.parse(trimmed);
  if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  return null;
}

function clampRetryAfterMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round(ms)));
}

function formatRateLimitUserMessage(retryAfterMs) {
  const clamped = clampRetryAfterMs(retryAfterMs);
  if (clamped == null) return RATE_LIMIT_USER_MESSAGE;
  const secs = Math.max(1, Math.round(clamped / 1000));
  if (secs <= 1) return RATE_LIMIT_USER_MESSAGE;
  return `El proveedor está recibiendo demasiadas solicitudes. Espera unos ${secs} segundos y reintenta.`;
}

function classifyRateLimited(err, rateRule) {
  const hintMs = pickRetryAfterMs(err);
  const clamped = clampRetryAfterMs(hintMs);
  const ttlMs = clamped != null ? clamped : withJitter(rateRule.ttlMs);
  return {
    retryable: true,
    reason: rateRule.reason,
    ttlMs,
    retryAfterMs: clamped,
    userMessage: formatRateLimitUserMessage(clamped),
  };
}

function classifyTaskError(err) {
  if (!err) return { retryable: false, reason: 'no-error' };
  const msg = String(err.message || err).toLowerCase();
  const code = String(err.code || err.statusCode || '').toLowerCase();
  const errName = String(err.name || '').toLowerCase();

  // Rate/concurrency pressure wins over generic quota words like "burst quota".
  const rateRule = RETRYABLE_RULES[0];
  if (matchesRule(rateRule, msg, code, errName)) {
    return classifyRateLimited(err, rateRule);
  }

  // ECONNABORTED is an HTTP client timeout code, not a user cancellation.
  if (code.includes('econnaborted') || msg.includes('econnaborted')) {
    return { retryable: true, reason: 'network-timeout', ttlMs: withJitter(5_000) };
  }

  const combined = `${errName} ${code} ${msg}`;

  // Structured HTTP status is authoritative — classify by status code BEFORE any
  // soft message-keyword rule. This keeps a transient 5xx retryable even when its
  // body happens to contain "invalid"/"unauthorized" (previously such errors hit
  // the NON_RETRYABLE auth/validation message rules and were given up on), while
  // genuinely permanent statuses (401/403 auth, 402 quota, 413 payload, 501
  // not-implemented) are still caught by their NON_RETRYABLE code rules, and 504
  // keeps its more specific 'network-timeout' reason.
  for (const rule of NON_RETRYABLE_RULES) {
    if (matchesByCode(rule, code)) return { retryable: false, reason: rule.reason };
  }
  for (const rule of RETRYABLE_RULES) {
    if (matchesByCode(rule, code)) return { retryable: true, reason: rule.reason, ttlMs: withJitter(rule.ttlMs) };
  }

  // No usable status code — fall back to message-keyword matching.
  for (const rule of NON_RETRYABLE_RULES) {
    if (matchesByMessage(rule, combined)) return { retryable: false, reason: rule.reason };
  }
  for (const rule of RETRYABLE_RULES.slice(1)) {
    if (matchesByMessage(rule, combined)) return { retryable: true, reason: rule.reason, ttlMs: withJitter(rule.ttlMs) };
  }

  if (msg.includes('missing') || msg.includes('invalid') || msg.includes('required')) {
    return { retryable: false, reason: 'validation-error' };
  }

  // Unknown errors: do not retry by default (prevents retry storms).
  return { retryable: false, reason: 'unknown', ttlMs: 0 };
}

/**
 * Public /agentes error surface (AGENTS.md §16).
 *
 * OpenClaw keeps terminal kinds distinct (`aborted` → cancelled,
 * `errorKind: timeout` ≠ `errorKind: refusal`) so the client does not
 * collapse every failure into one stop reason. This is a SiraGPT-owned
 * rewrite of that contract: classify → `{ code, label }` in Spanish.
 * No OpenClaw runtime or vendor names leak to the user.
 */
const TASK_ERROR_LABELS = Object.freeze({
  E_CANCELLED: 'La tarea se detuvo.',
  E_TIMEOUT: 'La tarea superó el tiempo de espera. Reintenta.',
  E_PROVIDER_UNAVAILABLE: 'El servicio no está disponible. Reintenta en unos segundos.',
  E_PROVIDER: 'El servidor tuvo un problema. Reintenta en unos segundos.',
  E_QUOTA: 'Has alcanzado el límite del plan. Espera unos minutos o actualiza tu plan.',
  E_RATE_LIMITED: RATE_LIMIT_USER_MESSAGE,
  E_CONTENT: 'Este pedido no se pudo completar por la política de contenido. Reformúlalo.',
  E_PARAMS: 'Faltan datos o el pedido no es válido.',
});

const REASON_TO_CODE = Object.freeze({
  aborted: 'E_CANCELLED',
  'network-timeout': 'E_TIMEOUT',
  'server-error': 'E_PROVIDER',
  'ssl-error': 'E_PROVIDER',
  'dns-failure': 'E_PROVIDER',
  'rate-limited': 'E_QUOTA',
  'quota-exhausted': 'E_QUOTA',
  'content-policy': 'E_CONTENT',
  'validation-error': 'E_PARAMS',
  'auth-failure': 'E_PARAMS',
  'payload-too-large': 'E_PARAMS',
  'context-length': 'E_PARAMS',
  'model-unavailable': 'E_PROVIDER',
  'not-implemented': 'E_PARAMS',
  unknown: 'E_PROVIDER',
  'no-error': 'E_PROVIDER',
});

const PRESERVED_LABEL_RE =
  /dej[oó] de responder|se detuvo|super[oó] el tiempo|no est[aá] disponible|tuvo un problema|Has alcanzado el l[ií]mite|sesi[oó]n expir[oó]|pol[ií]tica de contenido|Faltan datos|ag[eé]ntica fall[oó]|demasiadas solicitudes/i;

function httpStatusOf(err) {
  if (!err || typeof err !== 'object') return '';
  const raw = err.statusCode || err.status || err.code || '';
  const digits = String(raw).match(/(\d{3})/);
  return digits ? digits[1] : '';
}

function looksLikeTimeout(err, msg, status) {
  if (status === '408' || status === '504') return true;
  return /\b(timeout|timed out|etimedout|gateway timeout|deadline exceeded)\b/i.test(msg)
    || /\b(timeout|timed out|etimedout|gateway timeout|deadline exceeded)\b/i.test(String(err && err.name || ''));
}

function looksLikeUnavailable(err, msg, status) {
  if (status === '503') return true;
  return /\b503\b|service unavailable|servicio no disponible/i.test(msg);
}

function codeForClassification(classified, err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  const status = httpStatusOf(err);
  // Upstream 429 is provider pressure, not a plan-quota refusal. Keep the
  // listed §16 code `E_QUOTA` so existing clients do not see a new enum,
  // but never let a "timeout" word inside a 429 body steal the label.
  if (classified.reason === 'rate-limited' || status === '429') return 'E_QUOTA';
  if (looksLikeTimeout(err, msg, status)) return 'E_TIMEOUT';
  if (classified.reason === 'aborted') return 'E_CANCELLED';
  if (looksLikeUnavailable(err, msg, status)) return 'E_PROVIDER';
  return REASON_TO_CODE[classified.reason] || 'E_PROVIDER';
}

function labelForCode(code, err, classified) {
  const msg = String((err && err.message) || err || '');
  const status = httpStatusOf(err);
  if (classified && classified.reason === 'rate-limited') {
    return classified.userMessage || formatRateLimitUserMessage(classified.retryAfterMs);
  }
  if (code === 'E_PROVIDER' && looksLikeUnavailable(err, msg, status)) {
    return TASK_ERROR_LABELS.E_PROVIDER_UNAVAILABLE;
  }
  return TASK_ERROR_LABELS[code] || TASK_ERROR_LABELS.E_PROVIDER;
}

/**
 * Map a thrown / persisted agent-task failure to a user-facing payload.
 * `{ code, label, reason, retryable }` — `label` is Spanish, no vendor.
 */
function presentTaskError(err) {
  const classified = classifyTaskError(err);
  const raw = String((err && err.message) || (typeof err === 'string' ? err : '') || '').trim();
  const probe = err && typeof err === 'object' ? err : new Error(raw);
  const code = codeForClassification(classified, probe);
  const label = raw && PRESERVED_LABEL_RE.test(raw)
    ? raw
    : labelForCode(code, probe, classified);
  return {
    code,
    reason: classified.reason,
    label,
    retryable: Boolean(classified.retryable),
    retryAfterMs: classified.retryAfterMs || null,
  };
}

function toAgentTaskErrorEvent(err) {
  const presented = presentTaskError(err);
  const event = {
    type: 'error',
    code: presented.code,
    message: presented.label,
    reason: presented.reason,
  };
  if (presented.retryAfterMs) {
    event.retryAfterMs = presented.retryAfterMs;
    event.retryAfterSec = Math.max(1, Math.round(presented.retryAfterMs / 1000));
  }
  return event;
}

module.exports = {
  classifyTaskError,
  presentTaskError,
  toAgentTaskErrorEvent,
  pickRetryAfterMs,
  formatRateLimitUserMessage,
  TASK_ERROR_LABELS,
  RATE_LIMIT_USER_MESSAGE,
  MIN_RETRY_AFTER_MS,
  MAX_RETRY_AFTER_MS,
  withJitter,
};
