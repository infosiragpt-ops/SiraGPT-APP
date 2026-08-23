'use strict';

/**
 * Structured /code workspace errors.
 *
 * Every failure the /code bootstrap can surface is classified here so the
 * UI never receives a bare unknown as its only message. Codes, retryability,
 * stage, and user-vs-internal copy stay stable across HTTP and the client
 * state machine.
 */

const WORKSPACE_ERROR_CODES = Object.freeze({
  SESSION_REFRESH_REQUIRED: 'SESSION_REFRESH_REQUIRED',
  CLIENT_BUILD_MISMATCH: 'CLIENT_BUILD_MISMATCH',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  WORKSPACE_PROVISIONING: 'WORKSPACE_PROVISIONING',
  WORKSPACE_MOUNT_FAILED: 'WORKSPACE_MOUNT_FAILED',
  WORKSPACE_START_FAILED: 'WORKSPACE_START_FAILED',
  WORKSPACE_HEALTH_FAILED: 'WORKSPACE_HEALTH_FAILED',
  WORKSPACE_CONNECT_FAILED: 'WORKSPACE_CONNECT_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  TRANSIENT_UNAVAILABLE: 'TRANSIENT_UNAVAILABLE',
  CAPACITY_FULL: 'CAPACITY_FULL',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_REQUEST: 'INVALID_REQUEST',
  CHUNK_LOAD_ERROR: 'CHUNK_LOAD_ERROR',
  UNKNOWN: 'UNKNOWN',
});

const WORKSPACE_STAGES = Object.freeze({
  RESOLVING_SESSION: 'RESOLVING_SESSION',
  REQUESTING_WORKSPACE: 'REQUESTING_WORKSPACE',
  PROVISIONING: 'PROVISIONING',
  MOUNTING: 'MOUNTING',
  STARTING: 'STARTING',
  CHECKING_HEALTH: 'CHECKING_HEALTH',
  CONNECTING: 'CONNECTING',
  READY: 'READY',
  RECONNECTING: 'RECONNECTING',
  DEGRADED: 'DEGRADED',
});

const SEVERITY = Object.freeze({
  info: 'info',
  warning: 'warning',
  error: 'error',
  fatal: 'fatal',
});

const USER_MESSAGES = Object.freeze({
  [WORKSPACE_ERROR_CODES.SESSION_REFRESH_REQUIRED]:
    'Tu sesión caducó. Reintentar refresca el acceso sin perder el chat.',
  [WORKSPACE_ERROR_CODES.CLIENT_BUILD_MISMATCH]:
    'Hay una versión nueva de SiraGPT. Recargamos el espacio una vez para alinearla.',
  [WORKSPACE_ERROR_CODES.WORKSPACE_NOT_FOUND]:
    'Este espacio ya no está disponible. Puedes abrir /code y elegir otro.',
  [WORKSPACE_ERROR_CODES.WORKSPACE_PROVISIONING]:
    'Estamos preparando tu espacio. El chat y los archivos no se tocan.',
  [WORKSPACE_ERROR_CODES.WORKSPACE_MOUNT_FAILED]:
    'No se pudo montar el espacio. Reintentar reutiliza el mismo workspace.',
  [WORKSPACE_ERROR_CODES.WORKSPACE_START_FAILED]:
    'El runtime no arrancó. Reintentar no crea un runtime duplicado.',
  [WORKSPACE_ERROR_CODES.WORKSPACE_HEALTH_FAILED]:
    'El espacio no respondió al chequeo de salud. Reintentamos en automático.',
  [WORKSPACE_ERROR_CODES.WORKSPACE_CONNECT_FAILED]:
    'No se pudo conectar al espacio. El chat no se ve afectado.',
  [WORKSPACE_ERROR_CODES.RATE_LIMITED]:
    'Demasiados intentos seguidos. Esperamos un momento y reintentamos.',
  [WORKSPACE_ERROR_CODES.TIMEOUT]:
    'El espacio tardó demasiado en responder. Reintentamos con la misma clave.',
  [WORKSPACE_ERROR_CODES.TRANSIENT_UNAVAILABLE]:
    'El espacio está ocupado o en mantenimiento breve. Reintentamos en automático.',
  [WORKSPACE_ERROR_CODES.CAPACITY_FULL]:
    'No hay capacidad libre ahora. Reintentamos sin crear otro runtime.',
  [WORKSPACE_ERROR_CODES.FORBIDDEN]:
    'No tienes permiso para este espacio. El chat no se ve afectado.',
  [WORKSPACE_ERROR_CODES.INVALID_REQUEST]:
    'La petición del espacio no es válida. Vuelve a /code o al chat.',
  [WORKSPACE_ERROR_CODES.CHUNK_LOAD_ERROR]:
    'El navegador cargó archivos de una versión anterior. Recargamos una vez.',
  [WORKSPACE_ERROR_CODES.UNKNOWN]:
    'No se pudo cargar el espacio de código. Reintentar remonta el workspace. El chat no se ve afectado.',
});

