/**
 * slo-aggregator.js
 *
 * Cross-probe SLO aggregation over a window of probe history records.
 * Extends what `summarizeHistory` in probe.js produces (counts +
 * latency percentiles) with operationally useful signals:
 *
 *   - availability       Fraction of non-cached samples that passed.
 *   - errorRate          Fraction that failed or timed out.
 *   - degradedRate       Fraction that warned.
 *   - latencyP50/P95/P99 Real round-trip percentiles (cached excluded).
 *   - mttrEstimateMs     Mean Time To Recovery — average duration of
 *                        contiguous fail/timeout runs that recovered
 *                        within the window. Null if no recovery yet.
 *   - consecutiveFailures Current trailing failure run.
 *   - lastIncidentAt     Timestamp where the last fail/timeout run began.
 *   - trend              'improving' | 'stable' | 'degrading' based on
 *                        comparing first half vs second half failure rate.
 *
 * Why each metric:
 *   availability + errorRate    answer "is the service usable right now"
 *   p95/p99 latency             answer "how fast is it when it works"
 *   mttrEstimateMs              answers "how long do hiccups usually last"
 *   trend                       answers "is the situation getting worse"
 *
 * Inputs are the raw history entries produced by Probe._record():
 *   { timestamp, status, elapsedMs, cached, error? }
 */

'use strict';

