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

function classifyImageGenError(error) {
  const upstreamStatus = Number(error?.status || error?.statusCode) || null;
  const raw = String(error?.message || 'error desconocido');
  const isQuota = upstreamStatus === 429 || QUOTA_RE.test(raw);

  if (isQuota) {
    return {
      httpStatus: 429,
      code: 'image_quota_exceeded',
      message:
        'El proveedor de imágenes alcanzó su límite de cuota. Intenta de nuevo en un momento o elige otro proveedor/modelo (por ejemplo OpenAI).',
      isQuota: true,
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

module.exports = { classifyImageGenError, QUOTA_RE, MAX_MESSAGE_CHARS };
