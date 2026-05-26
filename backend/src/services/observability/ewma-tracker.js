'use strict';

/**
 * ewma-tracker — exponentially-weighted moving average + EWMVar of a
 * scalar stream (typically latency in ms). Lets callers compute
 * adaptive timeouts as mean + k*stddev instead of hard-coded
 * constants. Pairs with the P² quantile estimator (#28): this one
 * tracks the *recent* central tendency cheaply, P² gives you the
 * tail.
 *
 * Welford-style EWMA + EWMVar (West 1979 incremental update):
 *   meanₙ   = (1 - α) · meanₙ₋₁ + α · x
 *   varₙ    = (1 - α) · (varₙ₋₁ + α · (x - meanₙ₋₁)²)
 *   stddev  = sqrt(var)
 *
 * α (alpha) ∈ (0, 1]: higher = more reactive, lower = smoother.
 * Default 0.1 (≈ last 10 samples dominate).
 *
 * Public API:
 *   const t = createEwmaTracker({ alpha = 0.1 })
 *   t.observe(value)
 *   t.mean()            — current EWMA
 *   t.variance()        — current EWMVar
 *   t.stddev()
 *   t.adaptiveDeadline(k = 3, floor = 0, ceil = Infinity)
 *                       — mean + k * stddev clamped
 *   t.count() / t.snapshot() / t.reset()
 */

const DEFAULT_ALPHA = 0.1;

function createEwmaTracker(opts = {}) {
  const alpha = Number.isFinite(opts.alpha) && opts.alpha > 0 && opts.alpha <= 1
    ? opts.alpha
    : DEFAULT_ALPHA;

  let mean = 0;
  let variance = 0;
  let count = 0;

  function observe(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    count += 1;
    if (count === 1) {
      mean = value;
      variance = 0;
      return;
    }
    const diff = value - mean;
    const incr = alpha * diff;
    // Update variance BEFORE updating mean (West's correction).
    variance = (1 - alpha) * (variance + diff * incr);
    mean = mean + incr;
  }

  function stddev() {
    return Math.sqrt(Math.max(0, variance));
  }

  function adaptiveDeadline(k = 3, floor = 0, ceil = Infinity) {
    if (count === 0) return Math.max(floor, Math.min(ceil, 0));
    const v = mean + Math.max(0, k) * stddev();
    return Math.max(floor, Math.min(ceil, v));
  }

  function snapshot() {
    return {
      alpha,
      count,
      mean,
      variance,
      stddev: stddev(),
    };
  }

  function reset() {
    mean = 0; variance = 0; count = 0;
  }

  return {
    observe,
    mean: () => mean,
    variance: () => variance,
    stddev,
    adaptiveDeadline,
    count: () => count,
    snapshot,
    reset,
  };
}

module.exports = {
  createEwmaTracker,
  DEFAULT_ALPHA,
};
