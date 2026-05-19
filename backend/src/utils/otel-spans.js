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

/** Test-only: reset the lazy cache. */
function _resetForTests() {
  _otelApi = null;
  _otelLoaded = false;
}

module.exports = {
  withAIGenerateSpan,
  withDbTransactionSpan,
  withWebhookDeliverySpan,
  _resetForTests,
};
