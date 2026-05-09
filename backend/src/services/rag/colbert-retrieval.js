'use strict';

/**
 * colbert-retrieval — late-interaction retrieval primitives (ColBERT v2 / PLAID-style).
 *
 * Classical dense retrieval pools each document into a single vector, so
 * fine-grained query↔document term matches are smeared out by the pooling.
 * Late interaction keeps token-level vectors and aggregates per-query-token
 * via MaxSim:
 *
 *   score(q, d) = Σ_{i ∈ q-tokens}  max_{j ∈ d-tokens} (q_i · d_j)
 *
 * On standard benchmarks this lifts retrieval quality 5–15% nDCG@10 over
 * pooled dense retrieval at the cost of (a) more storage (one vector per
 * document token instead of one per document) and (b) more compute at
 * scoring time. For small-to-medium corpora — exactly SiraGPT's RAG
 * working set — the trade is favorable.
 *
 * This module ships ONLY the framework: tokenizer, encoder, MaxSim
 * scoring, an in-memory index supporting both brute-force and a coarse-
 * to-fine PLAID-style prune, and 3-way Reciprocal Rank Fusion for hybrid
 * combination with the existing BM25 + dense scores. Wiring into
 * services/rag-service.js retrieve() is a separate concern (touching a
 * hot path) and is deliberately out of scope here so this module stays
 * pure additive — zero edits to existing files.
 *
 * Public API:
 *   - tokenizeForColbert(text, opts?)        → string[]   simple boundary tokenizer
 *   - normalizeVec(vec)                       → Float32Array
 *   - cosineSim(a, b)                         → number     cosine over typed arrays
 *   - maxSim(queryVecs, docVecs)              → number     ColBERT MaxSim aggregation
 *   - colbertScore({queryTokens, docTokens, embedFn})  → Promise<number>
 *   - ColbertIndex                            → in-memory index with two-stage scoring
 *   - reciprocalRankFusion(rankings, opts?)   → number[]   3-way (or N-way) RRF
 *   - combineHybridScores(hits, opts?)        → hits[]     RRF-merge bm25 / dense / colbert
 *   - ColbertError                            → base error type
 *
 * Non-goals:
 *   - Fine-tuned ColBERT-trained encoders. The embedFn is caller-injected
 *     so any compatible token embedder can be plugged in; the module is
 *     correct for any L2-normalized token vectors.
 *   - Production-scale (>10⁶ docs) indexing. The PLAID-style prune cuts
 *     candidate set from O(N) to O(K), but this remains an in-memory
 *     index. A pgvector-backed implementation can wrap the same scoring.
 */

class ColbertError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ColbertError';
    this.code = code;
    Object.assign(this, details);
  }
}

// ── Tokenizer ────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_MIN_TOKEN_LEN = 1;

/**
 * Boundary-based tokenizer. Splits on whitespace and most punctuation;
 * normalizes to lowercase; strips tokens shorter than minLen. Drops
 * tokens beyond maxTokens to bound storage.
 *
 * In production a tokenizer matched to the embedding model would be
 * preferable; this implementation is correct as a deterministic baseline
 * and suffices for tests and proof-of-concept scoring.
 */
