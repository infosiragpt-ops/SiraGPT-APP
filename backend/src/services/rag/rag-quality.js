'use strict';

/**
 * rag-quality — orchestrates the three retrieval-quality primitives
 * required by improvement-cycle #18:
 *
 *   1. Hybrid retrieval — `score = 0.7 * vector + 0.3 * bm25`
 *   2. Cross-encoder-style re-rank — heading similarity weighted higher
 *      than body similarity (heuristic stand-in for a real cross-encoder)
 *   3. MMR diversification — `λ * relevance − (1-λ) * max_sim_to_selected`
 *
 * Why a separate orchestrator (vs reusing rag-service.retrieve()):
 *   `rag-service.retrieve` already supports hybrid via Reciprocal Rank
 *   Fusion, an LLM reranker and the existing MMR module. RRF is a
 *   *ranking* fusion (uses positions, ignores scores) — superior for
 *   most real workloads. But the task specifically requires *score*
 *   fusion (0.7 * vector + 0.3 * bm25) for ablation comparability and
 *   small-corpus deployments where BM25's IDF is reliable enough to
 *   blend with cosine on raw magnitude. This module gives callers that
 *   exact formula without disturbing the production retrieve() path.
 *
 * For large corpora the BM25 we ship is an in-memory implementation.
 * Upgrade path: replace `bm25Score()` here with a Postgres FTS query
 * (`tsvector @@ plainto_tsquery` + `ts_rank_cd`) and keep the rest of
 * the pipeline unchanged — the function signatures are storage-agnostic.
 */

const bm25 = require('./bm25');

const VECTOR_WEIGHT = 0.7;
const BM25_WEIGHT = 0.3;
const HEADING_WEIGHT = 0.65;   // > BODY_WEIGHT — task requirement
const BODY_WEIGHT = 0.35;
const DEFAULT_MMR_LAMBDA = 0.7;

/* ────────────────────────── cosine + utils ──────────────────────── */

function cosine(a, b) {
  if (!a || !b) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i], bv = b[i];
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (big.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/* ──────────────────────────── BM25 wrapper ──────────────────────── */

/**
 * Build a BM25 index over a chunks collection. `chunks` is
 * `[{ text, title?, ... }]`; ids are the array positions so callers can
 * reattach scores by index.
 */
function buildBm25Index(chunks) {
  const idx = bm25.createBm25Index();
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    // Include title in the indexed text — heading words should boost
    // relevance the same way they do in a real search engine.
    const indexed = (c.title ? c.title + ' ' : '') + (c.text || '');
    idx.add(i, indexed);
  }
  return idx;
}

/**
 * Return a parallel array `scores[i] = bm25(query, chunks[i])`,
 * normalized to [0, 1] via max-score. Raw BM25 is unbounded so blending
 * with cosine on raw magnitude would over-weight whichever ranker
 * happens to produce larger numbers on the corpus at hand.
 */
function bm25Score(chunks, query) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];
  const idx = buildBm25Index(chunks);
  const hits = idx.search(query, { topK: chunks.length });
  const raw = new Array(chunks.length).fill(0);
  let max = 0;
  for (const h of hits) {
    raw[h.id] = h.score;
    if (h.score > max) max = h.score;
  }
  if (max === 0) return raw;
  return raw.map((s) => s / max);
}

/* ──────────────────────────── hybrid ────────────────────────────── */

/**
 * hybridScore — combine vector + bm25 with the task-required weights.
 * `vectorScores` and `bm25Scores` must be parallel arrays already
 * normalized to [0, 1]; the function pairs them positionally and
 * returns a new array of fused scores.
 */
function hybridScore(vectorScores, bm25Scores, {
  vectorWeight = VECTOR_WEIGHT,
  bm25Weight = BM25_WEIGHT,
} = {}) {
  const n = Math.max(vectorScores.length, bm25Scores.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = vectorScores[i] ?? 0;
    const b = bm25Scores[i] ?? 0;
    out[i] = vectorWeight * v + bm25Weight * b;
  }
  return out;
}

/**
 * hybridRetrieve — end-to-end vector + bm25 fusion for an in-memory
 * collection. `chunks` is `[{ text, title?, embedding? }]`; `query` is
 * the raw text; `queryEmbedding` is the pre-computed query vector (so
 * this module stays embedding-provider-agnostic).
 *
 * Returns `chunks` augmented with `{ vectorScore, bm25Score,
 * hybridScore }` and sorted descending by hybridScore. The top-k slice
 * is taken by the caller.
 */
function hybridRetrieve({ chunks, query, queryEmbedding, weights } = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];
  const vec = new Array(chunks.length).fill(0);
  if (queryEmbedding) {
    for (let i = 0; i < chunks.length; i++) {
      vec[i] = chunks[i].embedding ? cosine(queryEmbedding, chunks[i].embedding) : 0;
    }
  }
  // Cosine is already in [-1, 1]; clamp negatives to 0 before fusing so
  // a "very irrelevant" vector hit doesn't drag the BM25 contribution down.
  for (let i = 0; i < vec.length; i++) vec[i] = Math.max(0, vec[i]);

  const bm = bm25Score(chunks, query);
  const fused = hybridScore(vec, bm, weights);

  return chunks
    .map((c, i) => ({
      ...c,
      vectorScore: vec[i],
      bm25Score: bm[i],
      hybridScore: fused[i],
      score: fused[i],
    }))
    .sort((a, b) => b.hybridScore - a.hybridScore);
}

