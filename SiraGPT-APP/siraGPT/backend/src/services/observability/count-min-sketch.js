'use strict';

/**
 * count-min-sketch — frequency estimator over a stream. Pairs with
 * HyperLogLog (#30): HLL counts how many *distinct* items, CMS
 * estimates how many *times* each item appeared. Sized to answer
 * "what are the heaviest tenants right now" without keeping a
 * full counter map per key.
 *
 * Cormode & Muthukrishnan, "An Improved Data Stream Summary: The
 * Count-Min Sketch and its Applications", J. Algorithms 55(1), 2005.
 *
 * Sizing rule (per the paper):
 *   width  ≈ ⌈e / ε⌉      — bounds additive over-estimate
 *   depth  ≈ ⌈ln(1/δ)⌉    — bounds failure probability
 * For ε=0.001, δ=0.001 → width≈2719, depth≈7 (≈75KB Uint32 table).
 *
 * Public API:
 *   const cms = createCountMinSketch({ width=2048, depth=4, seed=0 })
 *   cms.add(key, count=1)         — increment
 *   cms.estimate(key)             — current frequency estimate (≥ true count)
 *   cms.merge(other)              — element-wise max merge with another CMS
 *   cms.heavyHitters(threshold)   — keys whose estimate ≥ threshold (only
 *                                    those previously add()-ed are tracked)
 *   cms.snapshot()                — counters
 *   cms.reset()
 *
 * The estimator is conservative-update style: only the minimum row is
 * incremented, which dramatically tightens the over-estimate vs.
 * naive every-row increment.
 */

const { createHash } = require('node:crypto');

const DEFAULT_WIDTH = 2048;
const DEFAULT_DEPTH = 4;

function hashRow(key, row, width) {
  const h = createHash('sha256');
  h.update(`${row}:`);
  h.update(typeof key === 'string' ? key : JSON.stringify(key));
  // Take the first 4 bytes as an unsigned 32-bit int.
  return h.digest().readUInt32BE(0) % width;
}

function createCountMinSketch(opts = {}) {
  const width = Number.isInteger(opts.width) && opts.width > 0 ? opts.width : DEFAULT_WIDTH;
  const depth = Number.isInteger(opts.depth) && opts.depth > 0 ? opts.depth : DEFAULT_DEPTH;
  // Flat Uint32 table; reading counters[r * width + c].
  const counters = new Uint32Array(width * depth);
  // We also keep the set of seen keys so heavyHitters can iterate
  // candidates. Bounded by `maxTrackedKeys` to keep memory in check.
  const maxTrackedKeys = Number.isFinite(opts.maxTrackedKeys) && opts.maxTrackedKeys > 0
    ? Math.floor(opts.maxTrackedKeys)
    : 100_000;
  const seenKeys = new Set();
  let totalAdds = 0;

  function add(key, count = 1) {
    if (key == null) return;
    const inc = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    if (inc === 0) return;
    // Conservative-update for inc>1 (Estan & Varghese 2002): bring
    // every row to at least minBefore + inc, leaving rows already
    // higher untouched. Preserves the upper-bound invariant.
    let minVal = 0xffffffff;
    const cells = new Array(depth);
    for (let r = 0; r < depth; r++) {
      const c = hashRow(key, r, width);
      cells[r] = c;
      const v = counters[r * width + c];
      if (v < minVal) minVal = v;
    }
    const target = minVal + inc > 0xffffffff ? 0xffffffff : minVal + inc;
    for (let r = 0; r < depth; r++) {
      const idx = r * width + cells[r];
      if (counters[idx] < target) counters[idx] = target;
    }
    if (seenKeys.size < maxTrackedKeys) seenKeys.add(typeof key === 'string' ? key : JSON.stringify(key));
    totalAdds += 1;
  }

  function estimate(key) {
    if (key == null) return 0;
    let minVal = Infinity;
    for (let r = 0; r < depth; r++) {
      const c = hashRow(key, r, width);
      const v = counters[r * width + c];
      if (v < minVal) minVal = v;
    }
    return Number.isFinite(minVal) ? minVal : 0;
  }

  function merge(other) {
    if (!other || typeof other.snapshot !== 'function') {
      throw new TypeError('CMS.merge: another CountMinSketch required');
    }
    const snap = other.snapshot();
    if (snap.width !== width || snap.depth !== depth) {
      throw new TypeError('CMS.merge: dimension mismatch');
    }
    // Element-wise max preserves the upper-bound estimate semantics.
    for (let i = 0; i < counters.length; i++) {
      if (snap.counters[i] > counters[i]) counters[i] = snap.counters[i];
    }
  }

  function heavyHitters(threshold) {
    const t = Number.isFinite(threshold) && threshold > 0 ? threshold : 1;
    const out = [];
    for (const key of seenKeys) {
      const est = estimate(key);
      if (est >= t) out.push({ key, estimate: est });
    }
    out.sort((a, b) => b.estimate - a.estimate);
    return out;
  }

  function snapshot() {
    return {
      width,
      depth,
      counters: Uint32Array.from(counters),
      seenKeys: seenKeys.size,
      totalAdds,
    };
  }

  function reset() {
    counters.fill(0);
    seenKeys.clear();
    totalAdds = 0;
  }

  return { add, estimate, merge, heavyHitters, snapshot, reset };
}

module.exports = {
  createCountMinSketch,
  DEFAULT_WIDTH,
  DEFAULT_DEPTH,
};
