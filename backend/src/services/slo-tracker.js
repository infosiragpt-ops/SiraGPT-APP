'use strict';

/**
 * slo-tracker.js — in-process SLO accounting for the public HTTP surface.
 *
 * Tracks four SLOs per endpoint (the route template, not the raw path,
 * so dynamic ids don't explode cardinality):
 *
 *   1. 99.5% of requests under 500ms       (slo_latency_p995_500ms)
 *   2. 99%   of requests under 2s          (slo_latency_p99_2s)
 *   3. Error rate < 1%                     (slo_error_rate_below_1pct)
 *   4. 99.9% availability                  (slo_availability_999)
 *
 * Counters are exposed through the shared Prometheus registry
 * (`src/utils/metrics.js`) so `/metrics` scrapers pick them up.
 *
 * Memory footprint is bounded by SIRAGPT_SLO_MAX_ROUTE_STATES. No
 * per-request allocation beyond the histogram observe path that
 * metrics.js already does.
 *
 * Public API:
 *   record({ route, statusCode, durationMs })
 *   slos()                  → static SLO targets
 *   getEndpointStats(route?)→ aggregate snapshot
 *   reset()                 → clear all counters (test helper)
 *   middleware()            → Express middleware that records on `finish`
 */

const metrics = require('../utils/metrics');
const {
  isMetricsRequest,
  matchedRouteLabel,
} = require('./observability/metrics-paths');

const SLO_TARGETS = Object.freeze({
  latency_p995_under_500ms: 0.995,
  latency_p99_under_2s:     0.99,
  error_rate_max:           0.01,
  availability:             0.999,
});

const DEFAULT_SLO_ROUTE_STATE_LIMIT = 128;
const MAX_SLO_ROUTE_STATE_LIMIT = 2_000;
const SLO_OVERFLOW_ROUTE = '__other__';

function resolveRouteStateLimit(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_SLO_ROUTE_STATE_LIMIT;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SLO_ROUTE_STATE_LIMIT;
  return Math.max(1, Math.min(MAX_SLO_ROUTE_STATE_LIMIT, Math.floor(parsed)));
}

const SLO_ROUTE_STATE_LIMIT = resolveRouteStateLimit(
  process.env.SIRAGPT_SLO_MAX_ROUTE_STATES,
);

const PROM_FAMILIES = {
  total:           'siragpt_slo_requests_total',
  fast:            'siragpt_slo_requests_under_500ms_total',
  acceptable:      'siragpt_slo_requests_under_2s_total',
  errors:          'siragpt_slo_errors_total',
  available:       'siragpt_slo_available_total',
  latencyP995Hits: 'siragpt_slo_latency_p995_hit_total',
  endpointMeets:   'siragpt_slo_endpoint_meets_target',
};

let _registered = false;
function _ensureFamiliesRegistered() {
  if (_registered) return;
  _registered = true;
  if (typeof metrics.registerCounter === 'function') {
    const options = { labels: ['route'], maxSeries: SLO_ROUTE_STATE_LIMIT };
    metrics.registerCounter(PROM_FAMILIES.total,           { ...options, help: 'Total requests counted for SLO budgets' });
    metrics.registerCounter(PROM_FAMILIES.fast,            { ...options, help: 'Requests under 500ms (99.5% target)' });
    metrics.registerCounter(PROM_FAMILIES.acceptable,      { ...options, help: 'Requests under 2s (99% target)' });
    metrics.registerCounter(PROM_FAMILIES.errors,          { ...options, help: 'Requests counted as errors (5xx)' });
    metrics.registerCounter(PROM_FAMILIES.available,       { ...options, help: 'Requests counted as available (non-5xx)' });
  }
  if (typeof metrics.registerGauge === 'function') {
    metrics.registerGauge(PROM_FAMILIES.endpointMeets, {
      help: 'Whether the endpoint currently meets its SLO target (1=yes, 0=no), per objective',
      labels: ['route', 'objective'],
      maxSeries: SLO_ROUTE_STATE_LIMIT * 4,
    });
  }
}

const _state = new Map(); // route → { total, fast, acceptable, errors, available }

function _boundedRoute(route) {
  if (_state.has(route) || route === SLO_OVERFLOW_ROUTE) return route;
  const hasOverflow = _state.has(SLO_OVERFLOW_ROUTE);
  const concreteCount = _state.size - (hasOverflow ? 1 : 0);
  const concreteLimit = Math.max(0, SLO_ROUTE_STATE_LIMIT - 1);
  return concreteCount < concreteLimit ? route : SLO_OVERFLOW_ROUTE;
}