const TERMINAL_STATUSES = new Set(['pass', 'warn', 'fail', 'timeout']);
const FAIL_STATUSES = new Set(['fail', 'timeout']);

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new TypeError(`percentile: p must be in [0,1], got ${p}`);
  }
  const sorted = values
    .filter((v) => Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function safeTimestamp(value) {
  if (!value) return null;
  const t = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Computes an SLO snapshot from a set of probe history entries.
 *
 * @param {Array} entries  Probe history records (oldest first).
 * @param {object} [opts]
 * @param {number} [opts.windowMs] Optional clipping window; entries older than
 *   (now - windowMs) are ignored. By default the entire history is used.
 * @param {function} [opts.now]    Injectable clock.
 */
function computeSLO(entries, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const list = Array.isArray(entries) ? entries.slice() : [];

  if (Number.isFinite(opts.windowMs) && opts.windowMs > 0) {
    const cutoff = now() - opts.windowMs;
    while (list.length && safeTimestamp(list[0].timestamp) < cutoff) list.shift();
  }

  const total = list.length;
  const byStatus = Object.create(null);
  const latencies = [];

  let passes = 0;
  let warns = 0;
  let fails = 0;
  let consecutiveFailures = 0;

  // Incident tracking — contiguous fail/timeout runs.
  const incidents = []; // { startedAt, endedAt, durationMs, samples, recovered }
  let openIncident = null;

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const status = e.status;
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (!e.cached && Number.isFinite(e.elapsedMs)) latencies.push(e.elapsedMs);

    if (status === 'pass') passes += 1;
    else if (status === 'warn') warns += 1;
    else if (FAIL_STATUSES.has(status)) fails += 1;

    if (FAIL_STATUSES.has(status)) {
      consecutiveFailures += 1;
      if (!openIncident) {
        openIncident = {
          startedAt: e.timestamp || null,
          endedAt: null,
          durationMs: null,
          samples: 1,
          recovered: false,
        };
      } else {
        openIncident.samples += 1;
      }
    } else {
      if (status === 'pass' || status === 'warn') consecutiveFailures = 0;
      if (openIncident) {
        const startT = safeTimestamp(openIncident.startedAt);
        const endT = safeTimestamp(e.timestamp);
        openIncident.endedAt = e.timestamp || null;
        openIncident.recovered = true;
        openIncident.durationMs = startT && endT ? Math.max(0, endT - startT) : null;
        incidents.push(openIncident);
        openIncident = null;
      }
    }
  }

  // Open incident at the tail of the window — not yet recovered.
  if (openIncident) incidents.push(openIncident);

  const sampled = latencies.length;
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const p99 = percentile(latencies, 0.99);

  const evaluable = passes + warns + fails;
  const availability = evaluable > 0 ? (passes + warns) / evaluable : null;
  const errorRate = evaluable > 0 ? fails / evaluable : null;
  const degradedRate = evaluable > 0 ? warns / evaluable : null;
  const successRate = evaluable > 0 ? passes / evaluable : null;

  // MTTR over recovered incidents only — open incidents pollute the
  // estimate because we don't yet know their final duration.
  const recovered = incidents.filter((i) => i.recovered && Number.isFinite(i.durationMs));
  const mttrEstimateMs = recovered.length
    ? Math.round(recovered.reduce((acc, i) => acc + i.durationMs, 0) / recovered.length)
    : null;

  const lastIncident = incidents.length ? incidents[incidents.length - 1] : null;

  // Trend: compare failure-rate of first half vs second half.
  const trend = computeTrend(list);

  // Last sample summary.
  const lastEntry = total ? list[total - 1] : null;

  return {
    windowSamples: total,
    sampled,
    byStatus,
    counts: { pass: passes, warn: warns, fail: fails },
    successRate,
    availability,
    errorRate,
    degradedRate,
    consecutiveFailures,
    latencyMs: {
      p50: p50 == null ? null : Math.round(p50),
      p95: p95 == null ? null : Math.round(p95),
      p99: p99 == null ? null : Math.round(p99),
      min: latencies.length ? Math.min(...latencies) : null,
      max: latencies.length ? Math.max(...latencies) : null,
    },
    incidents: {
      total: incidents.length,
      recovered: recovered.length,
      open: incidents.filter((i) => !i.recovered).length,
      lastStartedAt: lastIncident ? lastIncident.startedAt : null,
      lastEndedAt: lastIncident ? lastIncident.endedAt : null,
      lastDurationMs: lastIncident ? lastIncident.durationMs : null,
    },
    mttrEstimateMs,
    trend,
    lastSample: lastEntry
      ? { timestamp: lastEntry.timestamp, status: lastEntry.status, elapsedMs: lastEntry.elapsedMs }
      : null,
  };
}

function computeTrend(entries) {
  if (entries.length < 4) return 'stable';
  const mid = Math.floor(entries.length / 2);
  const firstHalf = entries.slice(0, mid);
  const secondHalf = entries.slice(mid);
  const failRate = (slice) => {
    let fails = 0;
    let total = 0;
    for (const e of slice) {
      if (!TERMINAL_STATUSES.has(e.status)) continue;
      total += 1;
      if (FAIL_STATUSES.has(e.status)) fails += 1;
    }
    return total > 0 ? fails / total : 0;
  };
  const first = failRate(firstHalf);
  const second = failRate(secondHalf);
  const delta = second - first;
  // Treat ±5pp as noise.
  if (delta > 0.05) return 'degrading';
  if (delta < -0.05) return 'improving';
  return 'stable';
}

/**
 * Roll up SLO across a HealthRegistry: returns per-probe SLO + an
 * `overall` block that picks the worst signal across critical probes.
 *
 * @param {HealthRegistry} registry
 * @param {object} [opts]
 * @param {number} [opts.windowMs]      Same semantics as computeSLO.
 * @param {number} [opts.historyLimit]  Optional cap on records inspected per probe.
 * @param {function} [opts.now]
 */
function aggregateRegistry(registry, opts = {}) {
  if (!registry || typeof registry.list !== 'function') {
    throw new TypeError('aggregateRegistry: HealthRegistry-like object required');
  }
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const probes = registry.list();
  const perProbe = probes.map((probe) => {
    const records = typeof probe.getHistory === 'function'
      ? probe.getHistory(opts.historyLimit)
      : [];
    const slo = computeSLO(records, { windowMs: opts.windowMs, now });
    return {
      name: probe.name,
      category: probe.category,
      historySize: typeof probe.historySize === 'number' ? probe.historySize : null,
      slo,
    };
  });

  // Overall: worst availability across critical probes (the ones
  // whose failure should page operators).
  const critical = perProbe.filter((p) => p.category === 'critical');
  const reference = critical.length ? critical : perProbe;
  const overall = reference.reduce(
    (acc, p) => {
      const a = p.slo.availability;
      if (Number.isFinite(a) && (acc.availability === null || a < acc.availability)) {
        acc.availability = a;
        acc.weakestProbe = p.name;
      }
      const e = p.slo.errorRate;
      if (Number.isFinite(e) && e > (acc.errorRate || 0)) acc.errorRate = e;
      acc.totalSamples += p.slo.windowSamples || 0;
      if (p.slo.trend === 'degrading') acc.degradingCount += 1;
      else if (p.slo.trend === 'improving') acc.improvingCount += 1;
      return acc;
    },
    {
      availability: null,
      errorRate: 0,
      totalSamples: 0,
      degradingCount: 0,
      improvingCount: 0,
      weakestProbe: null,
    },
  );

  return {
    timestamp: new Date(now()).toISOString(),
    overall,
    probes: perProbe,
  };
}

module.exports = {
  computeSLO,
  aggregateRegistry,
  percentile,
};
