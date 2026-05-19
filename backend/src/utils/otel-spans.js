'use strict';

/**
 * otel-spans — thin, defensive helpers that wrap units of work in
 * OpenTelemetry spans WITHOUT crashing if OTel isn't configured.
 *
 * Design rules:
 *   - Lazy require of `@opentelemetry/api`. If the module isn't
 *     present, every helper degrades to a direct call.
 *   - `trace.getTracer` is wrapped in try/catch — when no SDK has
 *     registered a global tracer provider, the API returns a NoopTracer
 *     and `startActiveSpan` is still safe, but we still guard the
 *     boundary to be paranoid.
 *   - Span names are stable strings (`ai.generate`, `db.transaction`,
 *     `webhook.deliver`) so dashboards can group on them.
 *   - All numeric attribute values are coerced via Number() and dropped
 *     if NaN to avoid polluting the exporter.
 *
 * Public API:
 *   withAIGenerateSpan(attrs, fn)      → fn() result, with span around it
 *   withDbTransactionSpan(attrs, fn)
 *   withWebhookDeliverySpan(attrs, fn)
 */

let _otelApi = null;
let _otelLoaded = false;

function loadOtel() {
  if (_otelLoaded) return _otelApi;
  _otelLoaded = true;
  try {
    // eslint-disable-next-line global-require
    _otelApi = require('@opentelemetry/api');
  } catch (_e) {
    _otelApi = null;
  }
  return _otelApi;
}

function safeTracer(name) {
  const api = loadOtel();
  if (!api || !api.trace || typeof api.trace.getTracer !== 'function') return null;
  try {
    return api.trace.getTracer(name);
  } catch (_e) {
    return null;
  }
}

function coerceAttrs(attrs) {
  const out = {};
  if (!attrs || typeof attrs !== 'object') return out;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === 'boolean' || typeof v === 'string') {
      out[k] = v;
    } else {
      // Stringify objects defensively (depth-1)
      try {
        out[k] = String(v);
      } catch (_e) { /* drop */ }
    }
  }
  return out;
}

async function runSpan(spanName, tracerName, attrs, fn) {
  const tracer = safeTracer(tracerName);
  if (!tracer || typeof tracer.startActiveSpan !== 'function') {
    return fn();
  }
  const api = _otelApi;
  const SpanStatusCode = api && api.SpanStatusCode ? api.SpanStatusCode : { OK: 1, ERROR: 2 };
  const startedAt = Date.now();
  return tracer.startActiveSpan(spanName, async (span) => {
    try {
      const initial = coerceAttrs(attrs);
      if (Object.keys(initial).length) {
        try { span.setAttributes(initial); } catch (_e) { /* swallow */ }
      }
      const result = await fn(span);
      try {
        span.setAttribute('durationMs', Date.now() - startedAt);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (_e) { /* swallow */ }
      return result;
    } catch (err) {
      try {
        span.setAttribute('durationMs', Date.now() - startedAt);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err && err.message ? String(err.message).slice(0, 200) : 'error',
        });
        if (typeof span.recordException === 'function') {
          span.recordException({
            name: err && err.name ? err.name : 'Error',
            message: err && err.message ? String(err.message) : '',
          });
        }
      } catch (_e) { /* swallow */ }
      throw err;
    } finally {
      try { span.end(); } catch (_e) { /* swallow */ }
    }
  });
}

/**
 * Wrap an AI generation request in an `ai.generate` span.
 * @param {object} attrs   { model, provider, tokensIn, tokensOut }
 * @param {Function} fn    async () => result.  May also receive the span.
 */
function withAIGenerateSpan(attrs, fn) {
  return runSpan('ai.generate', '@siragpt/ai', attrs, fn);
}

/**
 * Wrap a DB transaction in a `db.transaction` span.
 * @param {object} attrs   { db, operation, table, ... }
 * @param {Function} fn    async () => result
 */
function withDbTransactionSpan(attrs, fn) {
  return runSpan('db.transaction', '@siragpt/db', attrs, fn);
}

/**
 * Wrap a webhook delivery attempt in a `webhook.deliver` span.
 * @param {object} attrs   { url, event, attempt, httpStatus }
 * @param {Function} fn    async (span) => result
 */
function withWebhookDeliverySpan(attrs, fn) {
  return runSpan('webhook.deliver', '@siragpt/webhooks', attrs, fn);
}

/**
 * Run an arbitrary block of work inside a custom OTel span.
 *
 * This is the lower-level escape hatch used by `withHttpSpan` and the
 * existing typed helpers. Exposed publicly so route-level code can wrap
 * sub-units of work with a stable span name without having to reach
 * directly into `@opentelemetry/api` (which may not even be installed
 * in some deployments).
 *
 * Span name should be a stable string (e.g. `http.GET./api/files/:id`).
 * The tracer name defaults to `@siragpt/http` but can be overridden via
 * the third arg for non-HTTP callers.
 *
 * @param {string} spanName
 * @param {object} attrs
 * @param {Function} fn       async (span) => result
 * @param {string} [tracerName='@siragpt/http']
 */
function withSpan(spanName, attrs, fn, tracerName) {
  return runSpan(
    String(spanName || 'span'),
    typeof tracerName === 'string' && tracerName ? tracerName : '@siragpt/http',
    attrs,
    fn,
  );
}