/* ───────────────────── cross-encoder-ish rerank ─────────────────── */

/**
 * rerankByHeading — re-score the top-k pool using a weighted combination
 * of query↔heading and query↔body similarity. Heading similarity is
 * weighted higher because in well-structured docs the heading is a
 * lexical/semantic distillation of the body, and an exact heading match
 * is strong evidence the chunk answers the query.
 *
 * Stand-in for a true cross-encoder: we don't ship a transformer, so we
 * use cosine over the pre-computed embeddings (when available) and fall
 * back to Jaccard over tokens when no embedding is provided. The
 * function signature mirrors what a real cross-encoder integration
 * would look like — drop in a hosted reranker later by replacing the
 * scoring core.
 */
function rerankByHeading({
  chunks,
  query,
  queryEmbedding = null,
  headingWeight = HEADING_WEIGHT,
  bodyWeight = BODY_WEIGHT,
  k = 5,
} = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];
  const qTokens = new Set(tokenize(query));

  const sim = (text, embedding) => {
    if (queryEmbedding && embedding) {
      return Math.max(0, cosine(queryEmbedding, embedding));
    }
    return jaccard(qTokens, new Set(tokenize(text || '')));
  };

  const reranked = chunks.map((c) => {
    const headSim = c.title ? sim(c.title, c.headingEmbedding || null) : 0;
    const bodySim = sim(c.text || '', c.embedding || null);
    const score = headingWeight * headSim + bodyWeight * bodySim;
    return {
      ...c,
      headingSim: headSim,
      bodySim,
      rerankScore: score,
      score,
    };
  });

  reranked.sort((a, b) => b.rerankScore - a.rerankScore);
  return reranked.slice(0, Math.max(1, k));
}

/* ─────────────────────────────── MMR ────────────────────────────── */

/**
 * mmrDiversify — Maximal Marginal Relevance. `chunks` should arrive
 * pre-scored (e.g. by `hybridRetrieve` or `rerankByHeading`); we use
 * each chunk's `score` field as the relevance term. Similarity between
 * candidates is Jaccard over body tokens when no embedding is present,
 * cosine over embeddings when both candidates have them.
 *
 * λ = 1 → pure relevance (identical to taking the top-k by score)
 * λ = 0 → pure diversity (ignores relevance)
 * λ = 0.7 → default; relevance-leaning with a diversity nudge.
 */
function mmrDiversify({ chunks, lambda = DEFAULT_MMR_LAMBDA, k = 5 } = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];
  const lam = Math.min(1, Math.max(0, Number(lambda) || 0));
  const target = Math.max(1, Math.min(k, chunks.length));

  // Pre-tokenise once; expensive otherwise on long chunks.
  const tokens = chunks.map((c) => new Set(tokenize(c.text || '')));
  const candidatePool = chunks.map((c, i) => ({ c, i }));
  const selected = [];

  const similarity = (i, j) => {
    const ei = chunks[i].embedding;
    const ej = chunks[j].embedding;
    if (ei && ej) return Math.max(0, cosine(ei, ej));
    return jaccard(tokens[i], tokens[j]);
  };

  while (selected.length < target && candidatePool.length > 0) {
    let bestPos = 0;
    let bestScore = -Infinity;
    for (let pos = 0; pos < candidatePool.length; pos++) {
      const { c, i } = candidatePool[pos];
      const relevance = Number(c.score) || 0;
      let maxSim = 0;
      for (const { i: si } of selected) {
        const s = similarity(i, si);
        if (s > maxSim) maxSim = s;
      }
      const mmr = lam * relevance - (1 - lam) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestPos = pos;
      }
    }
    const [pick] = candidatePool.splice(bestPos, 1);
    selected.push({ ...pick, mmrScore: bestScore });
  }

  return selected.map(({ c, mmrScore }) => ({ ...c, mmrScore }));
}

/* ────────────────────── one-shot pipeline ───────────────────────── */

/**
 * retrieveHighQuality — convenience wrapper:
 *   hybridRetrieve → take top-`overfetchK` → rerankByHeading →
 *   mmrDiversify → top-k.
 *
 * Mirrors the three-stage pipeline most modern RAG stacks ship.
 */
function retrieveHighQuality({
  chunks,
  query,
  queryEmbedding,
  k = 5,
  overfetchK = 20,
  mmrLambda = DEFAULT_MMR_LAMBDA,
  weights,
} = {}) {
  const hybrid = hybridRetrieve({ chunks, query, queryEmbedding, weights });
  const pool = hybrid.slice(0, Math.max(k, overfetchK));
  const reranked = rerankByHeading({ chunks: pool, query, queryEmbedding, k: Math.max(k, overfetchK) });
  return mmrDiversify({ chunks: reranked, lambda: mmrLambda, k });
}

module.exports = {
  // primitives
  cosine,
  tokenize,
  jaccard,
  // BM25
  buildBm25Index,
  bm25Score,
  // hybrid
  hybridScore,
  hybridRetrieve,
  // re-rank
  rerankByHeading,
  // MMR
  mmrDiversify,
  // one-shot
  retrieveHighQuality,
  // constants (exported for tests / configurability)
  VECTOR_WEIGHT,
  BM25_WEIGHT,
  HEADING_WEIGHT,
  BODY_WEIGHT,
  DEFAULT_MMR_LAMBDA,
};
