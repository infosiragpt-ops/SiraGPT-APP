"use strict";

/**
 * hybrid-retrieval — production-grade RAG retrieval engine.
 *
 * Implements the canonical hybrid pattern recommended by every major
 * retrieval framework (LlamaIndex / Haystack / Vespa / Qdrant docs):
 *
 *   1. BM25 (sparse, lexical)        — catches exact terms / acronyms
 *   2. Dense (cosine, semantic)      — catches paraphrases
 *   3. Reciprocal Rank Fusion (RRF)  — combines the two ranked lists
 *   4. Cross-encoder reranking       — final precision re-order
 *   5. Metadata + temporal filters   — recency, source quality, lang
 *   6. Citation grounding            — every claim → source spans
 *
 * Pure JS, deterministic, zero deps. Embedding + reranker are caller-
 * injected (we don't ship model weights). When absent the engine
 * degrades gracefully: dense=0 → BM25-only, rerank=identity.
 *
 * The engine takes documents that ALREADY went through chunking. The
 * caller (e.g. a LlamaIndex bridge or our own document-pipeline-
 * registry) is responsible for chunking + embedding.
 */

const RRF_K = 60;          // standard RRF constant from the paper
const TOPK_DEFAULT = 10;
const BM25_K1 = 1.5;
const BM25_B = 0.75;

const STOP = new Set([
  "the","a","an","and","or","but","of","in","on","at","to","for","by","with",
  "is","are","was","were","be","been","being","this","that","these","those",
  "it","its","as","from","into","about","than","then","not","no","yes",
  "el","la","los","las","un","una","unos","unas","y","o","u","de","del","al",
  "que","como","en","con","sin","por","para","es","son","fue","fueron",
]);

/**
 * Build an in-memory hybrid index from a chunk array.
 * Each chunk MUST have: { id, text, metadata? : { source_id, ... }, embedding? : number[] }
 */
function buildIndex(chunks = []) {
  if (!Array.isArray(chunks)) throw mkErr("invalid_chunks", "chunks must be an array");
  // Tokenise + per-doc term frequencies + global doc frequencies for BM25.
  const docs = chunks.map((c, i) => {
    const text = String(c.text || "");
    const tokens = tokenise(text);
    const tf = countTerms(tokens);
    return {
      id: c.id || `chunk_${i}`,
      text,
      tokens,
      tf,
      length: tokens.length,
      metadata: c.metadata || {},
      embedding: Array.isArray(c.embedding) ? c.embedding : null,
    };
  });

  const N = docs.length;
  const df = new Map();   // term → number of docs containing it
  for (const d of docs) {
    for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1);
  }

  const avgdl = N === 0 ? 0 : docs.reduce((s, d) => s + d.length, 0) / N;

  return {
    docs,
    N,
    df,
    avgdl,
    embeddingDim: docs.find(d => d.embedding)?.embedding?.length || 0,
    stats: () => ({
      total_chunks: N,
      vocab_size: df.size,
      avg_doc_length: Math.round(avgdl * 10) / 10,
      with_embeddings: docs.filter(d => d.embedding).length,
    }),
  };
}

/**
 * Search the hybrid index.
 *
 * @param {object} index           output of buildIndex()
 * @param {object} args
 * @param {string} args.query      user query (natural language)
 * @param {number[]} [args.queryEmbedding]   embedding of the query (cosine)
 * @param {number} [args.topK]
 * @param {object} [args.filters]  metadata equality filters { source_id, year, lang… }
 * @param {object} [args.recency]  { yearMin, yearMax }
 * @param {Function} [args.rerankFn]  async (query, hits[]) → hits[]   cross-encoder
 * @param {"hybrid"|"sparse"|"dense"} [args.mode="hybrid"]
 * @param {number} [args.minScore=0]
 * @returns {Promise<{ hits, trace }>}
 */
