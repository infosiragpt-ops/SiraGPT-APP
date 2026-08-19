'use strict';

/**
 * levenshtein — edit distance (Wagner-Fischer, 2-row optimization)
 * plus a normalized similarity ratio. Pairs with SimHash (#41,
 * near-duplicate fingerprint) and cosine (#29, semantic): Levenshtein
 * is the right call when you need "did you mean this exact tool name"
 * — typo tolerance for short strings, deterministic results.
 *
 * Implementation: classic dynamic programming, but only two rows of
 * the DP table are kept at a time (O(min(n, m)) memory). We swap
 * inputs so the inner array tracks the shorter string.
 *
 * Public API:
 *   distance(a, b)             → number of single-char edits
 *   distance(a, b, maxDist)    → maxDist + 1 if exceeded (early exit)
 *   ratio(a, b)                → 0..1 ; 1 = identical
 *   closest(query, candidates, { maxDist? }) → { value, distance } | null
 */

function distance(a, b, maxDist) {
  if (typeof a !== 'string') a = String(a == null ? '' : a);
  if (typeof b !== 'string') b = String(b == null ? '' : b);
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Make `a` the shorter string for memory.
  if (a.length > b.length) { const t = a; a = b; b = t; }
  const lenA = a.length;
  const lenB = b.length;
  const cap = Number.isFinite(maxDist) ? Math.floor(maxDist) : Infinity;
  if (lenB - lenA > cap) return cap + 1;

  let prev = new Array(lenA + 1);
  let curr = new Array(lenA + 1);
  for (let i = 0; i <= lenA; i++) prev[i] = i;

  for (let j = 1; j <= lenB; j++) {
    curr[0] = j;
    let rowMin = curr[0];
    for (let i = 1; i <= lenA; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = prev[i] + 1;
      const ins = curr[i - 1] + 1;
      const sub = prev[i - 1] + cost;
      const v = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
      curr[i] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[lenA];
}

function ratio(a, b) {
  if (typeof a !== 'string') a = String(a == null ? '' : a);
  if (typeof b !== 'string') b = String(b == null ? '' : b);
  if (a === b) return 1;
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 1;
  return 1 - distance(a, b) / longer;
}

function closest(query, candidates, { maxDist } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  let bestVal = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = distance(query, c, maxDist);
    if (d < bestDist) {
      bestDist = d;
      bestVal = c;
      if (d === 0) break; // perfect match
    }
  }
  if (bestVal === null) return null;
  if (Number.isFinite(maxDist) && bestDist > maxDist) return null;
  return { value: bestVal, distance: bestDist };
}

module.exports = {
  distance,
  ratio,
  closest,
};
