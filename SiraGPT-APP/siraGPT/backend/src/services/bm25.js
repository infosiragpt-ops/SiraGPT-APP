/**
 * bm25 — keyword retrieval via BM25 Okapi.
 *
 * Cosine similarity on dense embeddings recalls passages by *meaning*,
 * which is great for conversational queries but loses on rare tokens —
 * function names, SKUs, error codes. BM25 complements it with lexical
 * scoring: it rewards exact term matches and penalises common terms via
 * IDF, with length-normalised term frequency. When fused with cosine
 * (see rag-service.retrieveHybrid), we get the best of both.
 *
 * Formula (BM25 Okapi):
 *   score(D, Q) = Σ_{q ∈ Q} IDF(q) · ( tf(q, D) · (k1 + 1) )
 *                               / ( tf(q, D) + k1 · (1 − b + b · |D|/avgdl) )
 *   IDF(q)      = ln( (N − n(q) + 0.5) / (n(q) + 0.5) + 1 )
 *
 * Defaults: k1=1.5, b=0.75 (the standard textbook values).
 *
 * Tokenisation mirrors query-expansion.js — EN+ES stop words stripped,
 * Unicode letters/digits/underscores preserved. Identifiers like
 * `user_id` or `createUser` stay intact; `createUser` becomes one token,
 * not two, which is what we want for code search.
 *
 * Usage (index-once, query-many):
 *   const index = buildIndex(docs);     // docs: [{ text, ...anything }]
 *   const hits = searchIndex(index, q); // [{ doc, score }]
 *
 * Pattern reference: Iliagpt.io server/rag/retrieval/HybridRetriever.ts
 * bm25Score() helper, extracted here as a standalone module.
 */

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

const STOP_WORDS = new Set([
  // EN
  'the', 'is', 'are', 'of', 'and', 'to', 'in', 'for', 'with', 'that',
  'this', 'have', 'has', 'had', 'it', 'at', 'be', 'from', 'or', 'an',
  'by', 'we', 'you', 'i', 'a', 'as', 'on', 'not', 'but', 'can',
  // ES
  'el', 'la', 'los', 'las', 'de', 'que', 'en', 'un', 'una', 'es',
  'por', 'con', 'del', 'al', 'se', 'no', 'su', 'si', 'más', 'pero',
  'hay', 'lo', 'le', 'les', 'mi', 'ya', 'o', 'y',
]);

/**
 * Tokenise text into lowercase alphanumeric+underscore tokens.
 * Identifiers (`create_user`, `createUser`) are kept whole — we don't
 * camelCase-split because the exact identifier is exactly what code
 * queries look for.
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  const lower = text.toLowerCase();
  const raw = lower.match(/[\p{L}\p{N}_]+/gu) || [];
  return raw.filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Build a searchable index from a list of docs. Each doc is
 * `{ text, ...passthrough }`; `text` is tokenised, everything else is
 * preserved on the hit for the caller.
 *
 * Returns an opaque index object consumed by searchIndex().
 */
function buildIndex(docs) {
  const n = Array.isArray(docs) ? docs.length : 0;
  if (n === 0) {
    return {
      docs: [], termFreqs: [], docLengths: [], avgDocLength: 0,
      docFreq: new Map(), totalDocs: 0,
    };
  }

  const termFreqs = new Array(n);
  const docLengths = new Array(n);
  const docFreq = new Map();
  let totalLen = 0;

  for (let i = 0; i < n; i++) {
    const tokens = tokenize(docs[i]?.text || '');
    docLengths[i] = tokens.length;
    totalLen += tokens.length;

    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    termFreqs[i] = tf;

    // Unique terms in this doc increment df for each.
    for (const t of tf.keys()) docFreq.set(t, (docFreq.get(t) || 0) + 1);
  }

  return {
    docs,
    termFreqs,
    docLengths,
    avgDocLength: totalLen / n,
    docFreq,
    totalDocs: n,
  };
}

function idf(term, docFreq, totalDocs) {
  const n = docFreq.get(term) || 0;
  // Okapi IDF with the +1 smoothing so rare-but-not-unique terms don't blow up.
  return Math.log((totalDocs - n + 0.5) / (n + 0.5) + 1);
}

/**
 * Score all docs against a query, return the top-K.
 * `k` is capped at the index size; set to Infinity to get everything.
 */
function searchIndex(index, query, { k = 10, k1 = DEFAULT_K1, b = DEFAULT_B } = {}) {
  if (!index || index.totalDocs === 0) return [];
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  // Dedupe query terms but keep track of repeats via a multiplier.
  // Repeated query terms boost their contribution (classic BM25 doesn't,
  // but it's a cheap win for queries like "function function invoke").
  const queryTermCounts = new Map();
  for (const t of queryTerms) queryTermCounts.set(t, (queryTermCounts.get(t) || 0) + 1);

  const { termFreqs, docLengths, avgDocLength, docFreq, totalDocs, docs } = index;
  const scores = [];

  for (let i = 0; i < totalDocs; i++) {
    const tf = termFreqs[i];
    const dl = docLengths[i];
    if (dl === 0) { scores.push({ doc: docs[i], score: 0 }); continue; }

    let score = 0;
    for (const [term, qCount] of queryTermCounts) {
      const f = tf.get(term) || 0;
      if (f === 0) continue;
      const termIdf = idf(term, docFreq, totalDocs);
      const numerator = f * (k1 + 1);
      const denominator = f + k1 * (1 - b + b * dl / avgDocLength);
      score += qCount * termIdf * (numerator / denominator);
    }
    scores.push({ doc: docs[i], score });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, Math.min(k, scores.length));
}

module.exports = {
  tokenize,
  buildIndex,
  searchIndex,
  idf,
  DEFAULT_K1,
  DEFAULT_B,
  STOP_WORDS,
};
