'use strict';

/**
 * Classify an image-generation/edit provider error into a clean, client-safe
 * shape. Prevents two prod problems seen in the image route:
 *  - quota/rate-limit errors (e.g. Gemini 429 RESOURCE_EXHAUSTED) were
 *    returned as HTTP 500 instead of 429;
 *  - the entire multi-KB raw provider JSON (error.message) was echoed to the
 *    client and persisted into chat messages.
 *
 * Returns { httpStatus, code, message, isQuota }. `message` is always a short,
 * human-readable string safe to show in the UI (never the raw provider blob).
 */
const QUOTA_RE = /RESOURCE_EXHAUSTED|exceeded your current quota|insufficient_quota|rate.?limit|too many requests|quota/i;
const MAX_MESSAGE_CHARS = 200;

// The image model's provider has no credit (a 402, «insufficient_quota»,
// «used all credits», «billing hard limit»…). 503, never the upstream 402:
// the user's own plan is fine — the provider behind the model is dry. The
// picked model is kept (owner policy) and the copy says so.
const IMAGE_NO_CREDIT_CODE = 'image_provider_no_credit';

function imageNoCreditMessage(modelLabel) {
  const label = String(modelLabel || '').trim();
  const who = label ? `${label} no pudo generar la imagen` : 'El modelo de imágenes elegido no pudo generar la imagen';
  return `${who}: su proveedor no tiene saldo ahora. No cambié de modelo; elige otro en Imágenes o inténtalo más tarde.`;
}

// The picked image model's provider could not render, for a cause the user
// can act on: its key was rejected, it forbids the model, it has no
// connection, or it is not responding. E_PROVIDER (a code the client already
// treats as the model's failure, never the user's session or plan), never the
// upstream 401/403: the user's own login is fine.
const IMAGE_CAUSE_COPY = Object.freeze({
  auth: 'su proveedor rechazó la clave de conexión',
  forbidden: 'su proveedor no permite usar este modelo ahora',
  unconfigured: 'su conexión no está configurada',
  unavailable: 'su proveedor no está respondiendo ahora',
  breaker: 'su proveedor no está respondiendo ahora',
});
const IMAGE_TAIL = 'No cambié de modelo; elige otro en Imágenes o inténtalo más tarde.';

function imageSubject(modelLabel) {
  const label = String(modelLabel || '').trim();
  return label ? `${label} no pudo generar la imagen` : 'El modelo de imágenes elegido no pudo generar la imagen';
}

function imageCauseMessage(modelLabel, cause) {
  const what = IMAGE_CAUSE_COPY[cause];
  return what ? `${imageSubject(modelLabel)}: ${what}. ${IMAGE_TAIL}` : null;
}

function imageRateLimitMessage(modelLabel, retryAfterSeconds) {
  const secs = Number(retryAfterSeconds);
  const wait = Number.isFinite(secs) && secs > 0
    ? `Espera ${Math.ceil(secs)} s y vuelve a intentarlo.`
    : 'Espera un momento y vuelve a intentarlo.';
  return `${imageSubject(modelLabel)}: su proveedor alcanzó su límite de cuota por minuto. ${wait} No cambié de modelo.`;
}

/** An attempt row ({error, status?}) as an Error-like object. */
function attemptError(attempt) {
  const text = String((attempt && (attempt.error || attempt.message)) || '');
  const leading = /^\s*(\d{3})\b/.exec(text);
  return {
    status: (attempt && (attempt.status || attempt.statusCode)) || (leading ? Number(leading[1]) : undefined),
    message: text,
  };
}

/**
 * Why the image model's provider could not render: 'billing' | 'auth' |
 * 'forbidden' | 'unconfigured' | 'unavailable' | 'breaker' | 'rate_limit' |
 * null. The error's own cause, else the one cause every failed attempt shares
 * (a mix is not a cause). Never throws.
 */
function imageFailureCause(error) {
  let bf;
  try { bf = require('./ai/billing-failover'); } catch (_) { return null; }
  const causeOf = (err) => {
    if (/\bapi key missing\b/i.test(String((err && err.message) || ''))) return 'unconfigured';
    try { return bf.failureCauseFor(err) || null; } catch (_) { return null; }
  };
  if (isImageBillingError(error)) return 'billing';
  const attempts = (Array.isArray(error?.attempts) ? error.attempts : [])
    .filter((a) => a && a.ok !== true && !/^aborted$/i.test(String(a.error || '').trim()));
  if (attempts.length > 0) {
    const causes = new Set(attempts.map((a) => causeOf(attemptError(a))));
    if (causes.size === 1) {
      const only = [...causes][0];
      if (only) return only;
    }
    return null;
  }
  return error ? causeOf(error) : null;
}

