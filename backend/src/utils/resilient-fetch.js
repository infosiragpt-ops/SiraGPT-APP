'use strict';

/**
 * resilient-fetch — composes prior reliability primitives into a
 * single outbound-HTTP entry point: jittered backoff (#15) ×
 * deadline-aware retry (#39) × W3C trace-context injection (#20).
 * Designed for provider / MCP / internal HTTP calls where every one
 * of these three concerns matters.
 *
 * The wrapper is intentionally small: it does NOT replace fetch; it
 * wraps a `fetch` you pass in (so tests can inject their own mock
 * and the runtime stays Node-version-agnostic). Default `fetch` is
 * `globalThis.fetch`.
 *
 * Public API:
 *   const r = createResilientFetch({
 *     fetch,                       // default globalThis.fetch
 *     deadlineMs   = 30_000,
 *     maxAttempts  = 4,
 *     backoff,                     // { next({attempt, retryAfter, now}) }
 *     traceContext,                // { traceId, spanId, flags } | null
 *     isRetryable,                 // (resOrErr) => bool
 *     headers,                     // extra default headers
 *   })
 *   await r.send(url, init)        → Response
 *   await r.json(url, init)        → parsed body | throws
 *
 * Retryable defaults: network errors (TypeError fetch failed), HTTP
 * status 408 / 425 / 429 / 5xx. Honor server Retry-After header on
 * the next backoff.
 */

const { runWithDeadlineRetry } = require('../services/ai-product-os/deadline-retry');
const { createJitteredBackoff, parseRetryAfter } = require('../services/ai-product-os/jittered-backoff');
const { injectHeaders } = require('../services/observability/trace-context');

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isRetryableResponse(res) {
  return res && DEFAULT_RETRY_STATUSES.has(Number(res.status));
}

function isRetryableError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  if (err.code && /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH/.test(err.code)) return true;
  // node:fetch wraps low-level errors as TypeError
  if (err.name === 'TypeError' && /fetch failed/.test(err.message || '')) return true;
  return false;
}

function createResilientFetch(opts = {}) {
  const fetchFn = typeof opts.fetch === 'function' ? opts.fetch : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!fetchFn) throw new TypeError('resilient-fetch: no fetch implementation available');
  const deadlineMs = Number.isFinite(opts.deadlineMs) && opts.deadlineMs > 0 ? Math.floor(opts.deadlineMs) : DEFAULT_DEADLINE_MS;
  const maxAttempts = Number.isFinite(opts.maxAttempts) && opts.maxAttempts > 0 ? Math.floor(opts.maxAttempts) : DEFAULT_MAX_ATTEMPTS;
  const backoff = opts.backoff && typeof opts.backoff.next === 'function'
    ? opts.backoff
    : createJitteredBackoff({ baseMs: 200, maxMs: 5000, strategy: 'full' });
  const traceContext = opts.traceContext || null;
  const headers = opts.headers && typeof opts.headers === 'object' ? { ...opts.headers } : null;
  const isRetryable = typeof opts.isRetryable === 'function' ? opts.isRetryable : null;

  function evalRetryable(resOrErr) {
    if (isRetryable) return Boolean(isRetryable(resOrErr));
    if (resOrErr instanceof Error) {
      if (resOrErr.retryable === true) return true;
      if (resOrErr.retryable === false) return false;
      const status = Number(resOrErr.status || 0);
      if (status >= 500 || [408, 425, 429].includes(status)) return true;
      return isRetryableError(resOrErr);
    }
    return isRetryableResponse(resOrErr);
  }

  function buildHeaders(initHeaders) {
    const h = { ...(headers || {}), ...(initHeaders || {}) };
    if (traceContext) injectHeaders(h, traceContext);
    return h;
  }

  function send(url, init = {}) {
    const finalHeaders = buildHeaders(init.headers);
    const finalInit = { ...init, headers: finalHeaders };
    let lastRes = null;
    return runWithDeadlineRetry({
      run: async (_attempt, signal) => {
        const mergedSignal = signal && finalInit.signal && signal !== finalInit.signal
          ? mergeSignals(finalInit.signal, signal)
          : null;
        const merged = signal
          ? { ...finalInit, signal: mergedSignal ? mergedSignal.signal : signal }
          : finalInit;
        let res;
        try {
          res = await fetchFn(url, merged);
        } finally {
          if (mergedSignal) mergedSignal.cleanup();
        }
        if (evalRetryable(res)) {
          // Surface as a retryable error carrying retry-After hint.
          const e = new Error(`http ${res.status}`);
          e.retryable = true;
          e.status = res.status;
          const ra = res.headers && (res.headers.get ? res.headers.get('retry-after') : res.headers['retry-after']);
          if (ra != null) {
            const ms = parseRetryAfter(ra);
            if (ms != null) e.retryAfter = ms / 1000;
          }
          lastRes = res;
          throw e;
        }
        return res;
      },
      isRetryable: evalRetryable,
      deadlineMs,
      maxAttempts,
      backoff,
      signal: finalInit.signal,
    }).then(({ value }) => value).catch((err) => {
      // If we eventually exhausted on a retryable HTTP response, hand
      // back the last response — caller decides what to do with a
      // 503 instead of a synthetic deadline error.
      if (err && err.name === 'DeadlineExceededError' && lastRes) return lastRes;
      throw err;
    });
  }

  async function json(url, init = {}) {
    const res = await send(url, init);
    if (!res || typeof res.json !== 'function') {
      throw new Error('resilient-fetch: response has no .json()');
    }
    return res.json();
  }

  return { send, json, evalRetryable };
}

function mergeSignals(a, b) {
  if (!a) return { signal: b, cleanup: () => {} };
  if (!b) return { signal: a, cleanup: () => {} };
  const ctrl = new AbortController();
  const added = [];
  const onAbort = (signal) => () => { try { ctrl.abort(signal.reason); } catch { /* swallow */ } };
  if (a.aborted) ctrl.abort(a.reason);
  else {
    const listener = onAbort(a);
    a.addEventListener('abort', listener, { once: true });
    added.push([a, listener]);
  }
  if (b.aborted) ctrl.abort(b.reason);
  else {
    const listener = onAbort(b);
    b.addEventListener('abort', listener, { once: true });
    added.push([b, listener]);
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      for (const [signal, listener] of added) {
        try { signal.removeEventListener('abort', listener); } catch { /* swallow */ }
      }
      added.length = 0;
    },
  };
}

module.exports = {
  createResilientFetch,
  isRetryableResponse,
  isRetryableError,
  DEFAULT_RETRY_STATUSES,
};
