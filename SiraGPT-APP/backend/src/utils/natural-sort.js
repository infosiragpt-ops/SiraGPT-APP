'use strict';

/**
 * natural-sort — comparator that orders 'file2.txt' before 'file10.txt'
 * by chunking each string into alternating numeric / non-numeric runs
 * and comparing chunk-by-chunk: numbers as numbers, text as text.
 *
 * Pairs with the Levenshtein helper (#49) for "did you mean" UX and
 * the trie (#53) for prefix listings — when displaying a sorted set
 * of names this is the comparator users expect (versions, file
 * names, ULIDs / dated IDs).
 *
 * No Intl dependency: stable across runtimes. Case-sensitive by
 * default; pass { caseInsensitive: true } for ASCII-fold compare.
 *
 * Public API:
 *   compare(a, b, opts?)              — comparator (-1 / 0 / 1)
 *   sort(arr, { key?, opts? })        — non-mutating; returns new array
 *   sortBy(arr, fn, opts?)            — sort by derived key
 */

const NUMERIC_RE = /(\d+)/;

function chunkify(s) {
  // Split into alternating non-digit / digit runs.
  return String(s).split(NUMERIC_RE).filter((p) => p !== '');
}

function compareChunk(a, b) {
  const aNum = NUMERIC_RE.test(a) && /^\d+$/.test(a);
  const bNum = NUMERIC_RE.test(b) && /^\d+$/.test(b);
  if (aNum && bNum) {
    // Compare as bigint-safe integers (avoids precision issues at the
    // top of 2^53). For natural-sort needs, decimal comparison via
    // string-length + lexicographic is fine and avoids BigInt cost.
    if (a.length !== b.length) {
      // Strip leading zeros for the length compare.
      const aT = a.replace(/^0+/, '') || '0';
      const bT = b.replace(/^0+/, '') || '0';
      if (aT.length !== bT.length) return aT.length - bT.length;
      return aT < bT ? -1 : aT > bT ? 1 : 0;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compare(a, b, { caseInsensitive = false } = {}) {
  const sa = caseInsensitive ? String(a).toLowerCase() : String(a);
  const sb = caseInsensitive ? String(b).toLowerCase() : String(b);
  if (sa === sb) return 0;
  const ca = chunkify(sa);
  const cb = chunkify(sb);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const r = compareChunk(ca[i], cb[i]);
    if (r !== 0) return r;
  }
  return ca.length - cb.length;
}

function sort(arr, { key, ...opts } = {}) {
  if (!Array.isArray(arr)) throw new TypeError('natural-sort.sort: array required');
  const fn = typeof key === 'function' ? key : (x) => x;
  return arr.slice().sort((a, b) => compare(fn(a), fn(b), opts));
}

function sortBy(arr, fn, opts) {
  return sort(arr, { key: fn, ...(opts || {}) });
}

module.exports = {
  compare,
  sort,
  sortBy,
  chunkify,
};
