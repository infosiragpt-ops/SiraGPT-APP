'use strict';

/**
 * Semantic cache — additional layer beyond the exact-key llm-cache.
 *
 * Stores precomputed embeddings of seen prompts and serves a previously
 * cached response when a new prompt's embedding is close enough (cosine
 * similarity ≥ threshold) to one already in the index. This catches near-
 * duplicates that the exact cache misses (different whitespace, casing,
 * minor rewording).
 *
 * Index implementation: flat brute-force with unit-normalized vectors so
 * cosine similarity reduces to a dot product. Adequate for the modest
 * working-set sizes typical of an LLM response cache (≤ a few thousand
 * entries); switch to HNSW if/when this becomes hot.
 *
 * Per-scope bucketing: entries are stored under a scope key (e.g.
 * provider+model+system) so a hit can never leak across an incompatible
 * model or system prompt boundary.
 *
 * Public API:
 *   - SemanticCache — store class.
 *   - cosineSim(a, b) — cosine over arrays / typed arrays.
 *   - normalize(vec) — return a unit-length copy as Float32Array.
 *   - getSemanticCache({ env, embed }) — process-wide singleton.
 *   - isSemanticCacheEnabled(env) — feature-flag predicate.
 *   - extractSemanticQuery(request) — pulls last user message text.
 *   - buildScopeKey(request) — provider/model/system bucket key.
 */

const { createHash } = require('node:crypto');

const DEFAULT_THRESHOLD = 0.92;
const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_QUERY_CHARS = 4096;

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function isSemanticCacheEnabled(env = process.env) {
  return parseBoolean(env.SIRA_SEMANTIC_CACHE_ENABLED, false);
}

/**
 * Cosine similarity. Accepts Array | Float32Array | Float64Array; lengths
 * must match. Returns 0 for zero-magnitude inputs.
 */
