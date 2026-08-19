'use strict';

/**
 * TTL-bounded dedup cache for inbound message IDs.
 * Uses a Map for insertion-order eviction; entries expire after `ttlMs`.
 */
class DedupCache {
  constructor({ ttlMs = 3_600_000, maxSize = 10_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this._now = now;
    this._map = new Map();
  }

  _evictExpired() {
    const cutoff = this._now() - this.ttlMs;
    for (const [key, ts] of this._map) {
      if (ts > cutoff) break; // Map preserves insertion order; rest are newer.
      this._map.delete(key);
    }
  }

  has(key) {
    const ts = this._map.get(key);
    if (ts === undefined) return false;
    if (this._now() - ts > this.ttlMs) {
      this._map.delete(key);
      return false;
    }
    return true;
  }

  /** Returns true if the key was newly added; false if it was already present. */
  add(key) {
    this._evictExpired();
    if (this._map.has(key)) {
      // refresh? No — dedup should keep the earliest seen timestamp.
      return false;
    }
    this._map.set(key, this._now());
    if (this._map.size > this.maxSize) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
    return true;
  }

  size() { return this._map.size; }

  clear() { this._map.clear(); }
}

module.exports = { DedupCache };
