'use strict';

const metrics = require('../../utils/metrics');
const { getRequestId } = require('../../middleware/request-id');

metrics.registerCounter('siragpt_stream_failures_total', {
  help: 'Sanitized streaming failures by bounded backend surface and stable public code',
  labels: ['surface', 'code'],
  maxSeries: 64,
});

const RULES = [
  {
    code: 'aborted',
    retryable: true,
    matches: (error, text) => error?.name === 'AbortError' || /\babort(?:ed)?\b/i.test(text),
    message: 'La operación fue cancelada.',
  },
  {
    code: 'timeout',
    retryable: true,
    matches: (error, text) => error?.name === 'TimeoutError' || /timeout|timed out|etimedout/i.test(text),
    message: 'La operación tardó demasiado. Inténtalo nuevamente.',
  },
  {
    code: 'rate_limited',
    retryable: true,
    matches: (error, text) => Number(error?.status) === 429 || /\b429\b|rate.?limit|too many requests/i.test(text),
    message: 'El servicio está procesando muchas solicitudes. Inténtalo en unos segundos.',
  },
  {
    code: 'provider_unavailable',
    retryable: true,
    matches: (error, text) => Number(error?.status) >= 500 || /econnreset|econnrefused|service unavailable|provider unavailable/i.test(text),
    message: 'El proveedor no está disponible temporalmente.',
  },
  {
    code: 'persistence_failed',
    retryable: true,
    matches: (error) => String(error?.code || '').toUpperCase() === 'PERSISTENCE_FAILED',
    message: 'El archivo se generó, pero no pudo guardarse en la conversación. Puedes descargarlo ahora o reintentar.',
  },
  {
    code: 'validation_failed',
    retryable: false,
    matches: (error) => /validation/i.test(String(error?.code || '')),
    message: 'La solicitud o el resultado no superó la validación.',
  },
];

function classifyPublicStreamError(error) {
  const text = String(error?.message || error || '');
  const rule = RULES.find((candidate) => candidate.matches(error, text));
  return rule || {
    code: 'internal_error',
    retryable: false,
    message: 'La operación no pudo completarse.',
  };
}

function buildPublicStreamError(error, { req = null, surface = 'unknown', traceId = null } = {}) {
  const classification = classifyPublicStreamError(error);
  const requestId = getRequestId(req);
  const payload = {
    code: classification.code,
    message: classification.message,
    error: classification.message,
    retryable: classification.retryable,
    ...(requestId ? { requestId } : {}),
    ...(traceId ? { traceId: String(traceId) } : {}),
  };
  metrics.counter('siragpt_stream_failures_total', {
    surface: String(surface || 'unknown'),
    code: classification.code,
  });
  return payload;
}

function sanitizePublicStoppedReason(reason) {
  const value = String(reason || '').toLowerCase();
  if (/abort|cancel/.test(value)) return 'cancelled';
  if (/timeout|timed.?out|runtime_budget/.test(value)) return 'timeout';
  if (/max_(?:steps|iterations)|limit|budget_exhausted/.test(value)) return 'limit_reached';
  if (/tool_unavailable/.test(value)) return 'tool_unavailable';
  if (/error|failed|failure|provider|control_plane/.test(value)) return 'failed';
  return 'completed';
}

function sanitizePublicStreamEvent(value, context = {}, depth = 0) {
  if (depth > 6 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePublicStreamEvent(item, context, depth + 1));
  }
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'stoppedReason') {
      output[key] = sanitizePublicStoppedReason(entry);
      continue;
    }
    if ((key === 'error' || key === 'lastError') && entry) {
      const source = entry instanceof Error
        ? entry
        : new Error(typeof entry === 'string' ? entry : String(entry?.message || entry?.error || 'stream failure'));
      const publicError = buildPublicStreamError(source, context);
      output[key] = typeof entry === 'object' ? publicError : publicError.message;
      if (typeof entry !== 'object') output[`${key}Code`] = publicError.code;
      continue;
    }
    output[key] = sanitizePublicStreamEvent(entry, context, depth + 1);
  }
  return output;
}

module.exports = {
  buildPublicStreamError,
  classifyPublicStreamError,
  sanitizePublicStoppedReason,
  sanitizePublicStreamEvent,
};
