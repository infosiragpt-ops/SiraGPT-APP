/**
 * semantic-tool-cache — caches the result of an idempotent tool call
 * keyed by a canonical hash of (toolName, args).
 *
 * Why this exists
 * ---------------
 * Tool calls dominate latency and cost in agent runs. Codex CLI and
 * Claude Code happily re-execute identical tool calls when the same
 * thought re-fires — `web_search("openai pricing")` runs every time
 * the model decides to look. Cortex skips the second call when the
 * args canonicalize to the same key, and *coalesces* concurrent
 * duplicate calls into a single in-flight promise via an internal
 * pending-map ("singleflight").
 *
 * Storage:
 *   - Bounded LRU with `max` slots (default 256). On insertion the
 *     least-recently-used entry is evicted.
 *   - Per-entry `ttlMs` (default 5 min). Expired entries are evicted
 *     lazily on `get` and proactively on `prune`.
 *   - Negative caching is opt-in: `cacheErrors: true` stores the
 *     thrown error and replays it for `errorTtlMs` (default 30s).
 *
 * Determinism:
 *   - Args are canonicalized: keys are sorted, undefined values are
 *     removed, NaN → null, Date → ISO string. The canonical form is
 *     hashed with SHA-256 (truncated to 32 hex chars).
 *
 * Concurrency:
 *   - The `singleflight` Map deduplicates concurrent identical calls.
 *     The second concurrent caller awaits the first's resolution,
 *     even if the cache itself is empty.
 *
 * Inspiration is industry-wide (Go's `singleflight`, HTTP cache
 * semantics). No code is copied from any third-party project.
 */

"use strict";

const crypto = require("node:crypto");

const DEFAULT_MAX = 256;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ERROR_TTL_MS = 30 * 1000;

/**
 * Build a canonical, JSON-stable representation of a value.
 * - object keys are sorted recursively
 * - undefined / function / symbol → dropped
 * - NaN, Infinity → null
 * - Date → ISO string
 * - Buffer / TypedArray → "buffer:<sha256-of-bytes>"
 *
 * The function is total: it never throws on cyclic structures —
 * cycles are replaced by the literal string "[cycle]".
 */
