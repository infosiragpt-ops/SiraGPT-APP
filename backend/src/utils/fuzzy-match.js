'use strict';

/**
 * fuzzy-match — Sublime Text / VS Code-style subsequence fuzzy
 * matcher with scoring. Pairs with the trie (#53, prefix lookup),
 * Levenshtein (#49, edit distance), and BM25 (#33, ranked search):
 * for a command palette where the user types a few characters and
 * expects the right action to surface, this is the right scorer.
 *
 * Algorithm:
 *   - Walk the query left-to-right; advance the candidate cursor
 *     forward to find each query char (case-insensitive).
 *   - Reward consecutive matches (Sublime's "burst" bonus).
 *   - Reward matches at word/camelHump boundaries.
 *   - Reward exact-case match where the query was uppercase.
 *   - Penalize query chars never matched.
 *   - Score is normalized 0..1 (1 = exact prefix, 0 = no match).
 *
 * Public API:
 *   match(query, candidate)
 *     → { score: 0..1, indices: number[] } | null   when no match
 *   rank(query, candidates, { limit?, threshold? })
 *     → [{ value, score, indices }, ...] desc by score
 */

function isWordBoundary(s, i) {
  if (i === 0) return true;
  const prev = s.charCodeAt(i - 1);
  const cur = s.charCodeAt(i);
  // separators: space / underscore / hyphen / dot / slash
  if (prev === 32 || prev === 95 || prev === 45 || prev === 46 || prev === 47) return true;
  // camelHump: prev is lowercase / digit, cur is uppercase
  const prevLower = prev >= 97 && prev <= 122;
  const prevDigit = prev >= 48 && prev <= 57;
  const curUpper = cur >= 65 && cur <= 90;
  if ((prevLower || prevDigit) && curUpper) return true;
  return false;
}

function match(query, candidate) {
  if (typeof query !== 'string' || typeof candidate !== 'string') return null;
  if (query === '') return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const indices = [];
  let qi = 0;
  let prevHit = -2;
  let score = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] !== q[qi]) continue;
    indices.push(ci);
    let bonus = 1;
    if (ci === prevHit + 1) bonus += 2;       // consecutive
    if (isWordBoundary(candidate, ci)) bonus += 3;
    if (query[qi] >= 'A' && query[qi] <= 'Z' && candidate[ci] === query[qi]) bonus += 1;
    score += bonus;
    prevHit = ci;
    qi += 1;
  }
  if (qi < q.length) return null; // unmatched chars
  // Penalize unmatched chars in candidate (relative).
  const maxScore = q.length * 6; // upper bound for normalization
  const normalized = Math.min(1, score / maxScore);
  return { score: normalized, indices };
}

function rank(query, candidates, { limit, threshold = 0 } = {}) {
  if (!Array.isArray(candidates)) return [];
  const out = [];
  for (const c of candidates) {
    const r = match(query, c);
    if (!r || r.score < threshold) continue;
    out.push({ value: c, score: r.score, indices: r.indices });
  }
  out.sort((a, b) => b.score - a.score);
  if (Number.isInteger(limit) && limit > 0) return out.slice(0, limit);
  return out;
}

module.exports = {
  match,
  rank,
  isWordBoundary,
};
