'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { computeSLO, aggregateRegistry, percentile } = require('../src/health/slo-aggregator');
const { HealthRegistry, Probe } = require('../src/health/probe');

function entry({ status, elapsedMs = 10, cached = false, offsetMs = 0, baseT = Date.parse('2030-01-01T00:00:00Z') }) {
  return {
    timestamp: new Date(baseT + offsetMs).toISOString(),
    status,
    elapsedMs,
    cached,
  };
}

// ─── percentile ──────────────────────────────────────────────────

test('percentile: empty array returns null', () => {
  assert.equal(percentile([], 0.5), null);
});

test('percentile: single value', () => {
  assert.equal(percentile([42], 0.95), 42);
});

test('percentile: median interpolation', () => {
  // 1,2,3,4,5 → p50 = 3
  assert.equal(percentile([5, 1, 3, 4, 2], 0.5), 3);
});

test('percentile: p95 of 1..100 ≈ 95.05', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  const p = percentile(xs, 0.95);
  assert.ok(Math.abs(p - 95.05) < 0.5);
});

test('percentile: rejects p outside [0,1]', () => {
  assert.throws(() => percentile([1, 2, 3], -0.1), /p must be in/);
  assert.throws(() => percentile([1, 2, 3], 1.1), /p must be in/);
});

// ─── computeSLO basics ───────────────────────────────────────────

test('computeSLO: empty input → all nulls', () => {
  const s = computeSLO([]);
  assert.equal(s.windowSamples, 0);
  assert.equal(s.availability, null);
  assert.equal(s.errorRate, null);
  assert.equal(s.successRate, null);
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(s.lastSample, null);
});

test('computeSLO: all-pass → availability 1, errorRate 0', () => {
  const xs = [entry({ status: 'pass' }), entry({ status: 'pass', offsetMs: 1000 })];
  const s = computeSLO(xs);
  assert.equal(s.availability, 1);
  assert.equal(s.errorRate, 0);
  assert.equal(s.counts.pass, 2);
});

test('computeSLO: half-fail → availability 0.5', () => {
  const xs = [
    entry({ status: 'pass' }),
    entry({ status: 'fail', offsetMs: 1000 }),
    entry({ status: 'pass', offsetMs: 2000 }),
    entry({ status: 'fail', offsetMs: 3000 }),
  ];
  const s = computeSLO(xs);
  assert.equal(s.availability, 0.5);
  assert.equal(s.errorRate, 0.5);
});

test('computeSLO: cached entries excluded from latency stats', () => {
  const xs = [
    entry({ status: 'pass', elapsedMs: 100 }),
    entry({ status: 'pass', elapsedMs: 200, cached: true, offsetMs: 1000 }),
    entry({ status: 'pass', elapsedMs: 300, offsetMs: 2000 }),
  ];
  const s = computeSLO(xs);
  assert.equal(s.sampled, 2);
  assert.equal(s.latencyMs.min, 100);
  assert.equal(s.latencyMs.max, 300);
});

test('computeSLO: warn counts as availability hit but as degradedRate', () => {
  const xs = [entry({ status: 'pass' }), entry({ status: 'warn', offsetMs: 1000 })];
  const s = computeSLO(xs);
  assert.equal(s.availability, 1);
  assert.equal(s.errorRate, 0);
  assert.equal(s.degradedRate, 0.5);
});

// ─── Consecutive failure tracking ────────────────────────────────

test('computeSLO: trailing run of fails counted as consecutiveFailures', () => {
  const xs = [
    entry({ status: 'pass' }),
    entry({ status: 'fail', offsetMs: 1000 }),
    entry({ status: 'fail', offsetMs: 2000 }),
    entry({ status: 'timeout', offsetMs: 3000 }),
  ];
  const s = computeSLO(xs);
  assert.equal(s.consecutiveFailures, 3);
});

