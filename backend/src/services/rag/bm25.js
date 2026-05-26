'use strict';

/**
 * bm25 — Okapi BM25 lexical reranker. Pairs with vector-ops (#29):
 * cosine catches semantic neighbors, BM25 catches exact-phrase /
 * rare-term matches the embedding sometimes drowns. Hybrid search
 * is the standard fix; both numbers are normalized and combined by
 * the caller.
 *
 * Default parameters per Robertson & Zaragoza, "The Probabilistic
 * Relevance Framework: BM25 and Beyond" (2009): k1=1.2, b=0.75.
 *
 * Public API:
 *   const idx = createBm25Index({ k1, b, tokenize?, stopwords? })
 *   idx.add(id, text)                    — add a document
 *   idx.addBatch([{id, text}, ...])
 *   idx.remove(id)                       — boolean
 *   idx.search(query, { topK = 10 })     — [{ id, score }, ...] desc
 *   idx.size()
 *   idx.snapshot()
 *
 * Tokenizer: lowercases, splits on /[^\p{L}\p{N}]+/u (Unicode-aware),
 * drops empties + stopwords. Override with `tokenize` for stemming
 * etc. Stopwords list is small Spanish+English by default.
 */

const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;

const DEFAULT_STOPWORDS = new Set([
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'as', 'by', 'from',
  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you', 'we',
  // Spanish
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o',
  'pero', 'es', 'son', 'fue', 'fueron', 'ser', 'estar', 'haber',
  'de', 'en', 'a', 'al', 'del', 'con', 'por', 'para', 'que', 'no',
  'si', 'lo', 'le', 'me', 'te', 'se', 'su', 'sus',
]);

function defaultTokenize(text, stopwords) {
  if (typeof text !== 'string' || !text) return [];
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !stopwords.has(t));
}

function createBm25Index(opts = {}) {
  const k1 = Number.isFinite(opts.k1) ? opts.k1 : DEFAULT_K1;
  const b = Number.isFinite(opts.b) ? opts.b : DEFAULT_B;
  const stopwords = opts.stopwords instanceof Set
    ? opts.stopwords
    : Array.isArray(opts.stopwords) ? new Set(opts.stopwords)
    : DEFAULT_STOPWORDS;
  const tokenize = typeof opts.tokenize === 'function'
    ? (txt) => opts.tokenize(txt)
    : (txt) => defaultTokenize(txt, stopwords);

  /** Map<docId, { length, tf: Map<term, count> }> */
  const docs = new Map();
  /** Map<term, Set<docId>> */
  const df = new Map();
  let totalLength = 0;

  function add(id, text) {
    if (id == null) throw new TypeError('bm25.add: id required');
    if (docs.has(id)) remove(id);
    const tokens = tokenize(text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    docs.set(id, { length: tokens.length, tf });
    totalLength += tokens.length;
    for (const t of tf.keys()) {
      let s = df.get(t);
      if (!s) { s = new Set(); df.set(t, s); }
      s.add(id);
    }
  }

  function addBatch(items) {
    if (!Array.isArray(items)) throw new TypeError('bm25.addBatch: array required');
    for (const it of items) add(it.id, it.text);
  }

  function remove(id) {
    const d = docs.get(id);
    if (!d) return false;
    docs.delete(id);
    totalLength -= d.length;
    for (const t of d.tf.keys()) {
      const s = df.get(t);
      if (s) {
        s.delete(id);
        if (s.size === 0) df.delete(t);
      }
    }
    return true;
  }

  function avgDocLength() {
    return docs.size === 0 ? 0 : totalLength / docs.size;
  }

  function idf(term) {
    const N = docs.size;
    const n = (df.get(term) || new Set()).size;
    // Smoothed IDF (Robertson, Spärck Jones), guaranteed ≥ 0.
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  function scoreDoc(id, queryTokens) {
    const doc = docs.get(id);
    if (!doc) return 0;
    const avgdl = avgDocLength();
    let score = 0;
    for (const q of queryTokens) {
      const f = doc.tf.get(q);
      if (!f) continue;
      const num = f * (k1 + 1);
      const denom = f + k1 * (1 - b + b * (avgdl > 0 ? doc.length / avgdl : 0));
      score += idf(q) * (num / denom);
    }
    return score;
  }

  function search(query, { topK = 10 } = {}) {
    const qt = tokenize(query);
    if (qt.length === 0 || docs.size === 0) return [];
    // Candidate set: docs containing at least one query term.
    const candidates = new Set();
    for (const t of qt) {
      const s = df.get(t);
      if (s) for (const id of s) candidates.add(id);
    }
    const cap = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 10;
    const heap = [];
    for (const id of candidates) {
      const sc = scoreDoc(id, qt);
      if (sc <= 0) continue;
      if (heap.length < cap) {
        heap.push({ id, score: sc });
        heap.sort((a, c) => a.score - c.score);
      } else if (sc > heap[0].score) {
        heap[0] = { id, score: sc };
        heap.sort((a, c) => a.score - c.score);
      }
    }
    return heap.sort((a, c) => c.score - a.score);
  }

  function snapshot() {
    return {
      docs: docs.size,
      uniqueTerms: df.size,
      avgDocLength: avgDocLength(),
      k1, b,
    };
  }

  return { add, addBatch, remove, search, size: () => docs.size, snapshot };
}

module.exports = {
  createBm25Index,
  defaultTokenize,
  DEFAULT_STOPWORDS,
  DEFAULT_K1,
  DEFAULT_B,
};
