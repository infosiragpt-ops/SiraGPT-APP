'use strict';

/**
 * propagate-reqid — opt-in helper that forwards the current request id
 * onto outbound HTTP calls (AI providers, webhooks, internal services).
 *
 * Why this exists:
 *   - `middleware/request-id.js` pins `req.requestId` per inbound HTTP
 *     turn and `utils/logger.js` mirrors it into the AsyncLocalStorage
 *     store as `reqId` (see logger.runWithContext / setContextField).
 *   - When backend code calls `fetch(...)` to a provider, we lose that
 *     correlation. By adding an `X-Request-ID` header on the wire,
 *     downstream services (and Sentry breadcrumbs / OTel spans) can
 *     stitch the request graph together end-to-end.
 *
 * Opt-in: import this module and either:
 *   1. Wrap an `init` object   →  `propagatedInit(init)`
 *   2. Wrap a single fetch call → `propagatedFetch(url, init, fetchImpl)`
 *   3. Get the bare id          → `currentRequestId()`
 *
 * The helper is deliberately *not* a global fetch patch — fetch-instrument.js
 * already owns the global patch surface; mixing both there would double-write
 * headers and complicate the sanitizer. Keeping this opt-in lets each
 * call-site decide whether forwarding is appropriate (e.g. you may NOT
 * want to forward to an untrusted webhook target).
 *
 * AsyncLocalStorage source: cycle-16 logger.js bound `reqId` into the
 * ALS store. We read that store first; we then fall back to anything the
 * caller passed in `init.requestId` for explicit overrides.
 */

const HEADER_NAME = 'X-Request-ID';

let _logger = null;
function loggerModule() {
  if (_logger) return _logger;
  try {
    _logger = require('./logger');
  } catch (_) {
    _logger = { currentContext: () => null };
  }
  return _logger;
}

/**
 * Return the active request id, or `null` if none is bound.
 * Looks first at the logger's AsyncLocalStorage store (`reqId`), then
 * common alternative keys (`requestId`, `request_id`) for compatibility
 * with other ALS bindings in the codebase.
 */
function currentRequestId() {
  const mod = loggerModule();
  const ctx = typeof mod.currentContext === 'function' ? mod.currentContext() : null;
  if (!ctx) return null;
  return ctx.reqId || ctx.requestId || ctx.request_id || null;
}

/**
 * Check whether an init object already has an X-Request-ID header set
 * (case-insensitive). If so we never overwrite — the caller's explicit
 * choice wins.
 */
function hasRequestIdHeader(headers) {
  if (!headers) return false;
  if (typeof headers.has === 'function') return headers.has(HEADER_NAME);
  if (Array.isArray(headers)) {
    return headers.some((entry) => Array.isArray(entry) && String(entry[0]).toLowerCase() === HEADER_NAME.toLowerCase());
  }
  if (typeof headers === 'object') {
    return Object.keys(headers).some((k) => k.toLowerCase() === HEADER_NAME.toLowerCase());
  }
  return false;
}

/**
 * Insert a header into whatever shape `init.headers` happens to be in
 * (Headers, array of pairs, plain object, or undefined). Returns the
 * (possibly new) headers container.
 */
function setHeader(headers, name, value) {
  if (headers && typeof headers.set === 'function') {
    headers.set(name, value);
    return headers;
  }
  if (Array.isArray(headers)) {
    return [...headers, [name, value]];
  }
  if (headers && typeof headers === 'object') {
    return { ...headers, [name]: value };
  }
  return { [name]: value };
}

/**
 * Return a new `init` object with `X-Request-ID` added, drawing the id
 * from (in order):
 *   1. `init.requestId` — explicit caller override
 *   2. the active AsyncLocalStorage context (cycle-16 logger)
 *
 * If no id is available the init is returned unchanged. The original
 * object is never mutated.
 */
function propagatedInit(init, opts) {
  const explicit = (opts && opts.requestId) || (init && init.requestId) || null;
  const id = explicit || currentRequestId();
  if (!id) return init || {};
  const base = init || {};
  if (hasRequestIdHeader(base.headers)) return base;
  return {
    ...base,
    headers: setHeader(base.headers, HEADER_NAME, String(id)),
  };
}

/**
 * Convenience wrapper around `fetch()` that calls `propagatedInit`
 * for the caller. The `fetchImpl` argument lets tests inject a mock.
 */
function propagatedFetch(url, init, fetchImpl) {
  const impl = fetchImpl || (typeof globalThis !== 'undefined' && globalThis.fetch) || null;
  if (typeof impl !== 'function') {
    throw new TypeError('propagatedFetch: no fetch implementation available');
  }
  return impl(url, propagatedInit(init));
}

module.exports = {
  HEADER_NAME,
  currentRequestId,
  propagatedInit,
  propagatedFetch,
};