async function search(index, {
  query,
  queryEmbedding = null,
  topK = TOPK_DEFAULT,
  filters = null,
  recency = null,
  rerankFn = null,
  mode = "hybrid",
  minScore = 0,
} = {}) {
  if (!index || !Array.isArray(index.docs)) throw mkErr("invalid_index", "index required");
  if (typeof query !== "string" || query.trim().length === 0) throw mkErr("missing_query", "query required");
  if (!["hybrid", "sparse", "dense"].includes(mode)) throw mkErr("invalid_mode", `mode "${mode}"`);

  const trace = {
    query,
    mode,
    candidates: 0,
    after_filters: 0,
    sparse_used: mode !== "dense",
    dense_used: mode !== "sparse" && Array.isArray(queryEmbedding) && queryEmbedding.length > 0,
    rerank_used: typeof rerankFn === "function",
  };

  // Pre-filter on metadata + recency (cheap O(n) pass).
  let candidates = index.docs;
  if (filters && typeof filters === "object") {
    candidates = candidates.filter(d => matchesFilter(d.metadata, filters));
  }
  if (recency && (recency.yearMin || recency.yearMax)) {
    candidates = candidates.filter(d => withinRecency(d.metadata, recency));
  }
  trace.after_filters = candidates.length;
  if (candidates.length === 0) return { hits: [], trace };

  // 1. BM25 lexical scoring
  let sparseRanked = [];
  if (trace.sparse_used) {
    const qTokens = tokenise(query);
    sparseRanked = candidates.map(d => ({
      id: d.id,
      doc: d,
      sparse: bm25(qTokens, d, index),
    })).filter(h => h.sparse > 0).sort((a, b) => b.sparse - a.sparse);
  }

  // 2. Dense cosine scoring
  let denseRanked = [];
  if (trace.dense_used) {
    denseRanked = candidates
      .filter(d => d.embedding && d.embedding.length === queryEmbedding.length)
      .map(d => ({
        id: d.id,
        doc: d,
        dense: cosine(queryEmbedding, d.embedding),
      }))
      .filter(h => h.dense > 0)
      .sort((a, b) => b.dense - a.dense);
  }

  // 3. Reciprocal Rank Fusion (when both lists exist)
  let fused;
  if (mode === "hybrid" && sparseRanked.length > 0 && denseRanked.length > 0) {
    fused = rrfFuse([sparseRanked, denseRanked]);
  } else if (sparseRanked.length > 0 && (mode === "sparse" || mode === "hybrid")) {
    fused = sparseRanked.map(h => ({ id: h.id, doc: h.doc, score: h.sparse, sparse: h.sparse, dense: 0 }));
  } else if (denseRanked.length > 0 && (mode === "dense" || mode === "hybrid")) {
    fused = denseRanked.map(h => ({ id: h.id, doc: h.doc, score: h.dense, sparse: 0, dense: h.dense }));
  } else {
    fused = [];
  }
  trace.candidates = fused.length;

  // 4. Apply minScore threshold
  fused = fused.filter(h => h.score >= minScore);

  // Take top-K * 3 for reranking (more candidates → better precision).
  const oversample = Math.min(fused.length, Math.max(topK * 3, topK));
  let top = fused.slice(0, oversample);

  // 5. Cross-encoder reranking (if injected).
  if (trace.rerank_used && top.length > 1) {
    try {
      const reranked = await rerankFn(query, top.map(h => ({ id: h.id, text: h.doc.text, metadata: h.doc.metadata })));
      if (Array.isArray(reranked) && reranked.length > 0) {
        const idToScore = new Map();
        for (const r of reranked) {
          const id = r.id;
          const score = typeof r.score === "number" ? r.score : null;
          if (id != null && score != null) idToScore.set(String(id), score);
        }
        top = top.map(h => ({
          ...h,
          rerank: idToScore.get(String(h.id)) ?? null,
          score: idToScore.has(String(h.id)) ? idToScore.get(String(h.id)) : h.score,
        })).sort((a, b) => b.score - a.score);
      }
    } catch (err) {
      trace.rerank_error = err && err.message ? err.message : String(err);
    }
  }

  const hits = top.slice(0, topK).map(h => ({
    id: h.id,
    text: h.doc.text,
    metadata: h.doc.metadata,
    score: round4(h.score),
    sparse: round4(h.sparse || 0),
    dense: round4(h.dense || 0),
    rerank: typeof h.rerank === "number" ? round4(h.rerank) : null,
  }));

  return { hits, trace };
}

/**
 * Citation grounding — every claim sentence in `answer` must reference
 * at least one chunk that materially overlaps with it. Returns a
 * structured report that downstream code can use to block release.
 */