test('computeSLO: trailing pass clears the consecutiveFailures counter', () => {
  const xs = [
    entry({ status: 'fail' }),
    entry({ status: 'pass', offsetMs: 1000 }),
  ];
  const s = computeSLO(xs);
  assert.equal(s.consecutiveFailures, 0);
});

// ─── Incident tracking + MTTR ────────────────────────────────────

test('computeSLO: recovered incident yields mttrEstimateMs', () => {
  const xs = [
    entry({ status: 'pass', offsetMs: 0 }),
    entry({ status: 'fail', offsetMs: 1000 }),
    entry({ status: 'fail', offsetMs: 2000 }),
    entry({ status: 'pass', offsetMs: 5000 }), // recovers — duration 4000
  ];
  const s = computeSLO(xs);
  assert.equal(s.incidents.total, 1);
  assert.equal(s.incidents.recovered, 1);
  assert.equal(s.mttrEstimateMs, 4000);
});

test('computeSLO: open incident at tail is counted but excluded from MTTR', () => {
  const xs = [
    entry({ status: 'pass', offsetMs: 0 }),
    entry({ status: 'fail', offsetMs: 1000 }),
    entry({ status: 'fail', offsetMs: 2000 }),
  ];
  const s = computeSLO(xs);
  assert.equal(s.incidents.open, 1);
  assert.equal(s.incidents.recovered, 0);
  assert.equal(s.mttrEstimateMs, null);
});

test('computeSLO: MTTR averages multiple recovered incidents', () => {
  const xs = [
    entry({ status: 'fail', offsetMs: 0 }),
    entry({ status: 'pass', offsetMs: 1000 }),     // incident 1 = 1000
    entry({ status: 'fail', offsetMs: 2000 }),
    entry({ status: 'pass', offsetMs: 5000 }),     // incident 2 = 3000
  ];
  const s = computeSLO(xs);
  assert.equal(s.incidents.recovered, 2);
  assert.equal(s.mttrEstimateMs, 2000);
});

// ─── Trend ───────────────────────────────────────────────────────

test('computeSLO: stable trend when failure rate roughly equal', () => {
  const xs = [
    entry({ status: 'pass' }),
    entry({ status: 'pass', offsetMs: 1000 }),
    entry({ status: 'pass', offsetMs: 2000 }),
    entry({ status: 'pass', offsetMs: 3000 }),
  ];
  const s = computeSLO(xs);
  assert.equal(s.trend, 'stable');
});

test('computeSLO: degrading trend when fails cluster at the end', () => {
  const xs = [
    entry({ status: 'pass' }),
    entry({ status: 'pass', offsetMs: 1000 }),
    entry({ status: 'fail', offsetMs: 2000 }),
    entry({ status: 'fail', offsetMs: 3000 }),
  ];
  const s = computeSLO(xs);
  assert.equal(s.trend, 'degrading');
});

test('computeSLO: improving trend when fails cluster at the start', () => {
  const xs = [
    entry({ status: 'fail' }),
    entry({ status: 'fail', offsetMs: 1000 }),
    entry({ status: 'pass', offsetMs: 2000 }),
    entry({ status: 'pass', offsetMs: 3000 }),
  ];
  const s = computeSLO(xs);
  assert.equal(s.trend, 'improving');
});

test('computeSLO: small samples (< 4) default to stable', () => {
  const xs = [entry({ status: 'pass' }), entry({ status: 'fail', offsetMs: 1000 })];
  const s = computeSLO(xs);
  assert.equal(s.trend, 'stable');
});

// ─── Window clipping ─────────────────────────────────────────────

test('computeSLO: windowMs clips older entries', () => {
  const baseT = Date.parse('2030-01-01T00:00:00Z');
  const xs = [
    entry({ status: 'fail', offsetMs: 0, baseT }),
    entry({ status: 'pass', offsetMs: 1000, baseT }),
    entry({ status: 'pass', offsetMs: 9_000, baseT }),
  ];
  // "now" is baseT + 10s, window = 5s → only the entry at +9s survives.
  const s = computeSLO(xs, { windowMs: 5000, now: () => baseT + 10_000 });
  assert.equal(s.windowSamples, 1);
  assert.equal(s.availability, 1);
});