const RETRYABLE_CODES = new Set([
  WORKSPACE_ERROR_CODES.SESSION_REFRESH_REQUIRED,
  WORKSPACE_ERROR_CODES.CLIENT_BUILD_MISMATCH,
  WORKSPACE_ERROR_CODES.WORKSPACE_PROVISIONING,
  WORKSPACE_ERROR_CODES.WORKSPACE_HEALTH_FAILED,
  WORKSPACE_ERROR_CODES.WORKSPACE_CONNECT_FAILED,
  WORKSPACE_ERROR_CODES.RATE_LIMITED,
  WORKSPACE_ERROR_CODES.TIMEOUT,
  WORKSPACE_ERROR_CODES.TRANSIENT_UNAVAILABLE,
  WORKSPACE_ERROR_CODES.CAPACITY_FULL,
  WORKSPACE_ERROR_CODES.CHUNK_LOAD_ERROR,
]);

const HTTP_STATUS_BY_CODE = Object.freeze({
  [WORKSPACE_ERROR_CODES.SESSION_REFRESH_REQUIRED]: 401,
  [WORKSPACE_ERROR_CODES.CLIENT_BUILD_MISMATCH]: 409,
  [WORKSPACE_ERROR_CODES.WORKSPACE_NOT_FOUND]: 404,
  [WORKSPACE_ERROR_CODES.WORKSPACE_PROVISIONING]: 202,
  [WORKSPACE_ERROR_CODES.WORKSPACE_MOUNT_FAILED]: 422,
  [WORKSPACE_ERROR_CODES.WORKSPACE_START_FAILED]: 422,
  [WORKSPACE_ERROR_CODES.WORKSPACE_HEALTH_FAILED]: 503,
  [WORKSPACE_ERROR_CODES.WORKSPACE_CONNECT_FAILED]: 503,
  [WORKSPACE_ERROR_CODES.RATE_LIMITED]: 429,
  [WORKSPACE_ERROR_CODES.TIMEOUT]: 408,
  [WORKSPACE_ERROR_CODES.TRANSIENT_UNAVAILABLE]: 503,
  [WORKSPACE_ERROR_CODES.CAPACITY_FULL]: 503,
  [WORKSPACE_ERROR_CODES.FORBIDDEN]: 403,
  [WORKSPACE_ERROR_CODES.INVALID_REQUEST]: 422,
  [WORKSPACE_ERROR_CODES.CHUNK_LOAD_ERROR]: 409,
  [WORKSPACE_ERROR_CODES.UNKNOWN]: 500,
});

function firstString(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return firstString(value[0], fallback);
  return fallback;
}

