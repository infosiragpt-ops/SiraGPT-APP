'use strict';

/**
 * /metrics — F5 PR18 — Prometheus exposition endpoint.
 *
 * Hand-rolled (no prom-client dep) so this PR is purely additive. Emits
 * the canonical # HELP / # TYPE format Prometheus expects.
 *
 * Auth (opt-in): if `METRICS_TOKEN` env is set, requires
 *   Authorization: Bearer <METRICS_TOKEN>
 * Otherwise the endpoint is open (typical for in-VPC scrapes).
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

const router = express.Router();

let lastLagMs = 0;
let lagSamplerStarted = false;
function startLagSampler() {
  if (lagSamplerStarted) return;
  lagSamplerStarted = true;
  // Schedule a 1s timer + measure how long it actually took to fire.
  // The delta vs 1000ms approximates event-loop lag. Best-effort only.
  let prev = Date.now();
  setInterval(() => {
    const now = Date.now();
    lastLagMs = Math.max(0, now - prev - 1000);
    prev = now;
  }, 1000).unref();
}
startLagSampler();

function formatExposition() {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const version = (() => {
    try {
      return require('../../package.json').version || '0.0.0';
    } catch (_) {
      return '0.0.0';
    }
  })();
  const lines = [];
  lines.push('# HELP siragpt_build_info Build metadata, always 1.');
  lines.push('# TYPE siragpt_build_info gauge');
  lines.push(`siragpt_build_info{version="${version}"} 1`);
  lines.push('# HELP siragpt_uptime_seconds Process uptime in seconds.');
  lines.push('# TYPE siragpt_uptime_seconds gauge');
  lines.push(`siragpt_uptime_seconds ${uptime.toFixed(3)}`);
  lines.push('# HELP siragpt_memory_rss_bytes Resident set size in bytes.');
  lines.push('# TYPE siragpt_memory_rss_bytes gauge');
  lines.push(`siragpt_memory_rss_bytes ${mem.rss}`);
  lines.push('# HELP siragpt_memory_heap_total_bytes V8 heap total in bytes.');
  lines.push('# TYPE siragpt_memory_heap_total_bytes gauge');
  lines.push(`siragpt_memory_heap_total_bytes ${mem.heapTotal}`);
  lines.push('# HELP siragpt_memory_heap_used_bytes V8 heap used in bytes.');
  lines.push('# TYPE siragpt_memory_heap_used_bytes gauge');
  lines.push(`siragpt_memory_heap_used_bytes ${mem.heapUsed}`);
  lines.push('# HELP siragpt_event_loop_lag_ms Approximate event loop lag, sampled.');
  lines.push('# TYPE siragpt_event_loop_lag_ms gauge');
  lines.push(`siragpt_event_loop_lag_ms ${lastLagMs}`);
  // Cognitive-core metrics: router decisions, faithfulness grades, compute mix.
  try {
    const cognitive = require('../services/cognitive-metrics').toPrometheusText();
    if (cognitive && cognitive.trim()) lines.push(cognitive.trimEnd());
  } catch (_) { /* metrics must never break the endpoint */ }
  return lines.join('\n') + '\n';
}

function checkAuth(req) {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) return { ok: true };
  const header = req.get?.('Authorization') || req.get?.('authorization') || '';
  if (!header.startsWith('Bearer ')) return { ok: false };
  const token = header.slice(7).trim();
  return { ok: token === expected };
}

router.get('/', (req, res) => {
  const auth = checkAuth(req);
  if (!auth.ok) {
    res.set('WWW-Authenticate', 'Bearer realm="metrics"');
    return res.status(401).send('unauthorized\n');
  }
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(formatExposition());
});

module.exports = router;
module.exports.formatExposition = formatExposition;
module.exports.checkAuth = checkAuth;
