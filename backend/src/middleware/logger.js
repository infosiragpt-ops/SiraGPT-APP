const pino = require('pino');
const pinoHttp = require('pino-http');
const { randomUUID } = require('crypto');

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
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
    remove: false,
  },
});

// HTTP request logger — auto-attaches `req.id` to every request and
// emits one line per response with method, url, status, duration.
// `req.log` is the same pino instance bound to that id, so any
// downstream code that swaps `console.log(...)` for `req.log.info({...}, '...')`
// gets free correlation IDs across the whole request lifecycle.
const httpLogger = pinoHttp({
  logger,
  // Honor an upstream-supplied request id (load balancer / gateway /
  // distributed trace header) if present; otherwise mint a fresh UUID.
  genReqId: (req) => req.headers['x-request-id'] || randomUUID(),
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
      return { id: req.id, method: req.method, url: req.url };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});

module.exports = { logger, httpLogger, REDACT_PATHS };
