/**
 * metrics.js — minimal in-memory Prometheus-compatible registry.
 *
 * Self-contained: no prom-client dependency. Lives at the utility tier so
 * other modules can `require('./metrics')` defensively (inside try/catch)
 * without pulling in agent/service code.
 *
 * Supports three metric types: counter, gauge, histogram. Histograms use
 * user-supplied bucket boundaries (le buckets) plus an implicit +Inf
 * bucket and a `_sum` / `_count` line.
 *
 * The companion `agents/metrics.js` registry continues to live alongside
 * this one for legacy series. `/metrics` reads both.
 */

'use strict';

// name → { type, help, labels, series: Map<labelKey, value|histogramRecord> [, buckets] }
const registry = new Map();

function _normalizeLabels(labels) {
  if (!labels) return {};
  if (typeof labels !== 'object') return {};
  return labels;
}

function _labelKey(labelNames, labels) {
  const norm = _normalizeLabels(labels);
  return labelNames
    .map((n) => `${n}=${String(norm[n] ?? '').replace(/[\\"\n,]/g, '_')}`)
    .join(',');
}

function registerCounter(name, { help = '', labels = [] } = {}) {
  if (registry.has(name)) return;
  registry.set(name, { type: 'counter', help, labels, series: new Map() });
}

function registerGauge(name, { help = '', labels = [] } = {}) {
  if (registry.has(name)) return;
  registry.set(name, { type: 'gauge', help, labels, series: new Map() });
}

function registerHistogram(name, { help = '', labels = [], buckets = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] } = {}) {
  if (registry.has(name)) return;
  // Defensive copy, sorted ascending
  const sortedBuckets = Array.from(new Set(buckets.map(Number).filter((n) => Number.isFinite(n))))
    .sort((a, b) => a - b);
  registry.set(name, { type: 'histogram', help, labels, buckets: sortedBuckets, series: new Map() });
}

function counter(name, labels = {}, delta = 1) {
  const m = registry.get(name);
  if (!m || m.type !== 'counter') return;
  if (!Number.isFinite(delta) || delta < 0) return;
  const k = _labelKey(m.labels, labels);
  m.series.set(k, (m.series.get(k) || 0) + delta);
}

function gauge(name, labels = {}, value = 0) {
  const m = registry.get(name);
  if (!m || m.type !== 'gauge') return;
  if (!Number.isFinite(value)) return;
  m.series.set(_labelKey(m.labels, labels), value);
}

function observe(name, labels = {}, value = 0) {
  const m = registry.get(name);
  if (!m || m.type !== 'histogram') return;
  if (!Number.isFinite(value) || value < 0) return;
  const k = _labelKey(m.labels, labels);
  let rec = m.series.get(k);
  if (!rec) {
    rec = { count: 0, sum: 0, bucketCounts: new Array(m.buckets.length).fill(0) };
    m.series.set(k, rec);
  }
  rec.count += 1;
  rec.sum += value;
  for (let i = 0; i < m.buckets.length; i += 1) {
    if (value <= m.buckets[i]) rec.bucketCounts[i] += 1;
  }
}

// ── Rendering ────────────────────────────────────────────────────────────

function _escapeLabelValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function _renderLabelString(labelNames, key, extra) {
  const parts = [];
  if (key) {
    const pieces = key.split(',');
    for (let i = 0; i < pieces.length; i += 1) {
      const eq = pieces[i].indexOf('=');
      const value = eq >= 0 ? pieces[i].slice(eq + 1) : '';
      parts.push(`${labelNames[i]}="${_escapeLabelValue(value)}"`);
    }
  }
  if (extra) parts.push(extra);
  return parts.length ? `{${parts.join(',')}}` : '';
}

function _renderCounter(name, m) {
  const out = [`# HELP ${name} ${m.help || ''}`, `# TYPE ${name} counter`];
  if (m.series.size === 0) {
    out.push(`${name} 0`);
  } else {
    for (const [k, v] of m.series) {
      out.push(`${name}${_renderLabelString(m.labels, k)} ${v}`);
    }
  }
  return out.join('\n');
}

function _renderGauge(name, m) {
  const out = [`# HELP ${name} ${m.help || ''}`, `# TYPE ${name} gauge`];
  if (m.series.size === 0) {
    out.push(`${name} 0`);
  } else {
    for (const [k, v] of m.series) {
      out.push(`${name}${_renderLabelString(m.labels, k)} ${v}`);
    }
  }
  return out.join('\n');
}

function _renderHistogram(name, m) {
  const out = [`# HELP ${name} ${m.help || ''}`, `# TYPE ${name} histogram`];
  for (const [k, rec] of m.series) {
    for (let i = 0; i < m.buckets.length; i += 1) {
      out.push(
        `${name}_bucket${_renderLabelString(m.labels, k, `le="${m.buckets[i]}"`)} ${rec.bucketCounts[i]}`,
      );
    }
    out.push(`${name}_bucket${_renderLabelString(m.labels, k, 'le="+Inf"')} ${rec.count}`);
    out.push(`${name}_sum${_renderLabelString(m.labels, k)} ${rec.sum}`);
    out.push(`${name}_count${_renderLabelString(m.labels, k)} ${rec.count}`);
  }
  return out.join('\n');
}