// ─── Percentile correctness ──────────────────────────────────────

test('computeSLO: p50/p95/p99 fields are rounded ints', () => {
  const xs = Array.from({ length: 50 }, (_, i) =>
    entry({ status: 'pass', elapsedMs: i + 1, offsetMs: i * 100 }),
  );
  const s = computeSLO(xs);
  assert.equal(typeof s.latencyMs.p50, 'number');
  assert.equal(typeof s.latencyMs.p95, 'number');
  assert.equal(typeof s.latencyMs.p99, 'number');
  assert.ok(s.latencyMs.p50 < s.latencyMs.p95);
  assert.ok(s.latencyMs.p95 <= s.latencyMs.p99);
});

// ─── aggregateRegistry ───────────────────────────────────────────

function makeProbeWithHistory(name, statuses, category = 'critical') {
  const p = new Probe({
    name,
    category,
    timeoutMs: 100,
    ttlMs: 0,
    historySize: 100,
    check: async () => ({ status: 'pass' }),
  });
  const baseT = Date.parse('2030-01-01T00:00:00Z');
  for (let i = 0; i < statuses.length; i++) {
    p._history.push({
      timestamp: new Date(baseT + i * 1000).toISOString(),
      status: statuses[i],
      elapsedMs: 10 + i,
      cached: false,
    });
  }
  return p;
}

test('aggregateRegistry: empty registry → empty probes array', () => {
  const r = new HealthRegistry();
  const agg = aggregateRegistry(r);
  assert.equal(agg.probes.length, 0);
  assert.equal(agg.overall.availability, null);
});

test('aggregateRegistry: rejects non-registry input', () => {
  assert.throws(() => aggregateRegistry(null), /HealthRegistry-like/);
  assert.throws(() => aggregateRegistry({}), /HealthRegistry-like/);
});

test('aggregateRegistry: rolls up worst availability across critical probes', () => {
  const r = new HealthRegistry();
  r.add(makeProbeWithHistory('a', ['pass', 'pass', 'pass', 'pass'], 'critical'));
  r.add(makeProbeWithHistory('b', ['pass', 'fail', 'fail', 'pass'], 'critical'));
  r.add(makeProbeWithHistory('c', ['fail', 'fail', 'fail', 'fail'], 'degraded'));
  const agg = aggregateRegistry(r);
  // Worst critical = b with availability 0.5; c is degraded so excluded.
  assert.equal(agg.overall.weakestProbe, 'b');
  assert.equal(agg.overall.availability, 0.5);
});

test('aggregateRegistry: falls back to all probes when no critical probes', () => {
  const r = new HealthRegistry();
  r.add(makeProbeWithHistory('a', ['pass', 'pass', 'pass'], 'degraded'));
  r.add(makeProbeWithHistory('b', ['fail', 'fail', 'fail'], 'degraded'));
  const agg = aggregateRegistry(r);
  assert.equal(agg.overall.weakestProbe, 'b');
});

test('aggregateRegistry: counts trend buckets', () => {
  const r = new HealthRegistry();
  r.add(makeProbeWithHistory('improving', ['fail', 'fail', 'pass', 'pass'], 'critical'));
  r.add(makeProbeWithHistory('degrading', ['pass', 'pass', 'fail', 'fail'], 'critical'));
  r.add(makeProbeWithHistory('stable', ['pass', 'pass', 'pass', 'pass'], 'critical'));
  const agg = aggregateRegistry(r);
  assert.equal(agg.overall.improvingCount, 1);
  assert.equal(agg.overall.degradingCount, 1);
});