function imageRetryAfterSeconds(error) {
  let bf;
  try { bf = require('./ai/billing-failover'); } catch (_) { return null; }
  const candidates = [error, ...(Array.isArray(error?.attempts) ? error.attempts.map(attemptError) : [])];
  for (const candidate of candidates) {
    try {
      const ms = candidate ? bf.retryAfterMs(candidate) : null;
      if (Number.isFinite(ms) && ms > 0) return Math.max(1, Math.ceil(ms / 1000));
    } catch (_) { /* next */ }
  }
  return null;
}

function isImageBillingError(error) {
  let bf;
  try { bf = require('./ai/billing-failover'); } catch (_) { return false; }
  const isBilling = (err) => {
    try { return bf.failureCauseFor(err) === 'billing'; } catch (_) { return false; }
  };
  if (error && isBilling(error)) return true;
  const attempts = Array.isArray(error?.attempts) ? error.attempts : [];
  return attempts.length > 0 && attempts.every((attempt) => isBilling({
    status: attempt && (attempt.status || attempt.statusCode),
    message: String((attempt && (attempt.error || attempt.message)) || ''),
  }));
}

function classifyImageGenError(error, { modelLabel = '' } = {}) {
  const upstreamStatus = Number(error?.status || error?.statusCode) || null;
  const raw = String(error?.message || 'error desconocido');
  const cause = imageFailureCause(error);
  if (cause === 'billing') {
    return {
      httpStatus: 503,
      code: IMAGE_NO_CREDIT_CODE,
      message: imageNoCreditMessage(modelLabel),
      isQuota: false,
      billing: true,
      // Re-asking a provider without balance cannot succeed.
      retryable: false,
      failureReason: 'billing',
    };
  }
  if (cause && IMAGE_CAUSE_COPY[cause]) {
    const terminal = cause === 'auth' || cause === 'forbidden' || cause === 'unconfigured';
    return {
      httpStatus: 502,
      code: 'E_PROVIDER',
      message: imageCauseMessage(modelLabel, cause),
      isQuota: false,
      ...(terminal ? { retryable: false } : {}),
      failureReason: cause === 'breaker' ? 'unavailable' : cause,
    };
  }
  const isQuota = cause === 'rate_limit' || upstreamStatus === 429 || QUOTA_RE.test(raw) || (error?.attempts || []).some((attempt) => QUOTA_RE.test(String(attempt.error || '')));

  if (isQuota) {
    const retryAfterSeconds = imageRetryAfterSeconds(error);
    const named = String(modelLabel || '').trim() || retryAfterSeconds;
    return {
      httpStatus: 429,
      code: 'image_quota_exceeded',
      message: named
        ? imageRateLimitMessage(modelLabel, retryAfterSeconds)
        : 'El modelo de imágenes alcanzó su límite de cuota. Intenta de nuevo en un momento o elige otro modelo.',
      isQuota: true,
      failureReason: 'rate_limit',
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }

  if (['E_PARAMS', 'E_PROVIDER', 'image_source_required', 'image_edit_unsupported'].includes(error?.code)) {
    return {
      httpStatus: error.code === 'E_PROVIDER' ? 502 : (upstreamStatus || 400),
      code: error.code,
      message: error.code === 'E_PROVIDER'
        ? `${imageSubject(modelLabel)}. Reintenta o elige otro modelo.`
        : raw.slice(0, MAX_MESSAGE_CHARS),
      isQuota: false,
    };
  }

  return {
    httpStatus: upstreamStatus && upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : 500,
    code: 'image_generation_failed',
    // Truncate so we never leak the full provider JSON blob.
    message: raw.length > MAX_MESSAGE_CHARS ? `${raw.slice(0, MAX_MESSAGE_CHARS)}…` : raw,
    isQuota: false,
  };
}

module.exports = {
  classifyImageGenError,
  isImageBillingError,
  imageFailureCause,
  imageCauseMessage,
  imageRateLimitMessage,
  imageNoCreditMessage,
  IMAGE_NO_CREDIT_CODE,
  QUOTA_RE,
  MAX_MESSAGE_CHARS,
};