function canonicalize(value, seen = new WeakSet()) {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (t === "undefined" || t === "function" || t === "symbol") return undefined;
  if (t === "bigint") return `bigint:${value.toString(10)}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (Buffer.isBuffer(value)) {
    return `buffer:${crypto.createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
  }
  if (ArrayBuffer.isView(value)) {
    const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return `bytes:${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 32)}`;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[cycle]";
    seen.add(value);
    return value.map((v) => canonicalize(v, seen));
  }
  if (t === "object") {
    if (seen.has(value)) return "[cycle]";
    seen.add(value);
    const keys = Object.keys(value).sort();
    const out = {};
    for (const k of keys) {
      const v = canonicalize(value[k], seen);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return undefined;
}

/**
 * Hash (toolName, args) into a deterministic key.
 * @param {string} toolName
 * @param {*} args
 * @returns {string}
 */
function hashKey(toolName, args) {
  if (typeof toolName !== "string" || !toolName.length) {
    throw new TypeError("semantic-tool-cache.hashKey: toolName required");
  }
  const canonical = canonicalize(args);
  const json = JSON.stringify({ t: toolName, a: canonical === undefined ? null : canonical });
  const digest = crypto.createHash("sha256").update(json).digest("hex");
  return `${toolName}:${digest.slice(0, 32)}`;
}

class SemanticToolCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.max]
   * @param {number} [opts.ttlMs]
   * @param {boolean} [opts.cacheErrors]
   * @param {number} [opts.errorTtlMs]
   * @param {() => number} [opts.now]   — overridable for tests
   */
  constructor(opts = {}) {
    this.max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : DEFAULT_MAX;
    this.ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    this.cacheErrors = opts.cacheErrors === true;
    this.errorTtlMs = Number.isFinite(opts.errorTtlMs) && opts.errorTtlMs > 0
      ? opts.errorTtlMs
      : DEFAULT_ERROR_TTL_MS;
    this._now = typeof opts.now === "function" ? opts.now : Date.now;
    // Map maintains insertion order — used as LRU.
    this._store = new Map();
    this._pending = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      coalesced: 0,
      errorsCached: 0,
      sets: 0,
    };
  }

  size() {
    return this._store.size;
  }

  /**
   * Look up a cached value. Returns the cached entry or `undefined`.
   * Touches LRU order on hit.
   */
  get(toolName, args) {
    const key = hashKey(toolName, args);
    return this._getByKey(key);
  }

  _getByKey(key) {
    const entry = this._store.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this._now()) {
      this._store.delete(key);
      this.stats.misses += 1;
      return undefined;
    }
    // Touch LRU.
    this._store.delete(key);
    this._store.set(key, entry);
    this.stats.hits += 1;
    return entry;
  }

  /**
   * Insert or replace a cached value.
   */
  set(toolName, args, value, opts = {}) {
    const key = hashKey(toolName, args);
    const ttl = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : this.ttlMs;
    const entry = {
      value,
      isError: false,
      expiresAt: this._now() + ttl,
      storedAt: this._now(),
    };
    this._setByKey(key, entry);
    return key;
  }

  _setByKey(key, entry) {
    if (this._store.has(key)) this._store.delete(key);
    this._store.set(key, entry);
    this.stats.sets += 1;
    while (this._store.size > this.max) {
      const oldest = this._store.keys().next().value;
      if (oldest === undefined) break;
      this._store.delete(oldest);
      this.stats.evictions += 1;
    }
  }

  delete(toolName, args) {
    return this._store.delete(hashKey(toolName, args));
  }

  clear() {
    this._store.clear();
    this._pending.clear();
  }

  /**
   * Remove every expired entry. Returns the count.
   */
  prune() {
    const now = this._now();
    let removed = 0;
    for (const [k, v] of this._store) {
      if (v.expiresAt <= now) {
        this._store.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Cache-or-execute. The most common entry point.
   *
   * - hit: returns the cached value immediately.
   * - miss + concurrent miss: coalesces; only one `executor` runs.
   * - miss + no concurrency: runs `executor`, caches the result.
   *
   * @param {string} toolName
   * @param {*} args
   * @param {() => Promise<*>} executor
   * @param {object} [opts]
   * @returns {Promise<*>}
   */
  async wrap(toolName, args, executor, opts = {}) {
    if (typeof executor !== "function") {
      throw new TypeError("semantic-tool-cache.wrap: executor function required");
    }
    const key = hashKey(toolName, args);
    const hit = this._getByKey(key);
    if (hit) {
      if (hit.isError) {
        const err = new Error(hit.value && hit.value.message ? hit.value.message : "cached_error");
        err.name = hit.value && hit.value.name ? hit.value.name : "CachedToolError";
        err.cached = true;
        throw err;
      }
      return hit.value;
    }
    const inflight = this._pending.get(key);
    if (inflight) {
      this.stats.coalesced += 1;
      return inflight;
    }
    const promise = (async () => {
      try {
        const value = await executor();
        const ttl = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : this.ttlMs;
        this._setByKey(key, {
          value,
          isError: false,
          expiresAt: this._now() + ttl,
          storedAt: this._now(),
        });
        return value;
      } catch (err) {
        if (this.cacheErrors) {
          const ttl = Number.isFinite(opts.errorTtlMs) && opts.errorTtlMs > 0
            ? opts.errorTtlMs
            : this.errorTtlMs;
          this._setByKey(key, {
            value: { name: err && err.name ? err.name : "Error", message: err && err.message ? err.message : String(err) },
            isError: true,
            expiresAt: this._now() + ttl,
            storedAt: this._now(),
          });
          this.stats.errorsCached += 1;
        }
        throw err;
      } finally {
        this._pending.delete(key);
      }
    })();
    this._pending.set(key, promise);
    return promise;
  }

  /**
   * Snapshot of internal counters. Safe to call any time; never throws.
   */
  getStats() {
    return Object.freeze({ ...this.stats, size: this._store.size, pending: this._pending.size });
  }
}

module.exports = {
  SemanticToolCache,
  hashKey,
  canonicalize,
  DEFAULT_MAX,
  DEFAULT_TTL_MS,
  DEFAULT_ERROR_TTL_MS,
};
