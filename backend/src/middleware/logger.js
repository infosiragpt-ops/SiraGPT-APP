const pino = require('pino');
const pinoHttp = require('pino-http');
const { randomUUID } = require('crypto');

// Structured JSON logger. Output goes to stdout in every environment
// so log aggregators (Datadog, CloudWatch, Loki, …) can parse the
// shape directly. No pretty-printing — pipe through `pino-pretty`
// locally when you want it. Level is overridable via LOG_LEVEL.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
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

module.exports = { logger, httpLogger };
