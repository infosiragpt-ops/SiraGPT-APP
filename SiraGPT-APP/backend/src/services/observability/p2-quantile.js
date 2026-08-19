'use strict';

/**
 * p2-quantile — single-quantile online estimator using the Jain &
 * Chlamtac P² algorithm (1985). O(1) memory per quantile, no sample
 * retention. Pairs with the prompt-cache metrics (#12) and the audit
 * log (#14): those track aggregate counts; this exposes the latency
 * distribution your SLO actually cares about (p50/p95/p99) without
 * shipping every sample to a TSDB.
 *
 * Reference: Jain & Chlamtac, "The P² Algorithm for Dynamic
 * Calculation of Quantiles and Histograms Without Storing
 * Observations", CACM 28(10), 1985.
 *
 * Public API:
 *   const q = createP2Quantile(0.95)
 *   q.observe(value)       — push a sample
 *   q.value()              — current estimate (null until 5 samples)
 *   q.count()              — total samples observed
 *   q.snapshot()           — { p, count, value, markers }
 *
 *   const m = createMultiQuantile([0.5, 0.95, 0.99])
 *   m.observe(value)
 *   m.values()             — { '0.5': …, '0.95': …, '0.99': … }
 */

function createP2Quantile(p) {
  if (typeof p !== 'number' || p <= 0 || p >= 1) {
    throw new TypeError('p2-quantile: p must be in (0,1)');
  }
  // Marker positions n[i] (1-indexed in the paper, 0-indexed here).
  // Heights q[i]: actual sample values at the markers.
  const q = new Array(5);
  const n = [0, 1, 2, 3, 4];
  // Desired marker positions n'[i] grow linearly with count.
  const np = [0, 2 * p, 4 * p, 2 + 2 * p, 4];
  // Desired-position increments dn[i] per observation.
  const dn = [0, p / 2, p, (1 + p) / 2, 1];
  let count = 0;

  function parabolic(i, d) {
    return q[i] + (d / (n[i + 1] - n[i - 1])) * (
      (n[i] - n[i - 1] + d) * (q[i + 1] - q[i]) / (n[i + 1] - n[i]) +
      (n[i + 1] - n[i] - d) * (q[i] - q[i - 1]) / (n[i] - n[i - 1])
    );
  }

  function linear(i, d) {
    return q[i] + d * (q[i + d] - q[i]) / (n[i + d] - n[i]);
  }

  function observe(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    count += 1;
    if (count <= 5) {
      q[count - 1] = value;
      if (count === 5) q.sort((a, b) => a - b);
      return;
    }

    // 1. Find cell k.
    let k;
    if (value < q[0]) { q[0] = value; k = 0; }
    else if (value < q[1]) k = 0;
    else if (value < q[2]) k = 1;
    else if (value < q[3]) k = 2;
    else if (value <= q[4]) k = 3;
    else { q[4] = value; k = 3; }

    // 2. Increment positions of markers k+1..4.
    for (let i = k + 1; i < 5; i++) n[i] += 1;
    for (let i = 0; i < 5; i++) np[i] += dn[i];

    // 3. Adjust internal marker heights if necessary.
    for (let i = 1; i <= 3; i++) {
      const d = np[i] - n[i];
      if ((d >= 1 && n[i + 1] - n[i] > 1) || (d <= -1 && n[i - 1] - n[i] < -1)) {
        const sign = d >= 0 ? 1 : -1;
        let candidate = parabolic(i, sign);
        if (q[i - 1] < candidate && candidate < q[i + 1]) {
          q[i] = candidate;
        } else {
          q[i] = linear(i, sign);
        }
        n[i] += sign;
      }
    }
  }

  function value() {
    if (count < 5) return null;
    return q[2];
  }

  function snapshot() {
    return {
      p,
      count,
      value: value(),
      markers: count >= 5 ? q.slice() : q.slice(0, count),
    };
  }

  return { observe, value, count: () => count, snapshot };
}

function createMultiQuantile(ps) {
  if (!Array.isArray(ps) || ps.length === 0) throw new TypeError('multi-quantile: ps[] required');
  const ests = new Map();
  for (const p of ps) ests.set(p, createP2Quantile(p));

  return {
    observe(value) {
      for (const e of ests.values()) e.observe(value);
    },
    values() {
      const out = {};
      for (const [p, e] of ests) out[String(p)] = e.value();
      return out;
    },
    snapshot() {
      const out = {};
      for (const [p, e] of ests) out[String(p)] = e.snapshot();
      return out;
    },
    count() {
      const first = ests.values().next().value;
      return first ? first.count() : 0;
    },
  };
}

module.exports = {
  createP2Quantile,
  createMultiQuantile,
};
