'use strict';

/**
 * MemoryLRU — bounded in-memory LRU cache with TTL.
 *
 * O(1) get/set using Map's insertion-order iteration (move-to-end on access).
 * Each entry has its own expiresAt; reads on expired entries return null and
 * delete the entry. Eviction is recorded as a metric via an optional onEvict
 * hook — the parent (TwoTier) wires that to its metrics counters.
 */

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

class MemoryLRU {
  constructor({
    maxEntries = DEFAULT_MAX_ENTRIES,
    ttlMs = DEFAULT_TTL_MS,
    now = () => Date.now(),
    onEvict = null,
  } = {}) {
    if (!Number.isFinite(maxEntries) || maxEntries < 1) {
      throw new TypeError('MemoryLRU: maxEntries must be a positive integer');
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new TypeError('MemoryLRU: ttlMs must be a non-negative number');
    }
    this._max = Math.floor(maxEntries);
    this._ttl = ttlMs;
    this._now = now;
    this._onEvict = typeof onEvict === 'function' ? onEvict : null;
    this._map = new Map();
  }

  get size() {
    return this._map.size;
  }

  has(key) {
    const entry = this._map.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= this._now()) {
      this._map.delete(key);
      return false;
    }
    return true;
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this._now()) {
      this._map.delete(key);
      return undefined;
    }
    // Move to most-recently-used by deleting and re-inserting.
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this._ttl;
    const expiresAt = ttl === 0 ? Number.POSITIVE_INFINITY : this._now() + ttl;
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this._max) {
      // Evict least-recently-used (first inserted).
      const lruKey = this._map.keys().next().value;
      if (lruKey !== undefined) {
        const evicted = this._map.get(lruKey);
        this._map.delete(lruKey);
        if (this._onEvict) {
          try { this._onEvict(lruKey, evicted ? evicted.value : undefined, 'capacity'); }
          catch (_err) { /* metric hooks must never throw */ }
        }
      }
    }
    this._map.set(key, { value, expiresAt });
  }

  delete(key) {
    return this._map.delete(key);
  }

  clear() {
    this._map.clear();
  }

  /** Drop expired entries; returns count purged. */
  purgeExpired() {
    const cutoff = this._now();
    let purged = 0;
    for (const [k, entry] of this._map) {
      if (entry.expiresAt <= cutoff) {
        this._map.delete(k);
        if (this._onEvict) {
          try { this._onEvict(k, entry.value, 'ttl'); }
          catch (_err) { /* swallow */ }
        }
        purged += 1;
      }
    }
    return purged;
  }
}

module.exports = { MemoryLRU, DEFAULT_MAX_ENTRIES, DEFAULT_TTL_MS };
