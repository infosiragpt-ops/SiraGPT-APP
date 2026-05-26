'use strict';

/**
 * Bounded exponential backoff retry helper used by channel adapters for
 * outbound API calls. Retries on network errors and 429/5xx responses.
 *
 * `fn` receives `(attempt)` and must return `{ ok, status, body, retryAfterMs? }`
 * for HTTP-shaped operations, or throw to indicate a transport-level failure.
 * `retryAfterMs` is interpreted as milliseconds; date-form HTTP
 * `Retry-After` header values are also accepted for callers that receive
 * raw headers.
 */
async function retryWithBackoff(fn, {
  maxAttempts = 4,
  baseDelayMs = 200,
  maxDelayMs = 5_000,
  jitter = true,
  sleep = abortableSleep,
  signal,
  now = Date.now,
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal);
    try {
      const res = await fn(attempt);
      if (res && res.ok) return res;
      const retriable = res && (res.status === 429 || (res.status >= 500 && res.status < 600));
      if (!retriable || attempt === maxAttempts) return res;
      const wait = retryAfterDelay(res.retryAfterMs, maxDelayMs, now)
        ?? backoffDelay(attempt, baseDelayMs, maxDelayMs, jitter);
      await sleep(wait, signal);
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) throw err;
      throwIfAborted(signal);
      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, jitter), signal);
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('retryWithBackoff: exhausted attempts');
}

function backoffDelay(attempt, base, max, jitter) {
  const exp = Math.min(max, base * 2 ** (attempt - 1));
  if (!jitter) return exp;
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

function retryAfterDelay(retryAfterMs, maxDelayMs, now = Date.now) {
  if (retryAfterMs === undefined || retryAfterMs === null) return undefined;

  let delay;
  if (typeof retryAfterMs === 'string') {
    delay = Number(retryAfterMs);
    if (!Number.isFinite(delay)) delay = parseRetryAfterHeader(retryAfterMs, now);
  } else {
    delay = Number(retryAfterMs);
  }
  if (!Number.isFinite(delay) || delay < 0) return undefined;
  return Math.min(delay, maxDelayMs);
}

function parseRetryAfterHeader(header, now = Date.now) {
  if (header === undefined || header === null) return undefined;

  const value = String(header).trim();
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return undefined;
    return Math.ceil(seconds * 1000);
  }

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;

  const nowMs = typeof now === 'function' ? now() : now;
  const delay = dateMs - Number(nowMs);
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}

function abortError() {
  const err = new Error('retryWithBackoff aborted');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason || abortError();
  }
}

function abortableSleep(ms, signal) {
  throwIfAborted(signal);
  let onAbort;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || abortError());
    };

    signal?.addEventListener?.('abort', onAbort, { once: true });
  }).finally(() => {
    if (onAbort) signal?.removeEventListener?.('abort', onAbort);
  });
}

module.exports = {
  retryWithBackoff,
  backoffDelay,
  retryAfterDelay,
  parseRetryAfterHeader,
  abortableSleep,
};
