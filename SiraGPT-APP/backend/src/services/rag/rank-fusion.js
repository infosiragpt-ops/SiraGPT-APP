'use strict';

/**
 * rank-fusion — Reciprocal Rank Fusion for hybrid retrieval. Fuses
 * N rankings (cosine via vector-ops #29, BM25 via #33, any other
 * scorer) without normalizing scores: each item contributes
 * Σ weightᵢ / (k + rankᵢ) across the rankings it appears in.
 *
 * Reference: Cormack, Clarke, Buettcher (2009), "Reciprocal Rank
 * Fusion outperforms Condorcet and individual Rank Learning
 * Methods", SIGIR. Default k=60 from the paper.
 *
 * Why RRF and not weighted-sum-of-scores:
 *   - Score scales differ wildly (cosine ∈ [-1,1] vs BM25 ∈ [0, ∞)).
 *   - Normalizing is fragile; rank-based fusion is scale-free and
 *     robust to outliers.
 *
 * Public API:
 *   reciprocalRankFusion(rankings, { k = 60, topK = 10, weights? })
 *     rankings: array of arrays, each [{ id, score? }, ...] ordered desc.
 *     weights:  optional array same length as rankings; defaults to 1.
 *     → [{ id, fusedScore, contributions: { 0: { rank, weighted }, ...} }, ...]
 *
 *   weightedRankFusion(rankings, opts) — alias accepting rankings of
 *     plain id arrays (no score field needed).
 */

const DEFAULT_K = 60;
const DEFAULT_TOP_K = 10;

function reciprocalRankFusion(rankings, opts = {}) {
  if (!Array.isArray(rankings)) throw new TypeError('rrf: rankings array required');
  const k = Number.isFinite(opts.k) && opts.k > 0 ? opts.k : DEFAULT_K;
  const topK = Number.isFinite(opts.topK) && opts.topK > 0 ? Math.floor(opts.topK) : DEFAULT_TOP_K;
  const weights = Array.isArray(opts.weights)
    ? opts.weights.map((w) => Number.isFinite(w) && w >= 0 ? w : 1)
    : new Array(rankings.length).fill(1);
  if (weights.length !== rankings.length) {
    throw new TypeError('rrf: weights.length must match rankings.length');
  }

  /** Map<id, { fusedScore, contributions }> */
  const acc = new Map();
  for (let listIdx = 0; listIdx < rankings.length; listIdx++) {
    const list = rankings[listIdx];
    if (!Array.isArray(list)) continue;
    const w = weights[listIdx];
    if (w === 0) continue;
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const id = item && (item.id !== undefined ? item.id : item);
      if (id == null) continue;
      const contribution = w / (k + rank + 1);
      let row = acc.get(id);
      if (!row) {
        row = { id, fusedScore: 0, contributions: {} };
        acc.set(id, row);
      }
      row.fusedScore += contribution;
      row.contributions[listIdx] = { rank: rank + 1, weighted: contribution };
    }
  }

  return [...acc.values()]
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .slice(0, topK);
}

function weightedRankFusion(rankings, opts = {}) {
  // Accepts arrays of plain id strings/numbers in addition to {id} objects.
  const normalized = rankings.map((list) =>
    Array.isArray(list)
      ? list.map((it) => (it && typeof it === 'object' ? it : { id: it }))
      : [],
  );
  return reciprocalRankFusion(normalized, opts);
}

module.exports = {
  reciprocalRankFusion,
  weightedRankFusion,
  DEFAULT_K,
  DEFAULT_TOP_K,
};
