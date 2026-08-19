'use strict';

/**
 * attribution-performance-profiler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Times each stage of the attribution pipeline (concept-extractor, graph
 * build, supernode merge, anomaly detection, etc.) and produces a
 * per-stage latency report. Helps catch slow regressions and surfaces
 * which module is the current bottleneck without needing an external
 * profiler.
 *
 * Usage pattern (synchronous and asynchronous-safe):
 *   const prof = createSession();
 *   prof.start('concept-extraction');
 *   const concepts = conceptExtractor.extract(prompt);
 *   prof.end('concept-extraction');
 *   ...
 *   const report = prof.finish();
 *
 * The session keeps a rolling per-stage history in-process so calls
 * can also pull aggregate stats (p50 / p95 / max) for dashboards
 * without spinning up a heavier monitoring stack.
 *
 * Public API:
 *   createSession(opts?)              → Session
 *   measure(label, fn)                → result      (sync or async)
 *   wrap(label, fn)                   → wrappedFn
 *   getAggregateStats(label?)         → AggregateStats[]
 *   resetAggregates(label?)           → void
 *
 * Session object:
 *   .start(label) / .end(label)
 *   .lap(label, deltaMs)              — record a pre-measured delta
 *   .annotation(label, key, value)    — attach side data to a stage
 *   .finish()                         → PerformanceReport
 */

const HISTORY_SIZE = Math.max(8, Number(process.env.SIRAGPT_PERF_HISTORY_SIZE) || 256);
const ENABLED = String(process.env.SIRAGPT_PERF_PROFILER_DISABLED || '').toLowerCase() !== '1';

const aggregateHistory = new Map(); // label → [deltaMs, deltaMs, ...]

function recordAggregate(label, deltaMs) {
  if (!ENABLED) return;
  const list = aggregateHistory.get(label) || [];
  list.push(Number(deltaMs) || 0);
  if (list.length > HISTORY_SIZE) list.shift();
  aggregateHistory.set(label, list);
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function buildAggregate(label, samples) {
  if (!samples || samples.length === 0) return { label, samples: 0 };
  const total = samples.reduce((a, b) => a + b, 0);
  const mean = total / samples.length;
  return {
    label,
    samples: samples.length,
    p50: Number(percentile(samples, 0.5).toFixed(2)),
    p95: Number(percentile(samples, 0.95).toFixed(2)),
    mean: Number(mean.toFixed(2)),
    max: Number(Math.max(...samples).toFixed(2)),
    min: Number(Math.min(...samples).toFixed(2)),
    total: Number(total.toFixed(2)),
  };
}

function getAggregateStats(label) {
  if (label) {
    return buildAggregate(label, aggregateHistory.get(label) || []);
  }
  return [...aggregateHistory.entries()]
    .map(([k, v]) => buildAggregate(k, v))
    .sort((a, b) => (b.p95 || 0) - (a.p95 || 0));
}

function resetAggregates(label) {
  if (label) aggregateHistory.delete(label);
  else aggregateHistory.clear();
}

function createSession(opts = {}) {
  const enabled = ENABLED && (opts.enabled !== false);
  const stages = new Map();
  const annotations = new Map();
  const t0 = enabled ? Date.now() : 0;

  function start(label) {
    if (!enabled || !label) return;
    const list = stages.get(label) || [];
    list.push({ startedAt: Date.now(), endedAt: null });
    stages.set(label, list);
  }

  function end(label) {
    if (!enabled || !label) return 0;
    const list = stages.get(label);
    if (!list || list.length === 0) return 0;
    const open = [...list].reverse().find((s) => s.endedAt === null);
    if (!open) return 0;
    open.endedAt = Date.now();
    const delta = open.endedAt - open.startedAt;
    recordAggregate(label, delta);
    return delta;
  }

  function lap(label, deltaMs) {
    if (!enabled || !label) return;
    const list = stages.get(label) || [];
    list.push({ startedAt: Date.now() - Number(deltaMs || 0), endedAt: Date.now(), prelapped: true });
    stages.set(label, list);
    recordAggregate(label, Number(deltaMs) || 0);
  }

  function annotation(label, key, value) {
    if (!enabled || !label) return;
    const bag = annotations.get(label) || {};
    bag[key] = value;
    annotations.set(label, bag);
  }

  function finish() {
    if (!enabled) return { enabled: false, totalMs: 0, stages: [] };
    const totalMs = Date.now() - t0;
    const out = [];
    for (const [label, list] of stages) {
      let totalForLabel = 0;
      const completed = list.filter((s) => s.endedAt !== null);
      for (const s of completed) totalForLabel += (s.endedAt - s.startedAt);
      out.push({
        label,
        calls: list.length,
        completed: completed.length,
        totalMs: totalForLabel,
        meanMs: completed.length > 0 ? Number((totalForLabel / completed.length).toFixed(2)) : 0,
        annotations: annotations.get(label) || null,
      });
    }
    out.sort((a, b) => b.totalMs - a.totalMs);
    return {
      enabled: true,
      totalMs,
      stages: out,
      stagesCount: out.length,
      coverageMs: out.reduce((a, b) => a + b.totalMs, 0),
    };
  }

  return { start, end, lap, annotation, finish };
}

/** measure(label, fn) — convenience wrapper for sync or async fn. */
function measure(label, fn) {
  if (!ENABLED || typeof fn !== 'function') return fn?.();
  const t0 = Date.now();
  const result = fn();
  if (result && typeof result.then === 'function') {
    return result.then((value) => {
      recordAggregate(label, Date.now() - t0);
      return value;
    }, (err) => {
      recordAggregate(label, Date.now() - t0);
      throw err;
    });
  }
  recordAggregate(label, Date.now() - t0);
  return result;
}

/** wrap(label, fn) — returns a new function that times each invocation. */
function wrap(label, fn) {
  if (!ENABLED || typeof fn !== 'function') return fn;
  return function wrapped(...args) {
    return measure(label, () => fn.apply(this, args));
  };
}

function __resetForTests() {
  aggregateHistory.clear();
}

module.exports = {
  createSession,
  measure,
  wrap,
  getAggregateStats,
  resetAggregates,
  __resetForTests,
  HISTORY_SIZE,
  ENABLED,
};
