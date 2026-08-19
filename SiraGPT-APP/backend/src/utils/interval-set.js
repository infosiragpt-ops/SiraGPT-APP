'use strict';

/**
 * interval-set — operations on a set of half-open numeric intervals
 * [start, end). Pairs with the Range parser (#89, byte ranges) and
 * the cron parser (#54, time windows): when you need to track which
 * spans of a 1D resource are taken vs free (download-resume chunks,
 * scheduled time slots, RAG-chunk coverage), this is the data
 * structure to reach for.
 *
 * Intervals are stored sorted, non-overlapping, normalized at every
 * mutation so containsPoint / containsRange are O(log n) via binary
 * search. The class is value-semantics: every mutating method
 * returns a NEW IntervalSet, so callers can keep prior states for
 * undo / time-travel debugging.
 *
 * Public API:
 *   IntervalSet.from(arr)                   — array of [start, end] pairs
 *   set.add(start, end)                     → IntervalSet (new)
 *   set.subtract(start, end)                → IntervalSet (new)
 *   set.containsPoint(x)                    → boolean
 *   set.containsRange(start, end)           → boolean
 *   set.gaps(min, max)                      → [[start, end], ...]
 *   set.union(other) / set.intersect(other) → IntervalSet
 *   set.totalLength()                       → number
 *   set.toArray()                           → [[start, end], ...]
 */

function normalize(intervals) {
  if (intervals.length === 0) return [];
  const sorted = intervals
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && s < e)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    if (out.length === 0 || s > out[out.length - 1][1]) {
      out.push([s, e]);
    } else {
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    }
  }
  return out;
}

function bisectStart(intervals, x) {
  // Find rightmost interval whose start <= x.
  let lo = 0, hi = intervals.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (intervals[mid][0] <= x) lo = mid + 1; else hi = mid;
  }
  return lo - 1;
}

class IntervalSet {
  constructor(intervals) {
    this._iv = normalize(Array.isArray(intervals) ? intervals : []);
    Object.freeze(this._iv);
  }

  static from(arr) { return new IntervalSet(arr || []); }

  add(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return this;
    return new IntervalSet([...this._iv, [start, end]]);
  }

  subtract(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return this;
    const out = [];
    for (const [s, e] of this._iv) {
      if (e <= start || s >= end) { out.push([s, e]); continue; }
      if (s < start) out.push([s, start]);
      if (e > end) out.push([end, e]);
    }
    return new IntervalSet(out);
  }

  containsPoint(x) {
    if (!Number.isFinite(x)) return false;
    const i = bisectStart(this._iv, x);
    return i >= 0 && this._iv[i][1] > x;
  }

  containsRange(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return false;
    const i = bisectStart(this._iv, start);
    return i >= 0 && this._iv[i][0] <= start && this._iv[i][1] >= end;
  }

  gaps(min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return [];
    const out = [];
    let cursor = min;
    for (const [s, e] of this._iv) {
      if (e <= min) continue;
      if (s >= max) break;
      const gs = Math.max(cursor, min);
      const ge = Math.min(s, max);
      if (gs < ge) out.push([gs, ge]);
      cursor = Math.max(cursor, e);
      if (cursor >= max) break;
    }
    if (cursor < max) out.push([cursor, max]);
    return out;
  }

  union(other) {
    if (!(other instanceof IntervalSet)) throw new TypeError('union: IntervalSet required');
    return new IntervalSet([...this._iv, ...other._iv]);
  }

  intersect(other) {
    if (!(other instanceof IntervalSet)) throw new TypeError('intersect: IntervalSet required');
    const out = [];
    let i = 0, j = 0;
    const a = this._iv, b = other._iv;
    while (i < a.length && j < b.length) {
      const lo = Math.max(a[i][0], b[j][0]);
      const hi = Math.min(a[i][1], b[j][1]);
      if (lo < hi) out.push([lo, hi]);
      if (a[i][1] < b[j][1]) i++; else j++;
    }
    return new IntervalSet(out);
  }

  totalLength() {
    let n = 0;
    for (const [s, e] of this._iv) n += e - s;
    return n;
  }

  toArray() { return this._iv.map((p) => [p[0], p[1]]); }
  get size() { return this._iv.length; }
}

module.exports = {
  IntervalSet,
  normalize,
};
