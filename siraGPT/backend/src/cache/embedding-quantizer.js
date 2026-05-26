'use strict';

/**
 * Embedding compression via scalar int8 quantization.
 *
 * Cached embeddings are typically Float32Array (4 bytes per dim). For a
 * 1536-dim model with a few thousand cache entries this dominates RAM far
 * more than the cached responses themselves. Symmetric scalar quantization
 * to int8 (1 byte per dim) buys a 4× reduction with a small, measurable
 * impact on cosine-similarity recall.
 *
 * Layout per vector:
 *   { q: Int8Array(dim), scale: number }
 *
 * Quantization (symmetric, per-vector):
 *   absMax = max(|v[i]|)
 *   scale  = absMax / 127           (0 maps to 0; -127..+127 covers ±absMax)
 *   q[i]   = clamp(round(v[i]/scale), -127, 127)
 *
 * Reconstruction:
 *   v̂[i] ≈ q[i] * scale
 *
 * Cosine via quantized vectors:
 *   v̂_a · v̂_b = scale_a * scale_b * Σ q_a[i] * q_b[i]
 * which is exact arithmetic on int8 partials (Σ fits in i32 for any
 * realistic embedding dim) plus one float multiply at the end. We then
 * divide by the *quantized* magnitudes for a self-consistent cosine; for
 * inputs already unit-normalized this is essentially the dot product.
 *
 * Public API:
 *   - quantizeInt8(vec)           → { q, scale }
 *   - dequantizeInt8(qv)          → Float32Array
 *   - quantizedDot(a, b)          → number
 *   - quantizedCosine(a, b)       → number
 *   - byteSize(qv)                → bytes occupied (q + scale)
 *   - QuantizedVectorStore        → minimal scope-bucketed store
 *   - measureRecall(vecs, opts)   → recall@k vs float reference (test helper)
 */

const INT8_MAX = 127;

/**
 * Quantize a Float32-like vector to int8 with a per-vector scale.
 * Accepts Array | Float32Array | Float64Array. Returns `{ q, scale }`.
 *
 * Edge cases:
 *   - empty vector → { q: new Int8Array(0), scale: 0 }
 *   - all-zero vector → scale = 0, q all zeros (dequant → zeros)
 *   - non-finite entries are coerced to 0 (defensive; embeddings never
 *     legitimately contain NaN/Inf, and a single bad value would otherwise
 *     poison the scale for the whole vector).
 */
function quantizeInt8(vec) {
  if (!vec || typeof vec.length !== 'number') {
    throw new TypeError('quantizeInt8: vec must be array-like');
  }
  const len = vec.length;
  const q = new Int8Array(len);
  if (len === 0) return { q, scale: 0 };

  let absMax = 0;
  for (let i = 0; i < len; i++) {
    const v = vec[i];
    if (!Number.isFinite(v)) continue;
    const a = v < 0 ? -v : v;
    if (a > absMax) absMax = a;
  }
  if (absMax === 0) return { q, scale: 0 };

  const scale = absMax / INT8_MAX;
  const inv = 1 / scale;
  for (let i = 0; i < len; i++) {
    const v = vec[i];
    if (!Number.isFinite(v)) { q[i] = 0; continue; }
    let r = Math.round(v * inv);
    if (r > INT8_MAX) r = INT8_MAX;
    else if (r < -INT8_MAX) r = -INT8_MAX;
    q[i] = r;
  }
  return { q, scale };
}

/** Reconstruct an approximate Float32Array from an int8-quantized vector. */
function dequantizeInt8(qv) {
  if (!qv || !qv.q) throw new TypeError('dequantizeInt8: expected { q, scale }');
  const { q, scale } = qv;
  const out = new Float32Array(q.length);
  if (scale === 0) return out;
  for (let i = 0; i < q.length; i++) out[i] = q[i] * scale;
  return out;
}

/**
 * Dot product on quantized vectors. Both vectors must have the same length.
 * Accumulates as int32 (safe up to ~16M dims at int8 extremes — far beyond
 * any embedding) then scales once.
 */
function quantizedDot(a, b) {
  if (!a || !b || !a.q || !b.q) {
    throw new TypeError('quantizedDot: expected { q, scale } on both sides');
  }
  const qa = a.q;
  const qb = b.q;
  const len = qa.length;
  if (len !== qb.length || len === 0) return 0;
  if (a.scale === 0 || b.scale === 0) return 0;
  let acc = 0;
  for (let i = 0; i < len; i++) acc += qa[i] * qb[i];
  return acc * a.scale * b.scale;
}

/**
 * Cosine similarity computed from quantized vectors. Uses the *quantized*
 * magnitudes so the result is self-consistent (a vector compared with
 * itself returns 1.0 exactly).
 */
function quantizedCosine(a, b) {
  const dotAB = quantizedDot(a, b);
  if (dotAB === 0) return 0;
  let na = 0;
  let nb = 0;
  const qa = a.q;
  const qb = b.q;
  for (let i = 0; i < qa.length; i++) {
    na += qa[i] * qa[i];
    nb += qb[i] * qb[i];
  }
  if (na === 0 || nb === 0) return 0;
  // The scales cancel in the quotient (dot has scale_a*scale_b, mags have
  // scale_a^2 and scale_b^2 → ratio leaves scale_a*scale_b), but doing it
  // this way keeps the integer norms cached if a caller wants to reuse them.
  const denom = Math.sqrt(na) * Math.sqrt(nb) * a.scale * b.scale;
  return dotAB / denom;
}

