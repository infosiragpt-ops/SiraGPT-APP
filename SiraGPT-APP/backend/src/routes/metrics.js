'use strict';

/**
 * /metrics — F5 PR18 — Prometheus exposition endpoint.
 *
 * Hand-rolled (no prom-client dep) so this PR is purely additive. Emits
 * the canonical # HELP / # TYPE format Prometheus expects.
 *
 * Access control and all exposition formatting live in dependency-free
 * observability services. This module only retains the legacy router mount.
 *
 * Initial metric set (low-friction, no instrumentation hooks):
 *   siragpt_build_info{version}      — gauge, always 1
 *   siragpt_uptime_seconds           — gauge, process.uptime()
 *   siragpt_memory_rss_bytes         — gauge, process.memoryUsage().rss
 *   siragpt_memory_heap_total_bytes  — gauge
 *   siragpt_memory_heap_used_bytes   — gauge
 *   siragpt_event_loop_lag_ms        — gauge, sampled (best-effort)
 *
 * Future PRs hook request counters + credit spend totals + image job
 * gauges into this same endpoint via a small in-memory registry.
 */

const express = require('express');
const {
  metricsHandler,
} = require('../services/observability/metrics-exposition');
const {
  formatProcessMetricsExposition,
} = require('../services/observability/process-metrics-exposition');

const router = express.Router();

router.get('/', metricsHandler);

module.exports = router;
// Kept as a compatibility export for direct callers; implementation is no
// longer owned by the route and cannot form a route ↔ exporter require cycle.
module.exports.formatExposition = formatProcessMetricsExposition;