/**
 * Higher-level Express middleware factory that wraps every request in
 * an `http.{METHOD}.{ROUTE}` span. Opt-in only — NOT mounted globally.
 *
 * Usage:
 *   const { httpSpanMiddleware } = require('../utils/otel-spans');
 *   router.use(httpSpanMiddleware()); // per-router opt-in
 *
 * Or per-route:
 *   router.get('/foo', httpSpanMiddleware({ routePath: '/foo' }), handler);
 *
 * Span name resolution priority:
 *   1. opts.routePath  (explicit override)
 *   2. req.route.path  (set by Express once a route matches; absent in
 *      pre-route middleware → falls back to req.baseUrl + req.path)
 *   3. req.originalUrl (last-resort; may contain a query string we strip)
 *
 * Initial attributes:
 *   http.method, http.target, http.route, http.user_agent (truncated),
 *   http.request_id (if `req.id` is set by request-id middleware)
 *
 * On response finish we add http.status_code and durationMs (the latter
 * is already added by `runSpan`, but we add status_code on `res` events
 * because the handler may resolve before the response is fully sent).
 *
 * Design notes:
 *   - Fail-open: any thrown error in the middleware itself (e.g. otel
 *     API broken) is caught and the request proceeds untraced.
 *   - We do NOT couple to `req.route` at registration time (that field
 *     is only populated AFTER Express matches a route) — we read it
 *     lazily at request time, and re-read on `res` close to capture the
 *     final matched route when this middleware runs before the matcher.
 *   - `runSpan` already records exceptions and sets ERROR status when
 *     the wrapped fn throws. For Express we have to bridge to `next(err)`
 *     instead, so we attach status to the span via the `res` finish
 *     hook and let downstream error handlers do their job.
 */
function httpSpanMiddleware(opts = {}) {
  const fixedRoute = typeof opts.routePath === 'string' && opts.routePath
    ? opts.routePath
    : null;

  return function httpSpanMw(req, res, next) {
    let routePath;
    try {
      routePath = fixedRoute
        || (req.route && req.route.path)
        || ((req.baseUrl || '') + (req.path || ''))
        || (req.originalUrl ? String(req.originalUrl).split('?')[0] : '/');
    } catch (_e) {
      routePath = '/';
    }
    const method = (req && req.method ? String(req.method) : 'GET').toUpperCase();
    const spanName = `http.${method}.${routePath}`;

    const baseAttrs = {
      'http.method': method,
      'http.target': req && req.originalUrl ? String(req.originalUrl).slice(0, 500) : '',
      'http.route': routePath,
    };
    try {
      const ua = req && req.headers && req.headers['user-agent'];
      if (typeof ua === 'string' && ua) baseAttrs['http.user_agent'] = ua.slice(0, 200);
    } catch (_e) { /* swallow */ }
    if (req && req.id) {
      try { baseAttrs['http.request_id'] = String(req.id).slice(0, 100); } catch (_e) { /* swallow */ }
    }
    if (typeof opts.attrs === 'object' && opts.attrs) {
      Object.assign(baseAttrs, opts.attrs);
    }

    let tracer;
    try {
      tracer = safeTracer('@siragpt/http');
    } catch (_e) {
      tracer = null;
    }
    if (!tracer || typeof tracer.startActiveSpan !== 'function') {
      return next();
    }

    const api = _otelApi;
    const SpanStatusCode = api && api.SpanStatusCode ? api.SpanStatusCode : { OK: 1, ERROR: 2 };
    const startedAt = Date.now();

    try {
      tracer.startActiveSpan(spanName, (span) => {
        let ended = false;
        function finish(maybeErr) {
          if (ended) return;
          ended = true;
          try {
            // Re-read route in case it was populated after this mw ran.
            let finalRoute = routePath;
            try {
              if (!fixedRoute && req.route && req.route.path) finalRoute = req.route.path;
            } catch (_e) { /* swallow */ }
            span.setAttribute('http.route', finalRoute);
            span.setAttribute('http.status_code', Number(res.statusCode) || 0);
            span.setAttribute('durationMs', Date.now() - startedAt);
            if (maybeErr) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: maybeErr && maybeErr.message ? String(maybeErr.message).slice(0, 200) : 'error',
              });
              if (typeof span.recordException === 'function') {
                span.recordException({
                  name: maybeErr.name || 'Error',
                  message: maybeErr.message ? String(maybeErr.message) : '',
                });
              }
            } else if (Number(res.statusCode) >= 500) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.statusCode}` });
            } else {
              span.setStatus({ code: SpanStatusCode.OK });
            }
          } catch (_e) { /* swallow */ }
          try { span.end(); } catch (_e) { /* swallow */ }
        }

        try {
          span.setAttributes(coerceAttrs(baseAttrs));
        } catch (_e) { /* swallow */ }

        // Listen for the earliest signal that the response is done.
        // `finish` = headers + body flushed cleanly. `close` = client
        // disconnected before finish. Either way, end the span exactly
        // once.
        try { res.once('finish', () => finish(null)); } catch (_e) { /* swallow */ }
        try { res.once('close', () => finish(null)); } catch (_e) { /* swallow */ }

        return next();
      });
    } catch (_e) {
      // OTel failure must never break the request.
      return next();
    }
  };
}

/** Test-only: reset the lazy cache. */
function _resetForTests() {
  _otelApi = null;
  _otelLoaded = false;
}

module.exports = {
  withAIGenerateSpan,
  withDbTransactionSpan,
  withWebhookDeliverySpan,
  withSpan,
  httpSpanMiddleware,
  _resetForTests,
};
