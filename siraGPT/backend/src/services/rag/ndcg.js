"use strict";

/**
 * ndcg — Normalized Discounted Cumulative Gain at k.
 *
 * The standard offline ranking metric: rewards relevant results, and
 * rewards them more when they appear higher in the list. We use the
 * graded-relevance form so a goldenset can mark some hits as "fully
 * on-topic" (rel=2) vs "tangential but useful" (rel=1).
 *
 *   DCG_k  = Σ (2^rel_i - 1) / log2(i + 1)        for i = 1..k
 *   IDCG_k = DCG of the ideally-ordered relevance list
 *   NDCG_k = DCG_k / IDCG_k     (1.0 = perfect, 0 = no relevant hits)
 *
 * Inputs:
 *   ranked     ordered array of result ids (best first)
 *   relevance  map id → grade (number ≥ 0). Missing ids are 0.
 *
 * NDCG returns NaN if there is no relevance signal at all
 * (IDCG = 0). The aggregator treats NaN as "no judgement" and skips.
 */

function ndcgAtK(ranked, relevance, k = 10) {
  if (!Array.isArray(ranked)) throw new Error("ndcg: ranked must be array");
  if (!relevance || typeof relevance.get !== "function" && typeof relevance !== "object") {
    throw new Error("ndcg: relevance must be Map or object");
  }
  const get = (id) => {
    if (typeof relevance.get === "function") return relevance.get(id) || 0;
    return relevance[id] || 0;
  };
  const limit = Math.max(1, k);
  const top = ranked.slice(0, limit);

  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    const rel = Number(get(top[i])) || 0;
    if (rel <= 0) continue;
    dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }

  // Build ideal ordering from the relevance entries.
  const grades = [];
  if (typeof relevance.values === "function") {
    for (const v of relevance.values()) grades.push(Number(v) || 0);
  } else {
    for (const k2 of Object.keys(relevance)) grades.push(Number(relevance[k2]) || 0);
  }
  grades.sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < Math.min(limit, grades.length); i++) {
    const rel = grades[i];
    if (rel <= 0) continue;
    idcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  if (idcg === 0) return NaN;
  return dcg / idcg;
}

/**
 * Aggregate NDCG over a list of (ranked, relevance) pairs.
 * Skips entries where IDCG = 0 (nothing relevant in the goldenset).
 */
function meanNdcg(samples, k = 10) {
  let sum = 0;
  let n = 0;
  const per = [];
  for (const s of samples) {
    const v = ndcgAtK(s.ranked, s.relevance, k);
    per.push({ id: s.id || null, ndcg: v });
    if (Number.isFinite(v)) {
      sum += v;
      n += 1;
    }
  }
  return {
    mean: n === 0 ? NaN : sum / n,
    n,
    per_query: per,
  };
}

module.exports = {
  ndcgAtK,
  meanNdcg,
};