/** Bytes occupied by a quantized vector (Int8 + 8-byte scale). */
function byteSize(qv) {
  if (!qv || !qv.q) return 0;
  return qv.q.byteLength + 8;
}

/**
 * Minimal scope-bucketed quantized vector store. Mirrors the shape of
 * SemanticCache.set/get just enough to be a drop-in for code paths that
 * want compressed storage without depending on the full TTL/eviction
 * machinery. Keep it small — the semantic cache layer above us already
 * owns those concerns.
 */
class QuantizedVectorStore {
  constructor() {
    this._buckets = new Map(); // scope -> Array<{ key, qv, value }>
    this._size = 0;
  }

  get size() { return this._size; }

  set(scope, vec, value, { key } = {}) {
    if (!vec || vec.length === 0) return null;
    const qv = quantizeInt8(vec);
    const entry = { key: key || `qv_${this._size}_${Math.random().toString(36).slice(2, 8)}`, qv, value };
    let bucket = this._buckets.get(scope);
    if (!bucket) { bucket = []; this._buckets.set(scope, bucket); }
    bucket.push(entry);
    this._size += 1;
    return entry.key;
  }

  /** Returns { value, similarity, key } for closest cosine ≥ threshold. */
  get(scope, vec, { threshold = 0.92 } = {}) {
    const bucket = this._buckets.get(scope);
    if (!bucket || bucket.length === 0 || !vec || vec.length === 0) return undefined;
    const probe = quantizeInt8(vec);
    if (probe.q.length !== bucket[0].qv.q.length) return undefined;
    let bestIdx = -1;
    let bestSim = -1;
    for (let i = 0; i < bucket.length; i++) {
      const sim = quantizedCosine(probe, bucket[i].qv);
      if (sim > bestSim) { bestSim = sim; bestIdx = i; }
    }
    if (bestIdx < 0 || bestSim < threshold) return undefined;
    const hit = bucket[bestIdx];
    return { value: hit.value, similarity: bestSim, key: hit.key };
  }

  /** Approximate RAM occupied by quantized vectors, in bytes. */
  byteSize() {
    let total = 0;
    for (const bucket of this._buckets.values()) {
      for (const e of bucket) total += byteSize(e.qv);
    }
    return total;
  }

  clear() { this._buckets.clear(); this._size = 0; }
}

/**
 * Test helper: given a corpus of float vectors, report top-k recall when
 * neighbours are scored via quantized cosine vs the float reference.
 * Useful both as a sanity check and as a regression guard.
 *
 * Returns:
 *   {
 *     recallAtK,      // fraction of queries whose float-top-k is preserved
 *     meanSimError,   // mean |cos_float - cos_quant| across all pairs
 *     maxSimError,    // worst |cos_float - cos_quant|
 *     compression,    // ratio of float bytes / quantized bytes (≈ 4)
 *   }
 *
 * Defaults: k=1 (exact-nearest preservation), and treats the corpus as both
 * queries and targets (leave-one-out).
 */
function measureRecall(vecs, { k = 1 } = {}) {
  if (!Array.isArray(vecs) || vecs.length < 2) {
    throw new RangeError('measureRecall: need at least 2 vectors');
  }
  const dim = vecs[0].length;
  const floatRef = vecs.map((v) => Float32Array.from(v));
  const quant = vecs.map(quantizeInt8);

  const cosFloat = (a, b) => {
    let dot = 0; let na = 0; let nb = 0;
    for (let i = 0; i < dim; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  };

  let preserved = 0;
  let simErrSum = 0;
  let simErrMax = 0;
  let pairCount = 0;

  for (let q = 0; q < vecs.length; q++) {
    const fScores = [];
    const qScores = [];
    for (let t = 0; t < vecs.length; t++) {
      if (t === q) continue;
      const sf = cosFloat(floatRef[q], floatRef[t]);
      const sq = quantizedCosine(quant[q], quant[t]);
      fScores.push({ idx: t, sim: sf });
      qScores.push({ idx: t, sim: sq });
      const err = Math.abs(sf - sq);
      simErrSum += err;
      if (err > simErrMax) simErrMax = err;
      pairCount += 1;
    }
    fScores.sort((a, b) => b.sim - a.sim);
    qScores.sort((a, b) => b.sim - a.sim);
    const fTop = new Set(fScores.slice(0, k).map((x) => x.idx));
    const qTop = new Set(qScores.slice(0, k).map((x) => x.idx));
    let inter = 0;
    for (const i of fTop) if (qTop.has(i)) inter += 1;
    preserved += inter / k;
  }

  const floatBytes = vecs.length * dim * 4;
  const quantBytes = vecs.length * (dim + 8); // int8 dim + scale (~8 bytes)

  return {
    recallAtK: preserved / vecs.length,
    meanSimError: pairCount === 0 ? 0 : simErrSum / pairCount,
    maxSimError: simErrMax,
    compression: floatBytes / quantBytes,
  };
}

module.exports = {
  quantizeInt8,
  dequantizeInt8,
  quantizedDot,
  quantizedCosine,
  byteSize,
  QuantizedVectorStore,
  measureRecall,
  INT8_MAX,
};