function cosineSim(a, b) {
  if (!a || !b) return 0;
  const len = a.length;
  if (len === 0 || len !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function normalize(vec) {
  const out = new Float32Array(vec.length);
  let mag = 0;
  for (let i = 0; i < vec.length; i++) mag += vec[i] * vec[i];
  if (mag === 0) return out;
  const inv = 1 / Math.sqrt(mag);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] * inv;
  return out;
}

function dot(a, b) {
  let s = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

class SemanticCache {
  constructor({
    threshold = DEFAULT_THRESHOLD,
    maxEntries = DEFAULT_MAX_ENTRIES,
    defaultTtlMs = DEFAULT_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    if (threshold <= 0 || threshold > 1) {
      throw new RangeError('SemanticCache: threshold must be in (0, 1]');
    }
    if (!Number.isFinite(maxEntries) || maxEntries < 1) {
      throw new RangeError('SemanticCache: maxEntries must be ≥ 1');
    }
    this._threshold = threshold;
    this._maxEntries = maxEntries;
    this._defaultTtlMs = defaultTtlMs;
    this._now = now;
    // buckets: scope -> Array<{ key, unit, value, expiresAt, hits }>
    this._buckets = new Map();
    this._size = 0;
    this._stats = { hits: 0, misses: 0, sets: 0, evictions: 0, expired: 0 };
  }

  get size() { return this._size; }
  get threshold() { return this._threshold; }

  /**
   * Store a (vec, value) pair under the given scope. The vector is
   * normalized so cosine similarity reduces to a dot product at lookup
   * time. Returns the entry key.
   */
  set(scope, vec, value, { ttlMs, key } = {}) {
    if (!Array.isArray(vec) && !(vec && typeof vec.length === 'number')) {
      throw new TypeError('SemanticCache.set: vec must be array-like');
    }
    if (vec.length === 0) return null;
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this._defaultTtlMs;
    const unit = normalize(vec);
    const entry = {
      key: key || createHash('sha1').update(String(this._now()) + ':' + Math.random()).digest('hex').slice(0, 16),
      unit,
      value,
      expiresAt: this._now() + ttl,
      hits: 0,
    };
    let bucket = this._buckets.get(scope);
    if (!bucket) {
      bucket = [];
      this._buckets.set(scope, bucket);
    }
    bucket.push(entry);
    this._size += 1;
    this._stats.sets += 1;
    this._evictIfNeeded();
    return entry.key;
  }

  /**
   * Find the closest entry in the given scope. Returns
   * { value, similarity, key } when similarity ≥ threshold (or override),
   * otherwise undefined.
   */
  get(scope, vec, { threshold } = {}) {
    const minSim = Number.isFinite(threshold) ? threshold : this._threshold;
    const bucket = this._buckets.get(scope);
    if (!bucket || bucket.length === 0 || vec.length === 0) {
      this._stats.misses += 1;
      return undefined;
    }
    const unit = normalize(vec);
    if (unit.length !== bucket[0].unit.length) {
      // Dimension mismatch — drop the bucket and miss. This handles
      // model/embedding-dim swaps without polluting future hits.
      this._size -= bucket.length;
      this._buckets.delete(scope);
      this._stats.misses += 1;
      return undefined;
    }
    const tNow = this._now();
    let bestIdx = -1;
    let bestSim = -1;
    for (let i = 0; i < bucket.length; i++) {
      const e = bucket[i];
      if (e.expiresAt <= tNow) continue;
      const sim = dot(unit, e.unit);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }
    if (bestIdx < 0 || bestSim < minSim) {
      this._stats.misses += 1;
      return undefined;
    }
    const hit = bucket[bestIdx];
    hit.hits += 1;
    this._stats.hits += 1;
    return { value: hit.value, similarity: bestSim, key: hit.key };
  }

  /** Remove expired entries across all buckets. Returns number purged. */
  pruneExpired() {
    const tNow = this._now();
    let removed = 0;
    for (const [scope, bucket] of this._buckets) {
      const kept = [];
      for (const e of bucket) {
        if (e.expiresAt > tNow) kept.push(e);
        else removed += 1;
      }
      if (kept.length === 0) this._buckets.delete(scope);
      else this._buckets.set(scope, kept);
    }
    this._size -= removed;
    this._stats.expired += removed;
    return removed;
  }

  /**
   * Enforce maxEntries. Strategy: prune expired first; if still over,
   * drop oldest entries (FIFO, since insertion order is preserved in
   * the per-scope arrays). Cheap to reason about; works fine at the
   * sizes we care about.
   */
  _evictIfNeeded() {
    if (this._size <= this._maxEntries) return;
    this.pruneExpired();
    while (this._size > this._maxEntries) {
      // Find the bucket with the oldest entry by expiresAt - ttl proxy:
      // since we don't store insertedAt, use expiresAt as a stable proxy
      // (smaller = inserted earlier under uniform TTL).
      let victimScope = null;
      let victimIdx = -1;
      let victimAt = Infinity;
      for (const [scope, bucket] of this._buckets) {
        if (bucket.length === 0) continue;
        // The first element of each bucket is the oldest (FIFO insertion).
        const head = bucket[0];
        if (head.expiresAt < victimAt) {
          victimAt = head.expiresAt;
          victimScope = scope;
          victimIdx = 0;
        }
      }
      if (victimScope === null) break;
      const bucket = this._buckets.get(victimScope);
      bucket.splice(victimIdx, 1);
      if (bucket.length === 0) this._buckets.delete(victimScope);
      this._size -= 1;
      this._stats.evictions += 1;
    }
  }

  clear() {
    this._buckets.clear();
    this._size = 0;
  }

  stats() {
    const total = this._stats.hits + this._stats.misses;
    return {
      ...this._stats,
      size: this._size,
      scopes: this._buckets.size,
      threshold: this._threshold,
      maxEntries: this._maxEntries,
      hit_ratio: total === 0 ? 0 : this._stats.hits / total,
    };
  }
}

/**
 * Bucket key for a chat request. Keep it cheap and conservative — anything
 * that should change semantics (model, system prompt, tools schema)
 * belongs here so a near-match in one scope can't bleed into another.
 */
function buildScopeKey(request = {}) {
  const parts = [
    request.provider || '-',
    request.model || '-',
    typeof request.system === 'string' ? request.system : (request.system ? JSON.stringify(request.system) : '-'),
  ];
  return createHash('sha1').update(parts.join('')).digest('hex').slice(0, 24);
}

/**
 * Pick the text to embed for similarity matching. We use the last
 * user-role message; system / tool messages tend to be boilerplate that
 * pulls every prompt toward the same point and harms discrimination.
 * Returns null when no usable text is found.
 */
function extractSemanticQuery(request = {}) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role && m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string' && c.trim().length > 0) {
      return c.length > MAX_QUERY_CHARS ? c.slice(0, MAX_QUERY_CHARS) : c;
    }
    if (Array.isArray(c)) {
      // OpenAI multipart content — concatenate text parts.
      const text = c
        .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
        .filter(Boolean)
        .join('\n');
      if (text.trim().length > 0) {
        return text.length > MAX_QUERY_CHARS ? text.slice(0, MAX_QUERY_CHARS) : text;
      }
    }
  }
  return null;
}

let _singleton = null;

/**
 * Singleton accessor. The embed function is captured on first call;
 * subsequent calls reuse the existing instance unless { fresh: true }.
 *
 * The embed function must accept Array<string> and return
 * Promise<Array<ArrayLike<number>>> matching the rag-service signature.
 */
function getSemanticCache(options = {}) {
  if (options.fresh) _singleton = null;
  if (_singleton) return _singleton;
  const env = options.env || process.env;
  const threshold = Number(env.SIRA_SEMANTIC_CACHE_THRESHOLD) || DEFAULT_THRESHOLD;
  const maxEntries = Number(env.SIRA_SEMANTIC_CACHE_MAX) || DEFAULT_MAX_ENTRIES;
  const ttlMs = Number(env.SIRA_SEMANTIC_CACHE_TTL_MS) || DEFAULT_TTL_MS;
  const store = new SemanticCache({ threshold, maxEntries, defaultTtlMs: ttlMs });
  _singleton = {
    store,
    embed: options.embed || null,
    setEmbed(fn) { this.embed = fn; },
  };
  return _singleton;
}

function _resetSingletonForTests() { _singleton = null; }

module.exports = {
  SemanticCache,
  cosineSim,
  normalize,
  buildScopeKey,
  extractSemanticQuery,
  isSemanticCacheEnabled,
  getSemanticCache,
  _resetSingletonForTests,
  DEFAULT_THRESHOLD,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
};
