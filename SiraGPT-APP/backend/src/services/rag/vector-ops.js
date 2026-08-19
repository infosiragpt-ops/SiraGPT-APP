'use strict';

/**
 * vector-ops — minimal embedding-vector primitives. Pure JS, zero
 * dependencies, designed for the hot path of semantic-cache lookups,
 * RAG re-ranking, and dedup. Pairs with the microbatcher (#23) for
 * batched embed → similarity workflows and the bandit (#22) which
 * uses similarity as a context key.
 *
 * All helpers accept either Float32Array (preferred — half the
 * memory of plain Array<number>, faster math) or plain arrays. The
 * fast paths assume same-length, finite-number inputs; the validating
 * `dot/cosine` variants check and throw on mismatch.
 *
 * Public API:
 *   l2norm(v)                          → number
 *   l2normalize(v)                     → new Float32Array (copy)
 *   l2normalizeInto(v)                 → v (in-place)
 *   dot(a, b)                          → number
 *   cosine(a, b)                       → number in [-1, 1]
 *   cosineNormalized(a, b)             → number = dot(a, b) when both
 *                                         already L2-normalized
 *   topK(query, vectors, k, { ids? })  → [{ index|id, score }, ...] desc
 *   normalizeBatch(vectors)            → Float32Array[] (copies)
 */

const ZERO_NORM_MIN = 1e-12;

function isVec(x) {
  return x && typeof x.length === 'number' && x.length > 0
    && (x instanceof Float32Array || x instanceof Float64Array || Array.isArray(x));
}

function checkPair(a, b) {
  if (!isVec(a) || !isVec(b)) throw new TypeError('vector-ops: vectors required');
  if (a.length !== b.length) throw new TypeError(`vector-ops: length mismatch (${a.length} vs ${b.length})`);
}

function l2norm(v) {
  if (!isVec(v)) throw new TypeError('vector-ops: vector required');
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function l2normalize(v) {
  if (!isVec(v)) throw new TypeError('vector-ops: vector required');
  const n = l2norm(v);
  const out = new Float32Array(v.length);
  if (n < ZERO_NORM_MIN) return out; // zero-vector → return zeros
  const inv = 1 / n;
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

function l2normalizeInto(v) {
  if (!isVec(v)) throw new TypeError('vector-ops: vector required');
  const n = l2norm(v);
  if (n < ZERO_NORM_MIN) return v;
  const inv = 1 / n;
  for (let i = 0; i < v.length; i++) v[i] = v[i] * inv;
  return v;
}

function dot(a, b) {
  checkPair(a, b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function cosine(a, b) {
  checkPair(a, b);
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    s += x * y; na += x * x; nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom < ZERO_NORM_MIN) return 0;
  // Clamp to [-1, 1] — finite-precision drift can otherwise yield 1.0000003.
  const c = s / denom;
  return c > 1 ? 1 : c < -1 ? -1 : c;
}

function cosineNormalized(a, b) {
  // Caller asserts both inputs are L2-normalized; we just dot.
  checkPair(a, b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s > 1 ? 1 : s < -1 ? -1 : s;
}

function topK(query, vectors, k, { ids = null, normalized = false } = {}) {
  if (!isVec(query)) throw new TypeError('topK: query vector required');
  if (!Array.isArray(vectors)) throw new TypeError('topK: vectors[] required');
  const cap = Number.isFinite(k) && k > 0 ? Math.floor(k) : 10;
  if (ids != null && ids.length !== vectors.length) {
    throw new TypeError('topK: ids.length must match vectors.length');
  }
  // Linear scan; insertion-sort top-k buffer keeps allocations low.
  const sim = normalized ? cosineNormalized : cosine;
  const heap = []; // ascending by score; smallest at index 0
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!isVec(v) || v.length !== query.length) continue;
    const score = sim(query, v);
    const idVal = ids ? ids[i] : i;
    if (heap.length < cap) {
      heap.push({ id: idVal, score });
      // bubble down (simple insert-sort)
      heap.sort((a, b) => a.score - b.score);
    } else if (score > heap[0].score) {
      heap[0] = { id: idVal, score };
      heap.sort((a, b) => a.score - b.score);
    }
  }
  return heap.sort((a, b) => b.score - a.score);
}

function normalizeBatch(vectors) {
  if (!Array.isArray(vectors)) throw new TypeError('normalizeBatch: vectors[] required');
  return vectors.map((v) => l2normalize(v));
}

module.exports = {
  l2norm,
  l2normalize,
  l2normalizeInto,
  dot,
  cosine,
  cosineNormalized,
  topK,
  normalizeBatch,
};