function _entry(route) {
  let s = _state.get(route);
  if (!s) {
    s = { total: 0, fast: 0, acceptable: 0, errors: 0, available: 0 };
    _state.set(route, s);
  }
  return s;
}

function record({ route, statusCode, durationMs } = {}) {
  _ensureFamiliesRegistered();
  const requestedRoute = (typeof route === 'string' && route) ? route : 'unmatched';
  const r = _boundedRoute(requestedRoute);
  const ms = Number.isFinite(durationMs) ? durationMs : 0;
  const status = Number.isFinite(statusCode) ? statusCode : 0;
  const isError = status >= 500 && status < 600;
  const isAvailable = !isError;

  const s = _entry(r);
  s.total += 1;
  if (ms < 500) s.fast += 1;
  if (ms < 2000) s.acceptable += 1;
  if (isError) s.errors += 1;
  if (isAvailable) s.available += 1;

  // Mirror to Prometheus registry
  try {
    metrics.counter(PROM_FAMILIES.total, { route: r });
    if (ms < 500) metrics.counter(PROM_FAMILIES.fast, { route: r });
    if (ms < 2000) metrics.counter(PROM_FAMILIES.acceptable, { route: r });
    if (isError) metrics.counter(PROM_FAMILIES.errors, { route: r });
    if (isAvailable) metrics.counter(PROM_FAMILIES.available, { route: r });
  } catch { /* never throw */ }

  // Update meets-target gauge
  try {
    const stats = _statsFor(r, s);
    metrics.gauge(PROM_FAMILIES.endpointMeets, { route: r, objective: 'latency_p995' },
      stats.latency_p995_ratio >= SLO_TARGETS.latency_p995_under_500ms ? 1 : 0);
    metrics.gauge(PROM_FAMILIES.endpointMeets, { route: r, objective: 'latency_p99' },
      stats.latency_p99_ratio >= SLO_TARGETS.latency_p99_under_2s ? 1 : 0);
    metrics.gauge(PROM_FAMILIES.endpointMeets, { route: r, objective: 'error_rate' },
      stats.error_rate <= SLO_TARGETS.error_rate_max ? 1 : 0);
    metrics.gauge(PROM_FAMILIES.endpointMeets, { route: r, objective: 'availability' },
      stats.availability >= SLO_TARGETS.availability ? 1 : 0);
  } catch { /* never throw */ }
}

function _statsFor(route, s) {
  const total = s.total || 0;
  const safe = (n) => (total === 0 ? 0 : n / total);
  return {
    route,
    total,
    fast: s.fast,
    acceptable: s.acceptable,
    errors: s.errors,
    available: s.available,
    latency_p995_ratio: safe(s.fast),       // proxy: ratio under 500ms
    latency_p99_ratio:  safe(s.acceptable), // proxy: ratio under 2s
    error_rate:         safe(s.errors),
    availability:       safe(s.available),
    meets: {
      latency_p995: safe(s.fast)       >= SLO_TARGETS.latency_p995_under_500ms,
      latency_p99:  safe(s.acceptable) >= SLO_TARGETS.latency_p99_under_2s,
      error_rate:   safe(s.errors)     <= SLO_TARGETS.error_rate_max,
      availability: safe(s.available)  >= SLO_TARGETS.availability,
    },
  };
}

function getEndpointStats(route) {
  if (route) {
    const s = _state.get(route);
    return s ? _statsFor(route, s) : null;
  }
  const out = [];
  for (const [r, s] of _state) out.push(_statsFor(r, s));
  return out;
}

function slos() { return { ...SLO_TARGETS }; }

function reset() {
  _state.clear();
}

function middleware() {
  return function sloTrackerMiddleware(req, res, next) {
    if (isMetricsRequest(req)) return next();
    const startNs = process.hrtime.bigint();
    res.on('finish', () => {
      try {
        const route = matchedRouteLabel(req);
        const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        record({ route, statusCode: res.statusCode, durationMs });
      } catch { /* never throw from instrumentation */ }
    });
    next();
  };
}

module.exports = {
  SLO_OVERFLOW_ROUTE,
  SLO_ROUTE_STATE_LIMIT,
  SLO_TARGETS,
  record,
  resolveRouteStateLimit,
  slos,
  getEndpointStats,
  reset,
  middleware,
};