function groundCitations({ answer, hits = [], minOverlap = 0.18 } = {}) {
  if (typeof answer !== "string") throw mkErr("missing_answer", "answer required");
  const sentences = splitSentences(answer);
  const claims = sentences.map((s, i) => {
    const sToks = new Set(tokenise(s));
    let bestId = null;
    let bestOverlap = 0;
    for (const h of hits) {
      const dToks = new Set(tokenise(h.text));
      const inter = countIntersection(sToks, dToks);
      const union = sToks.size + dToks.size - inter;
      const j = union === 0 ? 0 : inter / union;
      if (j > bestOverlap) { bestOverlap = j; bestId = h.id; }
    }
    return {
      claim_id: `c_${i + 1}`,
      sentence: s,
      grounded: bestOverlap >= minOverlap,
      best_chunk_id: bestId,
      overlap: round4(bestOverlap),
    };
  });
  const grounded = claims.filter(c => c.grounded).length;
  return {
    claims,
    coverage: claims.length === 0 ? 1 : round4(grounded / claims.length),
    grounded_count: grounded,
    total_claims: claims.length,
    threshold: minOverlap,
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function tokenise(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOP.has(t));
}

function countTerms(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

function bm25(queryTokens, doc, index) {
  let score = 0;
  const seen = new Set();
  for (const qt of queryTokens) {
    if (seen.has(qt)) continue;
    seen.add(qt);
    const f = doc.tf.get(qt) || 0;
    if (f === 0) continue;
    const dfi = index.df.get(qt) || 0;
    if (dfi === 0) continue;
    const idf = Math.log(1 + (index.N - dfi + 0.5) / (dfi + 0.5));
    const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / Math.max(index.avgdl, 1)));
    score += idf * ((f * (BM25_K1 + 1)) / denom);
  }
  return score;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Reciprocal Rank Fusion — Cormack et al. 2009. For each ranked list,
 * adds 1 / (k + rank) to the document's running score. Ties broken
 * deterministically by document id.
 */
function rrfFuse(rankedLists, k = RRF_K) {
  const acc = new Map();   // id → { id, doc, score, sparse?, dense? }
  for (const list of rankedLists) {
    for (let r = 0; r < list.length; r++) {
      const h = list[r];
      const cur = acc.get(h.id) || { id: h.id, doc: h.doc, score: 0, sparse: 0, dense: 0 };
      cur.score += 1 / (k + r + 1);
      if ("sparse" in h) cur.sparse = Math.max(cur.sparse, h.sparse);
      if ("dense" in h) cur.dense = Math.max(cur.dense, h.dense);
      acc.set(h.id, cur);
    }
  }
  return [...acc.values()].sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
}

function matchesFilter(metadata, filters) {
  if (!metadata || !filters) return true;
  for (const [k, v] of Object.entries(filters)) {
    const mv = metadata[k];
    if (Array.isArray(v)) { if (!v.includes(mv)) return false; }
    else if (mv !== v) return false;
  }
  return true;
}

function withinRecency(metadata, recency) {
  const y = parseYear(metadata?.year || metadata?.published || metadata?.date);
  if (y == null) return true;  // unknown year is allowed
  if (recency.yearMin && y < recency.yearMin) return false;
  if (recency.yearMax && y > recency.yearMax) return false;
  return true;
}

function parseYear(v) {
  const m = String(v || "").match(/(19|20)\d{2}/);
  return m ? parseInt(m[0], 10) : null;
}

function splitSentences(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡0-9"])/)
    .map(s => s.trim())
    .filter(s => s.length >= 8);
}

function countIntersection(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

function round4(n) { return Math.round(n * 10000) / 10000; }

// Codes are kept verbatim — callers + tests index on `err.code` as
// the primary discriminator. Only the class changes (Error → tagged
// SiraPipelineError subclass) so toHttpResponse + audit consumers
// get a stage + http_status without the call sites needing edits.
function mkErr(code, message) {
  const { RAGError, IngressError } = require("./pipeline-errors");
  // `missing_query` and `missing_answer` are caller-shape complaints
  // (you didn't pass me what I need). The rest are RAG-state
  // problems (bad chunks/index, unknown mode) — internal and
  // surfaced as 502.
  if (code === "missing_query" || code === "missing_answer") {
    return new IngressError({ code, message });
  }
  return new RAGError({ code, message });
}

module.exports = {
  buildIndex,
  search,
  groundCitations,
  // exposed for unit tests
  bm25,
  cosine,
  rrfFuse,
  tokenise,
  splitSentences,
  RRF_K,
  TOPK_DEFAULT,
};
