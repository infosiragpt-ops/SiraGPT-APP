'use strict';

const AUTH_MESSAGE = 'Fal.ai rechazo la autenticacion del servidor. Verifica que FAL_KEY en produccion sea una API key real de fal.ai con alcance API y acceso a modelos de video, luego reinicia el backend.';
const QUOTA_MESSAGE = 'Fal.ai rechazo la generacion por saldo, cuota o limite de uso. Revisa el balance, limites del equipo y acceso del modelo en fal.ai antes de reintentar.';
const VALIDATION_MESSAGE = 'Fal.ai rechazo los parametros del video. Cambia modelo, formato, duracion o resolucion e intenta de nuevo.';

function safeString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getFalErrorStatus(error) {
  const candidates = [
    error?.status,
    error?.statusCode,
    error?.response?.status,
    error?.body?.status,
    error?.body?.statusCode,
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;
  }
  return null;
}

function getFalErrorBody(error) {
  return error?.body || error?.response?.data || error?.data || null;
}

function classifyFalVideoError(error, { endpoint } = {}) {
  const status = getFalErrorStatus(error);
  const body = getFalErrorBody(error);
  const providerMessage = String(error?.message || body?.message || body?.error || 'Fal.ai video request failed');
  const haystack = `${providerMessage} ${safeString(body)}`.toLowerCase();

  if (status === 401 || status === 403 || /\bunauthori[sz]ed\b|forbidden|invalid api key|invalid key|api key|credentials?/.test(haystack)) {
    return {
      code: 'fal_auth_failed',
      message: AUTH_MESSAGE,
      providerMessage,
      statusCode: status || 401,
      retryable: false,
      body,
      endpoint,
    };
  }

  if (status === 429 || /quota|billing|balance|credit|insufficient|limit exceeded|rate limit|too many requests/.test(haystack)) {
    return {
      code: 'fal_quota_or_rate_limit',
      message: QUOTA_MESSAGE,
      providerMessage,
      statusCode: status || 429,
      retryable: false,
      body,
      endpoint,
    };
  }

  if (status === 400 || status === 422 || /validation|invalid input|invalid request|bad request|unsupported|required/.test(haystack)) {
    return {
      code: 'fal_invalid_video_request',
      message: VALIDATION_MESSAGE,
      providerMessage,
      statusCode: status || 422,
      retryable: false,
      body,
      endpoint,
    };
  }

  return {
    code: 'fal_video_provider_error',
    message: providerMessage || 'Fal.ai no pudo completar la generacion de video. Intenta de nuevo.',
    providerMessage,
    statusCode: status,
    retryable: !status || status >= 500,
    body,
    endpoint,
  };
}

module.exports = {
  AUTH_MESSAGE,
  QUOTA_MESSAGE,
  VALIDATION_MESSAGE,
  classifyFalVideoError,
  getFalErrorStatus,
};
