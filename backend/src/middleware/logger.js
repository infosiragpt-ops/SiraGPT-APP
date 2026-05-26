const pino = require('pino');
const pinoHttp = require('pino-http');
const { randomUUID } = require('crypto');
// OpenTelemetry API is the no-op tracer when the SDK isn't started, so
// requiring it unconditionally is safe and adds zero cost when tracing
// is disabled.
const { context: otelContext, trace: otelTrace } = require('@opentelemetry/api');
const { REDACTION_CENSOR, redactPayloadDeep } = require('../utils/log-redaction');
const { normalizeRequestId } = require('./request-id');

// Paths the logger MUST never emit in cleartext. fast-redact (pino's
// underlying engine) supports literal paths and one-level `*` wildcards,
// so we enumerate the common shapes we use in handlers / SDKs / tests.
// Adding here is cheap; expanding to a deeper wildcard would silently
// trigger fast-redact's slow path for every log line.
const REDACT_PATHS = [
  // HTTP request — auth/session/api-key headers
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'req.headers["x-access-token"]',
  // HTTP response — outgoing cookies
  'res.headers["set-cookie"]',
  // Common body fields seen across auth, OAuth, and provider routes
  'req.body.password',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.refresh_token',
  'req.body.accessToken',
  'req.body.access_token',
  'req.body.apiKey',
  'req.body.api_key',
  'req.body.clientSecret',
  'req.body.client_secret',
  'req.body.secret',
  // Top-level fields when payloads are passed directly to logger
  'password',
  'token',
  'refreshToken',
  'refresh_token',
  'accessToken',
  'access_token',
  'apiKey',
  'api_key',
  'clientSecret',
  'client_secret',
  'secret',
  'authorization',
  'cookie',
  // One-level wildcards catch `{ user: { password } }`, `{ creds: { token } }`
  // and similar nested shapes without paying the deep-wildcard cost.
  '*.password',
  '*.token',
  '*.refreshToken',
  '*.refresh_token',
  '*.accessToken',
  '*.access_token',
  '*.apiKey',
  '*.api_key',
  '*.clientSecret',
  '*.client_secret',
  '*.secret',
  '*.authorization',
  '*.cookie',
];

// Structured JSON logger. Output goes to stdout in every environment
// so log aggregators (Datadog, CloudWatch, Loki, …) can parse the
// shape directly. No pretty-printing — pipe through `pino-pretty`
// locally when you want it. Level is overridable via LOG_LEVEL.
//
// `redact` is enforced at write time: any matching path is replaced
// with `[REDACTED]` before serialization, so even an accidental
// `req.log.info({ req })` cannot leak the bearer token in the access
// log. We keep `remove: false` so log shape stays stable for downstream
// parsers — only the value changes.
// Trace correlation mixin: every log line emitted while an OTel span is
// active picks up `trace_id` / `span_id` / `trace_flags`. Lets ops join
// a log line back to its trace in Tempo/Jaeger without requiring the
// caller to thread context manually. The mixin returns an empty object
// when no span is active (e.g. background workers, startup), so it adds
// no noise to off-request logs.
function traceCorrelationMixin() {
  try {
    const span = otelTrace.getSpan(otelContext.active());
    if (!span) return {};
    const ctx = typeof span.spanContext === 'function' ? span.spanContext() : null;
    if (!ctx || !ctx.traceId) return {};
    return {
      trace_id: ctx.traceId,
      span_id: ctx.spanId,
      trace_flags: typeof ctx.traceFlags === 'number'
        ? `0${ctx.traceFlags.toString(16)}`.slice(-2)
        : undefined,
    };
  } catch (_err) {
    return {};
  }
}

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: REDACT_PATHS,
    censor: REDACTION_CENSOR,
    remove: false,
  },
  formatters: {
    log(object) {
      return redactPayloadDeep(object);
    },
  },
  mixin: traceCorrelationMixin,
});

// HTTP request logger — auto-attaches `req.id` to every request and
// emits one line per response with method, url, status, duration.
// `req.log` is the same pino instance bound to that id, so any
// downstream code that swaps `console.log(...)` for `req.log.info({...}, '...')`
// gets free correlation IDs across the whole request lifecycle.

// Authenticated media URLs (e.g. `/uploads/...?token=<JWT>`) must never
// hit the log feed verbatim. Redact any query parameter likely to carry
// a bearer/credential before serializing the request URL.
const URL_SECRET_PARAMS = new Set(['token', 'access_token', 'apikey', 'api_key', 'signature', 'sig']);
function redactUrlSecrets(rawUrl) {
  const url = String(rawUrl || '');
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return url;
  const path = url.slice(0, qIndex);
  const query = url.slice(qIndex + 1);
  const redacted = query
    .split('&')
    .map((pair) => {
      const eqIndex = pair.indexOf('=');
      const key = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
      if (URL_SECRET_PARAMS.has(key.toLowerCase())) {
        return `${key}=[REDACTED]`;
      }
      return pair;
    })
    .join('&');
  return `${path}?${redacted}`;
}

const httpLogger = pinoHttp({
  logger,
  // Honor an upstream-supplied request id (load balancer / gateway /
  // distributed trace header) if present; otherwise mint a fresh UUID.
  genReqId: (req) => normalizeRequestId(req.headers['x-request-id']) || randomUUID(),
  // Quieter defaults: 5xx → error, 4xx → warn, otherwise → info.
  // Without this every 4xx logs at info, which buries real errors.
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Trim req/res down to the fields ops actually want. Avoids
  // accidentally emitting auth headers, request bodies, or full
  // user payloads into logs (PII risk + log bloat).
  serializers: {
    req(req) {
      return { id: req.id, method: req.method, url: redactUrlSecrets(req.url) };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});

module.exports = {
  logger,
  httpLogger,
  REDACT_PATHS,
  REDACTION_CENSOR,
  redactPayloadDeep,
  traceCorrelationMixin,
};