/** Render the entire registry in Prometheus text-exposition format. */
function renderText() {
  const blocks = [];
  for (const [name, m] of registry) {
    if (m.type === 'counter') blocks.push(_renderCounter(name, m));
    else if (m.type === 'gauge') blocks.push(_renderGauge(name, m));
    else if (m.type === 'histogram') blocks.push(_renderHistogram(name, m));
  }
  return `${blocks.join('\n\n')}\n`;
}

function _reset() {
  for (const m of registry.values()) m.series.clear();
}

function _clearRegistry() {
  registry.clear();
}

// ── Default metric families used by /metrics ─────────────────────────────
registerCounter('siragpt_http_requests_total', {
  help: 'Total HTTP requests served by SiraGPT, labelled by method, matched route, and status code',
  labels: ['method', 'route', 'status'],
});
registerHistogram('siragpt_http_request_duration_seconds', {
  help: 'HTTP request latency in seconds, bucketed for Prometheus histograms',
  labels: ['method', 'route'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
registerGauge('siragpt_circuit_breaker_state', {
  help: 'Circuit breaker state per named breaker (0=closed, 1=half_open, 2=open)',
  labels: ['name'],
});
registerGauge('siragpt_async_guards_active', {
  help: 'Active AsyncGuard tokens currently tracked in this process',
  labels: [],
});
registerCounter('siragpt_analyzer_cache_hits_total', {
  help: 'Document professional analyzer in-process cache hits',
  labels: [],
});
registerCounter('siragpt_analyzer_cache_misses_total', {
  help: 'Document professional analyzer in-process cache misses',
  labels: [],
});
registerGauge('siragpt_process_uptime_seconds', {
  help: 'Process uptime in seconds (from process.uptime())',
  labels: [],
});
registerGauge('siragpt_nodejs_memory_bytes', {
  help: 'Resident Node.js memory in bytes, labelled by type (rss, heapUsed, heapTotal, external)',
  labels: ['type'],
});

// ── Helpers that snapshot live state into the registry ───────────────────

const CB_STATE_VALUE = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };

/**
 * Track a CircuitBreaker instance — every time the breaker transitions
 * state, the gauge is updated. Records the initial state too.
 */
function trackCircuitBreaker(breaker) {
  if (!breaker || typeof breaker.on !== 'function') return;
  try {
    const initial = typeof breaker.state === 'string' ? breaker.state : 'CLOSED';
    gauge('siragpt_circuit_breaker_state', { name: breaker.name }, CB_STATE_VALUE[initial] ?? 0);
    breaker.on('stateChange', ({ to, name }) => {
      gauge('siragpt_circuit_breaker_state', { name }, CB_STATE_VALUE[to] ?? 0);
    });
  } catch {
    // never throw from instrumentation
  }
}

let _activeGuards = 0;
function incActiveGuards() {
  _activeGuards += 1;
  gauge('siragpt_async_guards_active', {}, _activeGuards);
}
function decActiveGuards() {
  if (_activeGuards > 0) _activeGuards -= 1;
  gauge('siragpt_async_guards_active', {}, _activeGuards);
}
function getActiveGuards() {
  return _activeGuards;
}

function recordAnalyzerCacheStats(prevHits, prevMisses, stats) {
  // Reports DELTAS into the counters. Caller persists prev between calls.
  if (!stats) return { hits: prevHits, misses: prevMisses };
  const hits = Number(stats.hits) || 0;
  const misses = Number(stats.misses) || 0;
  const deltaHits = Math.max(0, hits - (prevHits || 0));
  const deltaMisses = Math.max(0, misses - (prevMisses || 0));
  if (deltaHits) counter('siragpt_analyzer_cache_hits_total', {}, deltaHits);
  if (deltaMisses) counter('siragpt_analyzer_cache_misses_total', {}, deltaMisses);
  return { hits, misses };
}

function refreshProcessMetrics() {
  try {
    gauge('siragpt_process_uptime_seconds', {}, Math.round(process.uptime()));
    const mem = process.memoryUsage();
    gauge('siragpt_nodejs_memory_bytes', { type: 'rss' }, mem.rss);
    gauge('siragpt_nodejs_memory_bytes', { type: 'heapUsed' }, mem.heapUsed);
    gauge('siragpt_nodejs_memory_bytes', { type: 'heapTotal' }, mem.heapTotal);
    gauge('siragpt_nodejs_memory_bytes', { type: 'external' }, mem.external || 0);
  } catch {
    // never throw from instrumentation
  }
}

module.exports = {
  registerCounter,
  registerGauge,
  registerHistogram,
  counter,
  gauge,
  observe,
  renderText,
  registry,
  trackCircuitBreaker,
  incActiveGuards,
  decActiveGuards,
  getActiveGuards,
  recordAnalyzerCacheStats,
  refreshProcessMetrics,
  _reset,
  _clearRegistry,
  CB_STATE_VALUE,
};