function tokenizeForColbert(text, opts) {
  const o = opts || {};
  const maxTokens = o.maxTokens != null ? o.maxTokens : DEFAULT_MAX_TOKENS;
  const minLen = o.minLen != null ? o.minLen : DEFAULT_MIN_TOKEN_LEN;
  const lowercase = o.lowercase !== false;
  if (typeof text !== 'string' || text.length === 0) return [];
  const norm = lowercase ? text.toLowerCase() : text;
  const raw = norm.split(/[\s.,;:!?()[\]{}"'`/\\<>|@#$%^&*+=~]+/u);
  const out = [];
  for (const tok of raw) {
    if (tok.length < minLen) continue;
    out.push(tok);
    if (out.length >= maxTokens) break;
  }
  return out;
}

// ── Vector ops ───────────────────────────────────────────────────────

function normalizeVec(vec) {
  const len = vec.length;
  let mag = 0;
  for (let i = 0; i < len; i++) mag += vec[i] * vec[i];
  if (mag === 0) return new Float32Array(len);
  const inv = 1 / Math.sqrt(mag);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = vec[i] * inv;
  return out;
}

function cosineSim(a, b) {
  if (!a || !b) return 0;
  const len = a.length;
  if (len === 0 || len !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na  += x * x;
    nb  += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Late-interaction MaxSim: for each query-token vector, find its maximum
 * cosine similarity to any doc-token vector; sum the maxima.
 *
 * Vectors must be same length per side (otherwise that pair contributes 0).
 * Empty inputs return 0.
 */
function maxSim(queryVecs, docVecs) {
  if (!Array.isArray(queryVecs) || !Array.isArray(docVecs)) return 0;
  if (queryVecs.length === 0 || docVecs.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < queryVecs.length; i++) {
    const q = queryVecs[i];
    let best = 0;
    for (let j = 0; j < docVecs.length; j++) {
      const s = cosineSim(q, docVecs[j]);
      if (s > best) best = s;
    }
    total += best;
  }
  return total;
}

/**
 * Score a (query, doc) text pair end-to-end. Tokenizes both sides,
 * embeds with the caller-supplied embedFn, and returns the MaxSim.
 *
 * `embedFn(tokens)` must accept string[] and return Promise<number[][]>
 * (parallel array of token vectors, each typed-array-like).
 */
async function colbertScore({ queryText, docText, queryTokens, docTokens, embedFn, tokenizerOpts } = {}) {
  if (typeof embedFn !== 'function') {
    throw new ColbertError('embed_required', 'embedFn must be a function');
  }
  const qTok = Array.isArray(queryTokens) ? queryTokens : tokenizeForColbert(queryText || '', tokenizerOpts);
  const dTok = Array.isArray(docTokens)   ? docTokens   : tokenizeForColbert(docText   || '', tokenizerOpts);
  if (qTok.length === 0 || dTok.length === 0) return 0;
  const qVecs = await embedFn(qTok);
  const dVecs = await embedFn(dTok);
  return maxSim(qVecs, dVecs);
}

// ── In-memory index ──────────────────────────────────────────────────

class ColbertIndex {
  constructor({ embedFn, tokenizerOpts } = {}) {
    if (typeof embedFn !== 'function') {
      throw new ColbertError('embed_required', 'ColbertIndex: embedFn must be a function');
    }
    this.embedFn = embedFn;
    this.tokenizerOpts = tokenizerOpts || null;
    this.docs = []; // [{ id, tokens, vecs, centroid, meta }]
  }

  size() { return this.docs.length; }

  /**
   * Add a document. `text` is tokenized + embedded; the token vectors are
   * stored alongside a single pooled centroid vector used for the
   * coarse-prune stage of search().
   */
  async add({ id, text, tokens, meta = null } = {}) {
    if (id == null) throw new ColbertError('id_required', 'add: id required');
    const docTokens = Array.isArray(tokens) ? tokens : tokenizeForColbert(text || '', this.tokenizerOpts);
    if (docTokens.length === 0) {
      this.docs.push({ id, tokens: [], vecs: [], centroid: null, meta });
      return;
    }
    const vecs = await this.embedFn(docTokens);
    const centroid = poolMean(vecs);
    this.docs.push({ id, tokens: docTokens, vecs, centroid, meta });
  }

  async addBatch(docs) {
    if (!Array.isArray(docs)) throw new ColbertError('docs_invalid', 'addBatch: docs must be an array');
    for (const d of docs) await this.add(d);
  }

  remove(id) {
    const ix = this.docs.findIndex(d => d.id === id);
    if (ix < 0) return false;
    this.docs.splice(ix, 1);
    return true;
  }

  clear() {
    const n = this.docs.length;
    this.docs = [];
    return n;
  }

  /**
   * Search the index for the top-K matches against `query`. Two-stage:
   *
   *   1. Coarse prune — rank by cosine of pooled-mean centroids; keep
   *      `coarseK` candidates (default 4×K). For tiny indices (size ≤
   *      coarseK) this is a no-op.
   *   2. Fine MaxSim — compute full ColBERT MaxSim for the surviving
   *      candidates and sort by that score.
   *
   * Returns [{ id, score, coarseScore, meta }] sorted by descending
   * MaxSim score.
   */
  async search(query, { k = 5, coarseK } = {}) {
    if (typeof query !== 'string' && !Array.isArray(query)) {
      throw new ColbertError('query_invalid', 'search: query must be a string or token array');
    }
    if (this.docs.length === 0) return [];
    const qTokens = Array.isArray(query) ? query : tokenizeForColbert(query, this.tokenizerOpts);
    if (qTokens.length === 0) return [];
    const qVecs = await this.embedFn(qTokens);
    const qCentroid = poolMean(qVecs);

    const targetCoarse = coarseK == null ? Math.max(k * 4, 8) : Math.max(k, coarseK | 0);
    let candidates = this.docs;
    if (this.docs.length > targetCoarse) {
      const ranked = this.docs.map(d => ({
        d, coarse: d.centroid ? cosineSim(qCentroid, d.centroid) : 0,
      }));
      ranked.sort((a, b) => b.coarse - a.coarse);
      candidates = ranked.slice(0, targetCoarse).map(x => x.d);
    }

    const scored = [];
    for (const d of candidates) {
      const score = d.vecs.length === 0 ? 0 : maxSim(qVecs, d.vecs);
      const coarseScore = d.centroid ? cosineSim(qCentroid, d.centroid) : 0;
      scored.push({ id: d.id, score, coarseScore, meta: d.meta });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, k | 0));
  }
}

function poolMean(vecs) {
  if (!Array.isArray(vecs) || vecs.length === 0) return null;
  const dim = vecs[0].length;
  if (!Number.isFinite(dim) || dim === 0) return null;
  const out = new Float32Array(dim);
  for (const v of vecs) {
    if (!v || v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vecs.length;
  return out;
}

// ── RRF combination ──────────────────────────────────────────────────

const DEFAULT_RRF_K = 60;

/**
 * Reciprocal Rank Fusion over N rankings.
 *
 * `rankings` is an array of { ranks: Map<id, rank>, weight: number? }.
 * Each rank is 1-indexed (best=1). Returns a Map<id, score>.
 *
 * RRF: score(d) = Σ_r weight_r / (rrfK + rank_r(d))
 */
function reciprocalRankFusion(rankings, { rrfK = DEFAULT_RRF_K } = {}) {
  if (!Array.isArray(rankings)) {
    throw new ColbertError('rankings_invalid', 'rankings must be an array');
  }
  const score = new Map();
  for (const r of rankings) {
    if (!r || !(r.ranks instanceof Map)) {
      throw new ColbertError('rankings_invalid', 'each ranking must have a ranks Map');
    }
    const w = Number.isFinite(r.weight) ? r.weight : 1;
    for (const [id, rank] of r.ranks.entries()) {
      const inc = w / (rrfK + Math.max(1, rank));
      score.set(id, (score.get(id) || 0) + inc);
    }
  }
  return score;
}

/**
 * Convenience: combine three pre-computed candidate lists (BM25, dense,
 * ColBERT) into a single ranked list via RRF. Each input is an array of
 * { id, score } sorted desc; the fusion is rank-based so absolute scores
 * across rankers don't need to be calibrated.
 */
function combineHybridScores({
  bm25 = [],
  dense = [],
  colbert = [],
  weights = { bm25: 1, dense: 1, colbert: 1 },
  rrfK = DEFAULT_RRF_K,
} = {}) {
  const toRanks = (arr) => {
    const m = new Map();
    arr.forEach((it, ix) => { if (it && it.id != null) m.set(it.id, ix + 1); });
    return m;
  };
  const fused = reciprocalRankFusion([
    { ranks: toRanks(bm25),    weight: weights.bm25 || 0 },
    { ranks: toRanks(dense),   weight: weights.dense || 0 },
    { ranks: toRanks(colbert), weight: weights.colbert || 0 },
  ], { rrfK });

  const ids = new Set();
  for (const arr of [bm25, dense, colbert]) for (const it of arr) if (it && it.id != null) ids.add(it.id);
  const out = [];
  for (const id of ids) out.push({ id, fusedScore: fused.get(id) || 0 });
  out.sort((a, b) => b.fusedScore - a.fusedScore);
  return out;
}

module.exports = {
  ColbertIndex,
  ColbertError,
  tokenizeForColbert,
  normalizeVec,
  cosineSim,
  maxSim,
  colbertScore,
  reciprocalRankFusion,
  combineHybridScores,
  poolMean,
  DEFAULT_RRF_K,
};
