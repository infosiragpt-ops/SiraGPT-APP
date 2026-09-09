'use strict';

/**
 * Complete an /api/ai/generate SSE response after a provider 4xx/5xx.
 * Caddy turns an unterminated event-stream (headers flushed, no [DONE]/end)
 * into HTTP 502. Always write a typed error frame + [DONE], then end().
 */

const { CONNECTION_UNAVAILABLE_MESSAGE } = require('./provider-inference');

const VENDOR_LEAK_RE = /deepseek|openrouter|sk-|Bearer\s|AKIA|BEGIN (RSA|OPENSSH|PRIVATE)/i;

function publicGenerateErrorMessage(err) {
  const raw = String((err && (err.message || err.error || err.code)) || '').trim();
  if (!raw) return CONNECTION_UNAVAILABLE_MESSAGE;
  if (VENDOR_LEAK_RE.test(raw)) return CONNECTION_UNAVAILABLE_MESSAGE;
  if (/unknown parameter/i.test(raw)) return CONNECTION_UNAVAILABLE_MESSAGE;
  if (/connection_unavailable/i.test(raw)) return CONNECTION_UNAVAILABLE_MESSAGE;
  // Already-localized Spanish copy (á/é/í/ó/ú/ñ/¿/¡). Never pass English SDK text.
  if (raw.length < 200 && !/^https?:/i.test(raw) && /[áéíóúñ¿¡]/i.test(raw)) {
    return raw;
  }
  return CONNECTION_UNAVAILABLE_MESSAGE;
}

function isProviderClientError(err) {
  if (!err || typeof err !== 'object') return false;
  const status = Number(err.status || err.statusCode || (err.response && err.response.status));
  if (Number.isFinite(status) && status >= 400) return true;
  const msg = String(err.message || err.error || '');
  return /unknown parameter|invalid_request|invalid parameter/i.test(msg);
}

function rawWrite(res, frame) {
  if (!res) return false;
  const write = typeof res._siraRawWrite === 'function' ? res._siraRawWrite : res.write;
  if (typeof write !== 'function') return false;
  try {
    write.call(res, frame);
    return true;
  } catch {
    return false;
  }
}

// Closed vocabulary: no SDK messages, model names, URLs or credentials in SSE.
function generateStreamFailure(err) {
  const status = Number(err?.status || err?.statusCode);
  if (err?.code === 'ETIMEDOUT' || err?.code === 'TIMEOUT' || err?.name === 'TimeoutError' || status === 408) {
    return { code: 'E_TIMEOUT', message: 'El modelo tardó demasiado en responder. Puedes reintentar; no se cambió el modelo.' };
  }
  if (status === 429 || status === 402) {
    return { code: 'E_QUOTA', message: 'El modelo alcanzó su límite de uso. Espera unos instantes o revisa la conexión en Administración.' };
  }
  if (status === 401 || status === 403) {
    return { code: 'E_PROVIDER', message: 'La conexión del modelo necesita revisión en Administración. No se cambió el modelo.' };
  }
  if (status === 400 || status === 422) {
    return { code: 'E_PARAMS', message: 'El modelo no pudo procesar la solicitud. Reintenta o revisa su configuración en Administración.' };
  }
  return { code: 'E_PROVIDER', message: 'El modelo no pudo completar la respuesta. Puedes reintentar; no se cambió el modelo.' };
}

function writeGenerateSseError(res, {
  message,
  code = 'connection_unavailable',
  recovered = false,
  deferDone = false,
} = {}) {
  const text = String(message || CONNECTION_UNAVAILABLE_MESSAGE).trim() || CONNECTION_UNAVAILABLE_MESSAGE;
  const payload = {
    type: 'error',
    error: text,
    code,
    message: text,
    recovered: recovered === true,
  };
  rawWrite(res, `data: ${JSON.stringify(payload)}\n\n`);
  if (!recovered) {
    rawWrite(res, `data: ${JSON.stringify({ type: 'text_delta', content: text })}\n\n`);
  }
  if (!deferDone) rawWrite(res, 'data: [DONE]\n\n');
  return payload;
}

function endGenerateSse(res) {
  if (!res || res.writableEnded || res.destroyed) return false;
  const end = typeof res._siraRawEnd === 'function' ? res._siraRawEnd : res.end;
  if (typeof end !== 'function') return false;
  try {
    end.call(res);
    return true;
  } catch {
    return false;
  }
}

function closeGenerateSseWithError(res, opts) {
  const payload = writeGenerateSseError(res, opts);
  endGenerateSse(res);
  if (res && typeof res === 'object') res._siraGenerateSseClosed = true;
  return payload;
}

module.exports = {
  CONNECTION_UNAVAILABLE_MESSAGE,
  publicGenerateErrorMessage,
  generateStreamFailure,
  isProviderClientError,
  writeGenerateSseError,
  endGenerateSse,
  closeGenerateSseWithError,
};
