'use strict';

/**
 * MemoryLRU — bounded in-memory cache with TTL and pluggable eviction policy.
 *
 * Supports two eviction policies (selected at construction):
 *   - 'lru' (default): evicts the least-recently-used entry — O(1) using
 *     Map insertion-order iteration with move-to-end on access.
 *   - 'lfu': evicts the least-frequently-used entry. Each entry tracks an
 *     access counter; on capacity overflow we scan for the lowest counter,
 *     breaking ties by insertion order (oldest wins). O(n) eviction —
 *     acceptable for typical cache sizes (~1k entries) and avoids the
 *     bookkeeping overhead of a frequency-bucket structure.
 *
 * The class name is preserved for backward compatibility; the implementation
 * now backs both policies. Per-instance hit/miss counts are exposed via
 * stats() so the parent (TwoTier) can report cache_hit_ratio_by_policy.
 */

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SUPPORTED_POLICIES = new Set(['lru', 'lfu']);

class MemoryLRU {
  constructor({
    maxEntries = DEFAULT_MAX_ENTRIES,
    ttlMs = DEFAULT_TTL_MS,
    now = () => Date.now(),
    onEvict = null,
    policy = 'lru',
  } = {}) {
    if (!Number.isFinite(maxEntries) || maxEntries < 1) {
      throw new TypeError('MemoryLRU: maxEntries must be a positive integer');
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new TypeError('MemoryLRU: ttlMs must be a non-negative number');
    }
    if (!SUPPORTED_POLICIES.has(policy)) {
      throw new TypeError(`MemoryLRU: policy must be one of ${[...SUPPORTED_POLICIES].join(', ')}`);
    }
    this._max = Math.floor(maxEntries);
    this._ttl = ttlMs;
    this._now = now;
    this._onEvict = typeof onEvict === 'function' ? onEvict : null;
    this._policy = policy;
    this._map = new Map();
    this._hits = 0;
    this._misses = 0;
  }

  get size() {
    return this._map.size;
  }

  get policy() {
    return this._policy;
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
    if (!entry) {
      this._misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this._now()) {
      this._map.delete(key);
      this._misses += 1;
      return undefined;
    }
    this._hits += 1;
    if (this._policy === 'lru') {
      // Move to most-recently-used by deleting and re-inserting.
      this._map.delete(key);
      this._map.set(key, entry);
    } else {
      // LFU: bump access frequency in place.
      entry.freq = (entry.freq || 0) + 1;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this._ttl;
    const expiresAt = ttl === 0 ? Number.POSITIVE_INFINITY : this._now() + ttl;
    let carriedFreq = 0;
    if (this._map.has(key)) {
      const prev = this._map.get(key);
      carriedFreq = prev && Number.isFinite(prev.freq) ? prev.freq : 0;
      this._map.delete(key);
    } else if (this._map.size >= this._max) {
      const victim = this._policy === 'lfu' ? this._pickLfuVictim() : this._pickLruVictim();
      if (victim !== undefined) {
        const evicted = this._map.get(victim);
        this._map.delete(victim);
        if (this._onEvict) {
          try { this._onEvict(victim, evicted ? evicted.value : undefined, 'capacity'); }
          catch (_err) { /* metric hooks must never throw */ }
        }
      }
    }
    this._map.set(key, { value, expiresAt, freq: carriedFreq });
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

  /** Per-instance hit/miss counters keyed by the active policy. */
  stats() {
    const total = this._hits + this._misses;
    return {
      policy: this._policy,
      hits: this._hits,
      misses: this._misses,
      size: this._map.size,
      hitRatio: total === 0 ? 0 : this._hits / total,
    };
  }

  resetStats() {
    this._hits = 0;
    this._misses = 0;
  }

  _pickLruVictim() {
    return this._map.keys().next().value;
  }

  _pickLfuVictim() {
    // Scan for minimum freq; ties broken by Map iteration order (oldest insert).
    let minFreq = Number.POSITIVE_INFINITY;
    let chosenKey;
    for (const [k, entry] of this._map) {
      const f = Number.isFinite(entry.freq) ? entry.freq : 0;
      if (f < minFreq) {
        minFreq = f;
        chosenKey = k;
        if (f === 0) break; // can't beat zero — short-circuit.
      }
    }
    return chosenKey;
  }
}

module.exports = { MemoryLRU, DEFAULT_MAX_ENTRIES, DEFAULT_TTL_MS, SUPPORTED_POLICIES };
