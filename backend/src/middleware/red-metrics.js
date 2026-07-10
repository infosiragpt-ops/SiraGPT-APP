/**
 * red-metrics — RED-method (Rate, Errors, Duration) HTTP middleware.
 *
 * Emits per-endpoint Prometheus series so a single dashboard can answer
 * "which routes are slow / failing / busy?" without grepping logs.
 *
 *   http_requests_total{method,route,status_class}
 *   http_request_errors_total{method,route,status_class}
 *   http_request_duration_ms{method,route,status_class}  (histogram)
 *
 * The route label is taken from the matched Express route pattern
 * (`/api/users/:id`) — never the raw URL — so high-cardinality IDs and
 * query strings can't blow up the metric registry. Unmatched requests
 * fall back to the literal "unmatched" bucket.
 */

const metrics = require('../services/agents/metrics');
const {
  isMetricsRequest,
  matchedRouteLabel,
} = require('../services/observability/metrics-paths');

const RED_REQUESTS_TOTAL = 'http_requests_total';
const RED_ERRORS_TOTAL = 'http_request_errors_total';
const RED_DURATION = 'http_request_duration_ms';

let registered = false;
function ensureRegistered() {
  if (registered) return;
  registered = true;
  metrics.registerCounter(RED_REQUESTS_TOTAL, {
    help: 'HTTP requests served, labelled by method, matched route, and status class',
    labels: ['method', 'route', 'status_class'],
  });
  metrics.registerCounter(RED_ERRORS_TOTAL, {
    help: 'HTTP requests that returned an error response (status >= 500 or unhandled)',
    labels: ['method', 'route', 'status_class'],
  });
  metrics.registerHistogram(RED_DURATION, {
    help: 'HTTP request duration in milliseconds, labelled by method, matched route, status class',
    labels: ['method', 'route', 'status_class'],
    // Web-tier buckets: most calls are sub-second; tail goes to 30s.
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  });
}

function statusClass(code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n <= 0) return 'unknown';
  if (n >= 500) return '5xx';
  if (n >= 400) return '4xx';
  if (n >= 300) return '3xx';
  if (n >= 200) return '2xx';
  return '1xx';
}

// Best-effort, low-cardinality route label. Express only fills
// `req.route` when a handler matched, so for 404s and middleware-level
// rejections we fall back to "unmatched".
function routeLabel(req) {
  return matchedRouteLabel(req);
}

function redMetricsMiddleware(req, res, next) {
  ensureRegistered();
  if (isMetricsRequest(req)) return next();
  const startNs = process.hrtime.bigint();

  // Use the `finish` event so we capture the response status that the
  // handler actually sent (including errors that flowed through the
  // global error handler). `close` fires on aborted connections too —
  // we count those as errors so dashboards see client-side cancels.
  let recorded = false;
  function record(aborted) {
    if (recorded) return;
    recorded = true;
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    const labels = {
      method: req.method || 'UNKNOWN',
      route: routeLabel(req),
      status_class: aborted ? 'aborted' : statusClass(res.statusCode),
    };
    try {
      metrics.counter(RED_REQUESTS_TOTAL, labels);
      metrics.observe(RED_DURATION, labels, durationMs);
      if (aborted || (res.statusCode || 0) >= 500) {
        metrics.counter(RED_ERRORS_TOTAL, labels);
      }
    } catch (_err) {
      // Metrics must never crash the request path.
    }
  }

  res.on('finish', () => record(false));
  res.on('close', () => {
    if (!res.writableEnded) record(true);
  });

  next();
}

module.exports = {
  redMetricsMiddleware,
  routeLabel,
  statusClass,
  RED_REQUESTS_TOTAL,
  RED_ERRORS_TOTAL,
  RED_DURATION,
};