function normalizeCode(value) {
  const raw = firstString(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
  return Object.prototype.hasOwnProperty.call(WORKSPACE_ERROR_CODES, raw)
    ? WORKSPACE_ERROR_CODES[raw]
    : '';
}

function normalizeStage(value, fallback = WORKSPACE_STAGES.REQUESTING_WORKSPACE) {
  const raw = firstString(value).trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(WORKSPACE_STAGES, raw)
    ? WORKSPACE_STAGES[raw]
    : fallback;
}

function normalizeSeverity(value, fallback = SEVERITY.error) {
  const raw = firstString(value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SEVERITY, raw) ? raw : fallback;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function codeFromStatus(status, fallback = WORKSPACE_ERROR_CODES.UNKNOWN) {
  if (status === 401) return WORKSPACE_ERROR_CODES.SESSION_REFRESH_REQUIRED;
  if (status === 403) return WORKSPACE_ERROR_CODES.FORBIDDEN;
  if (status === 404) return WORKSPACE_ERROR_CODES.WORKSPACE_NOT_FOUND;
  if (status === 408) return WORKSPACE_ERROR_CODES.TIMEOUT;
  if (status === 409) return WORKSPACE_ERROR_CODES.CLIENT_BUILD_MISMATCH;
  if (status === 422 || status === 400) return WORKSPACE_ERROR_CODES.INVALID_REQUEST;
  if (status === 429) return WORKSPACE_ERROR_CODES.RATE_LIMITED;
  if (status === 202) return WORKSPACE_ERROR_CODES.WORKSPACE_PROVISIONING;
  if (status === 503) return WORKSPACE_ERROR_CODES.TRANSIENT_UNAVAILABLE;
  if (status >= 500) return WORKSPACE_ERROR_CODES.TRANSIENT_UNAVAILABLE;
  return fallback;
}

function looksLikeChunkLoad(error) {
  const name = firstString(error && error.name);
  const message = firstString(error && error.message);
  const digest = firstString(error && error.digest);
  const haystack = `${name} ${message} ${digest}`;
  return (
    name === 'ChunkLoadError'
    || /ChunkLoadError|Loading chunk \S+ failed|Failed to fetch dynamically imported module|Loading CSS chunk/i.test(haystack)
  );
}

function looksLikeNetwork(error) {
  const message = firstString(error && error.message);
  const code = firstString(error && error.code);
  return (
    error instanceof TypeError
    || /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(`${code} ${message}`)
  );
}

function classifyWorkspaceError(error, extras = {}) {
  if (error && error.code && WORKSPACE_ERROR_CODES[error.code] && error.userMessage) {
    return error;
  }

  const status = Number(extras.status ?? error?.status ?? error?.statusCode);
  const explicit = normalizeCode(extras.code || error?.code || error?.body?.code || error?.body?.error);
  const stage = normalizeStage(extras.stage || error?.stage, WORKSPACE_STAGES.REQUESTING_WORKSPACE);
  const traceId = firstString(extras.traceId || error?.traceId || error?.requestId || extras.requestId);

  let code = explicit || WORKSPACE_ERROR_CODES.UNKNOWN;
  if (looksLikeChunkLoad(error)) code = WORKSPACE_ERROR_CODES.CHUNK_LOAD_ERROR;
  else if (code === WORKSPACE_ERROR_CODES.UNKNOWN && Number.isFinite(status) && status > 0) {
    code = codeFromStatus(status);
  } else if (code === WORKSPACE_ERROR_CODES.UNKNOWN && looksLikeNetwork(error)) {
    code = WORKSPACE_ERROR_CODES.TRANSIENT_UNAVAILABLE;
  } else if (code === WORKSPACE_ERROR_CODES.UNKNOWN && /timeout|timed out|aborted/i.test(firstString(error?.message))) {
    code = WORKSPACE_ERROR_CODES.TIMEOUT;
  }

  if (firstString(error?.code) === 'capacity_full') code = WORKSPACE_ERROR_CODES.CAPACITY_FULL;
  if (firstString(error?.code) === 'disabled') code = WORKSPACE_ERROR_CODES.TRANSIENT_UNAVAILABLE;

  const retryable = extras.retryable != null
    ? Boolean(extras.retryable)
    : (RETRYABLE_CODES.has(code) || isRetryableStatus(status));

  const severity = normalizeSeverity(
    extras.severity,
    retryable ? SEVERITY.warning : SEVERITY.error,
  );

  const internalMessage = firstString(
    extras.internalMessage || error?.internalMessage || error?.message || error?.stack,
    'unclassified workspace error',
  ).slice(0, 500);

  return buildWorkspaceError({
    code,
    stage,
    retryable,
    severity,
    traceId,
    userMessage: extras.userMessage || USER_MESSAGES[code] || USER_MESSAGES[WORKSPACE_ERROR_CODES.UNKNOWN],
    internalMessage,
    retryAfterMs: extras.retryAfterMs ?? error?.retryAfterMs,
    progress: extras.progress ?? error?.progress,
    status: Number.isFinite(status) && status > 0 ? status : HTTP_STATUS_BY_CODE[code],
  });
}

function buildWorkspaceError({
  code,
  stage = WORKSPACE_STAGES.REQUESTING_WORKSPACE,
  retryable,
  severity = SEVERITY.error,
  traceId = '',
  userMessage,
  internalMessage,
  retryAfterMs = null,
  progress = null,
  status,
} = {}) {
  const normalized = normalizeCode(code) || WORKSPACE_ERROR_CODES.UNKNOWN;
  const payload = {
    ok: false,
    code: normalized,
    retryable: retryable != null ? Boolean(retryable) : RETRYABLE_CODES.has(normalized),
    stage: normalizeStage(stage),
    severity: normalizeSeverity(severity),
    traceId: firstString(traceId),
    userMessage: firstString(userMessage, USER_MESSAGES[normalized]),
    internalMessage: firstString(internalMessage, normalized).slice(0, 500),
    retryAfterMs: Number.isFinite(Number(retryAfterMs)) ? Math.max(0, Number(retryAfterMs)) : null,
    progress: progress && typeof progress === 'object' ? progress : null,
    status: Number.isFinite(Number(status)) ? Number(status) : HTTP_STATUS_BY_CODE[normalized],
  };
  return payload;
}

function toPublicEnsureError(payload) {
  return {
    ok: false,
    code: payload.code,
    retryable: payload.retryable,
    stage: payload.stage,
    severity: payload.severity,
    traceId: payload.traceId,
    userMessage: payload.userMessage,
    retryAfterMs: payload.retryAfterMs,
    progress: payload.progress,
  };
}

function resolveServerBuildId(env = process.env) {
  const candidates = [
    env.NEXT_PUBLIC_BUILD_ID,
    env.GIT_COMMIT,
    env.SOURCE_COMMIT,
    env.COMMIT_SHA,
    env.VERCEL_GIT_COMMIT_SHA,
  ];
  for (const candidate of candidates) {
    const normalized = firstString(candidate).trim();
    if (normalized && normalized !== 'unknown') return normalized;
  }
  return '';
}

function buildsMismatch(clientBuild, serverBuild) {
  const client = firstString(clientBuild).trim();
  const server = firstString(serverBuild).trim();
  if (!client || !server) return false;
  if (client === 'unknown' || server === 'unknown') return false;
  return client !== server;
}

module.exports = {
  WORKSPACE_ERROR_CODES,
  WORKSPACE_STAGES,
  SEVERITY,
  USER_MESSAGES,
  RETRYABLE_CODES,
  HTTP_STATUS_BY_CODE,
  classifyWorkspaceError,
  buildWorkspaceError,
  toPublicEnsureError,
  resolveServerBuildId,
  buildsMismatch,
  normalizeStage,
  normalizeCode,
  isRetryableStatus,
};
