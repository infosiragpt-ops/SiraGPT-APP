'use strict';

/**
 * sliding-counter — fixed-granularity sliding-window counter. Pairs
 * with the cost-budget breaker (#10), token-bucket limiter (#31),
 * and EWMA tracker (#45). When the question is "how many events
 * happened in the last N seconds", this answers in O(1) per record
 * with a small ring-buffer of bucketed sums.
 *
 * Public API:
 *   const c = createSlidingCounter({ windowSec, bucketSec=1, now })
 *     windowSec must be a multiple of bucketSec.
 *   c.record(value=1)              — add to the current bucket
 *   c.sum()                        — total across the window
 *   c.peak()                       — highest single-bucket value in window
 *   c.avgPerBucket()               — sum / nBuckets
 *   c.snapshot()                   — { sum, peak, buckets, windowSec, ... }
 *   c.reset()
 *
 * Buckets older than the window are zeroed lazily on next access.
 */

function createSlidingCounter(opts = {}) {
  const windowSec = Number.isInteger(opts.windowSec) && opts.windowSec > 0 ? opts.windowSec : 60;
  const bucketSec = Number.isInteger(opts.bucketSec) && opts.bucketSec > 0 ? opts.bucketSec : 1;
  if (windowSec % bucketSec !== 0) throw new TypeError('sliding-counter: windowSec must be multiple of bucketSec');
  const now = typeof opts.now === 'function' ? opts.now : () => Math.floor(Date.now() / 1000);

  const nBuckets = Math.ceil(windowSec / bucketSec);
  const data = new Float64Array(nBuckets);
  let lastBucket = -1;

  function currentBucket() {
    return Math.floor(now() / bucketSec);
  }

  function sweep() {
    const cur = currentBucket();
    if (lastBucket === -1) { lastBucket = cur; return cur; }
    const drift = cur - lastBucket;
    if (drift <= 0) return cur;
    if (drift >= nBuckets) {
      data.fill(0);
    } else {
      // Zero out the buckets we've slid past.
      for (let i = 1; i <= drift; i++) {
        data[(lastBucket + i) % nBuckets] = 0;
      }
    }
    lastBucket = cur;
    return cur;
  }

  function record(value = 1) {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    const cur = sweep();
    data[cur % nBuckets] += v;
  }

  function sum() {
    sweep();
    let total = 0;
    for (let i = 0; i < nBuckets; i++) total += data[i];
    return total;
  }

  function peak() {
    sweep();
    let max = 0;
    for (let i = 0; i < nBuckets; i++) if (data[i] > max) max = data[i];
    return max;
  }

  function avgPerBucket() {
    return sum() / nBuckets;
  }

  function snapshot() {
    return {
      sum: sum(),
      peak: peak(),
      buckets: nBuckets,
      windowSec,
      bucketSec,
    };
  }

  function reset() {
    data.fill(0);
    lastBucket = -1;
  }

  return { record, sum, peak, avgPerBucket, snapshot, reset };
}

module.exports = {
  createSlidingCounter,
};
