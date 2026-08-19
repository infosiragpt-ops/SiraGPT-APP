/**
 * bootstrap — resampled confidence intervals for benchmark metrics.
 *
 * Ouyang et al. 2022 always report 95% confidence intervals next to
 * their rate metrics (Figure 1 error bars, Table 1 ± values). A point
 * estimate like "misconception_rate: 0.12" is ambiguous — is it
 * 0.12 ± 0.02 or 0.12 ± 0.10? On a 25-item benchmark, the answer
 * matters a LOT for whether you can claim "my change helped".
 *
 * We implement nonparametric bootstrap: resample the observed outcomes
 * with replacement B times (default 1000), recompute the statistic on
 * each resample, take the 2.5th and 97.5th percentiles as the 95% CI.
 * Works for any rate metric — agnostic to the underlying distribution.
 *
 * Two public APIs:
 *   rateCi(outcomes, { confidence, nBootstrap }) — for 0/1 outcomes
 *   bootstrapCi(samples, statistic, opts)        — for arbitrary stats
 *
 * Seeded PRNG so tests are reproducible. Uses a Mulberry32 LCG — small,
 * fast, good-enough-for-bootstrap distribution properties.
 */

const DEFAULT_B = 1000;
const DEFAULT_CONFIDENCE = 0.95;

/**
 * Mulberry32 PRNG with a stable seed so test runs are deterministic.
 * We still accept a user-supplied seed for reproducibility in specific
 * analyses.
 */
function makeRng(seed) {
  let state = (seed >>> 0) || 0x9e3779b9; // golden-ratio default
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sample WITH REPLACEMENT n items from `arr` using `rng`.
 * Returns a new array; input is untouched.
 */
function resample(arr, n, rng) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = arr[Math.floor(rng() * arr.length)];
  }
  return out;
}

/**
 * Percentile of a sorted array. Linear interpolation between neighbouring
 * values when the percentile falls between indices.
 */
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (sortedArr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const weight = idx - lo;
  return sortedArr[lo] * (1 - weight) + sortedArr[hi] * weight;
}

/**
 * Compute bootstrap CI for an arbitrary statistic.
 *
 * @param {Array} samples                 — observed data
 * @param {function(Array) → number} stat — computes the statistic over a sample
 * @param {object} [opts]
 *   - confidence: default 0.95 (→ [2.5th, 97.5th] percentile)
 *   - nBootstrap: default 1000
 *   - seed: default 42 for reproducibility
 *
 * @returns {{ point: number, ci95: [number, number], nBootstrap: number }}
 */
function bootstrapCi(samples, stat, opts = {}) {
  const { confidence = DEFAULT_CONFIDENCE, nBootstrap = DEFAULT_B, seed = 42 } = opts;
  if (!Array.isArray(samples) || samples.length === 0) {
    return { point: 0, ci95: [0, 0], nBootstrap: 0 };
  }
  const point = stat(samples);

  const rng = makeRng(seed);
  const stats = new Array(nBootstrap);
  for (let b = 0; b < nBootstrap; b++) {
    const resampled = resample(samples, samples.length, rng);
    stats[b] = stat(resampled);
  }
  stats.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return {
    point,
    ci95: [percentile(stats, alpha), percentile(stats, 1 - alpha)],
    nBootstrap,
  };
}

/**
 * Shortcut for the common case: 0/1 outcomes (0 = failure, 1 = success).
 * Returns the rate + 95% CI.
 *
 * @param {Array<0|1>} outcomes
 * @param {object} [opts]
 *
 * @returns {{ rate: number, ci95: [number, number], n: number }}
 */
function rateCi(outcomes, opts = {}) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    return { rate: 0, ci95: [0, 0], n: 0 };
  }
  const result = bootstrapCi(outcomes, (sample) => {
    let sum = 0;
    for (const x of sample) sum += x ? 1 : 0;
    return sum / sample.length;
  }, opts);
  return { rate: result.point, ci95: result.ci95, n: outcomes.length };
}

/**
 * Wilson score interval for a binomial proportion — FASTER alternative
 * to full bootstrap for pure 0/1 outcomes. Closed-form, no resampling.
 * Useful when callers need a quick CI without paying for 1000 resamples.
 *
 * Less flexible than bootstrap (only works for rates) but 100x faster.
 */
function wilsonInterval(successes, n, confidence = 0.95) {
  if (n === 0) return { rate: 0, ci95: [0, 0] };
  const p = successes / n;
  // z for 95% = 1.959964; use a more general form for caller's confidence.
  const z = zScoreForConfidence(confidence);
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    rate: p,
    ci95: [Math.max(0, center - half), Math.min(1, center + half)],
  };
}

/**
 * Approximate inverse normal for standard two-tailed confidence levels.
 * Covers common values; falls back to 1.96 for anything else.
 */
function zScoreForConfidence(confidence) {
  if (Math.abs(confidence - 0.90) < 1e-6) return 1.6448536;
  if (Math.abs(confidence - 0.95) < 1e-6) return 1.959964;
  if (Math.abs(confidence - 0.99) < 1e-6) return 2.5758293;
  return 1.959964;
}

/**
 * Compute whether two rates are significantly different using non-
 * overlapping 95% CIs as a conservative test. Returns true when
 * the CIs do NOT overlap — a sign that the difference is real at
 * roughly the 95% level. This is conservative compared to a proper
 * two-sample z-test but intuitive to display in reports.
 */
function ratesDifferSignificantly(a, b) {
  if (!a?.ci95 || !b?.ci95) return false;
  // Non-overlapping iff a's upper < b's lower OR b's upper < a's lower.
  return a.ci95[1] < b.ci95[0] || b.ci95[1] < a.ci95[0];
}

module.exports = {
  bootstrapCi,
  rateCi,
  wilsonInterval,
  ratesDifferSignificantly,
  zScoreForConfidence,
  percentile,
  resample,
  makeRng,
  DEFAULT_B,
  DEFAULT_CONFIDENCE,
};
