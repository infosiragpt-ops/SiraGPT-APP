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
  { code: 'path_root_mnt', message: 'No escribo en /root, /mnt ni /media.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'path_root_mnt' },
  { code: 'proto_pollution', message: 'La solicitud contiene claves reservadas no permitidas.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'proto_pollution' },
  { code: 'resource_gone', message: 'El recurso ya no esta disponible (410). No reintento.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'resource_gone' || Number(error && error.status) === 410 },
  { code: 'subagent_same_tool', message: 'Un subagente no puede reutilizar la misma herramienta del padre.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'subagent_same_tool' },
  { code: 'path_var_log', message: 'No escribo en /var/log, /var/run ni /run.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'path_var_log' },
  { code: 'request_timeout', message: 'La peticion expiro (408). No reintento.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'request_timeout' || Number(error && error.status) === 408 },
  { code: 'tool_name_dot', message: 'El nombre de la herramienta no puede terminar con un punto.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_name_dot' },
  { code: 'sandbox_cwd_root', message: 'El sandbox no puede usar / o /root como directorio de trabajo.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sandbox_cwd_root' },
  { code: 'path_opt', message: 'No escribo en /opt.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'path_opt' },
  { code: 'unauthorized', message: 'No autorizado (401). No reintento.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'unauthorized' || Number(error && error.status) === 401 },
  { code: 'tool_name_slash', message: 'El nombre de la herramienta no puede contener una barra.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_name_slash' },
  { code: 'sandbox_uid_zero', message: 'El sandbox no puede ejecutarse como uid 0.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sandbox_uid_zero' },
  { code: 'path_etc', message: 'No escribo en /etc.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'path_etc' },
  { code: 'forbidden', message: 'Prohibido (403). No reintento.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'forbidden' || Number(error && error.status) === 403 },
  { code: 'tool_name_colon', message: 'El nombre de la herramienta no puede contener dos puntos.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_name_colon' },
  { code: 'sandbox_gid_zero', message: 'El sandbox no puede ejecutarse como gid 0.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sandbox_gid_zero' },
  { code: 'sandbox_privileged', message: 'El sandbox no puede ejecutarse en modo privilegiado.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sandbox_privileged' },
  { code: 'path_sys', message: 'No escribo en /sys.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'path_sys' },
  { code: 'conflict', message: 'Conflicto (409). No reintento.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'conflict' || Number(error && error.status) === 409 },
  { code: 'tool_name_at', message: 'El nombre de la herramienta no puede contener arroba.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'tool_name_at' },
  { code: 'sandbox_pid_host', message: 'El sandbox no puede usar pid=host.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sandbox_pid_host' },
  { code: 'sandbox_userns_host', message: 'El sandbox no puede usar userns=host.', matches: (error, text) => String(error && error.code || '').toLowerCase() === 'sandbox_userns_host' },
  { code: 'credits_exhausted', retryable: false, matches: (error, text) => Number(error && error.status) === 402 || /llm_402|credits?_exhausted|insufficient (credits|balance)|quota_exhausted|credit_no_usage|credit_ceiling/i.test(String(text || '')) || ['llm_402', 'credit_no_usage', 'credit_ceiling', 'credits_exhausted'].includes(String(error && error.code || '').toLowerCase()), message: 'No quedan creditos suficientes para esta operacion. No cobre el fallo.' },
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
