'use strict';

/**
 * Harness error type. Every adapter turns transport / HTTP failures into a
 * HarnessProviderError so the loop can decide, in ONE place, whether a turn
 * is worth retrying (429, 5xx, 529 overloaded, dropped connections) or must
 * surface immediately (400 bad request, 401/403 auth, 404 unknown model).
 */

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

class HarnessProviderError extends Error {
  constructor(message, { status = null, code = null, provider = null, retryable = null, retryAfterMs = null, body = null, cause = null } = {}) {
    super(message);
    this.name = 'HarnessProviderError';
    this.status = status;
    this.code = code;
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
    this.body = body;
    if (cause) this.cause = cause;
    this.retryable = retryable != null ? Boolean(retryable) : (status != null && RETRYABLE_STATUS.has(Number(status)));
  }
}

function parseRetryAfter(headers) {
  if (!headers) return null;
  const get = (name) => (typeof headers.get === 'function' ? headers.get(name) : headers[name]);
  const rawMs = get('retry-after-ms');
  const ms = rawMs == null || rawMs === '' ? NaN : Number(rawMs);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const raw = get('retry-after');
  if (raw == null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function isAbortError(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 'HARNESS_ABORTED');
}

/** Normalize anything thrown during a model call into a HarnessProviderError. */
function toProviderError(err, provider) {
  if (err instanceof HarnessProviderError) return err;
  if (isAbortError(err)) return err;
  const code = err && (err.code || (err.cause && err.cause.code));
  const networkish = RETRYABLE_NETWORK_CODES.has(code) || /fetch failed|socket hang up|network|terminated/i.test(String(err && err.message));
  return new HarnessProviderError(String((err && err.message) || err || 'provider_error'), {
    provider,
    code: code || null,
    retryable: networkish,
    cause: err,
  });
}

/** Build an error from a non-2xx fetch Response (reads the body once). */
async function errorFromResponse(res, provider) {
  let text = '';
  try { text = await res.text(); } catch (_) { /* ignore */ }
  let message = text;
  try {
    const json = JSON.parse(text);
    message = (json && (json.error && (json.error.message || json.error)) ) || json.message || text;
    if (typeof message !== 'string') message = JSON.stringify(message);
  } catch (_) { /* plain text body */ }
  return new HarnessProviderError(`${provider} HTTP ${res.status}: ${String(message || res.statusText || '').slice(0, 600)}`, {
    status: res.status,
    provider,
    retryAfterMs: parseRetryAfter(res.headers),
    body: text.slice(0, 4000),
  });
}

function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  err.code = 'HARNESS_ABORTED';
  return err;
}

module.exports = {
  HarnessProviderError,
  RETRYABLE_STATUS,
  parseRetryAfter,
  isAbortError,
  toProviderError,
  errorFromResponse,
  abortError,
};
