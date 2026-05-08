'use strict';

/**
 * TwoTier — L1 (in-process LRU) + optional L2 (Redis) cache.
 *
 * Lookup order: L1 → L2 → miss. On L2 hit, the value is hoisted into L1 so
 * subsequent lookups are O(1) without a network round-trip. Sets write to
 * both layers (L1 sync, L2 fire-and-forget) so the Redis tail doesn't
 * gate the request path.
 *
 * Failure isolation: a thrown L2 is converted to a miss. L2-set errors are
 * logged via metrics but never propagate.
 */

const { MemoryLRU } = require('./MemoryLRU');
const { CacheMetrics } = require('./metrics');

class TwoTier {
  constructor({
    l1 = null,
    l2 = null,
    metrics = null,
    l1MaxEntries,
    l1TtlMs,
    defaultTtlMs,
    now = () => Date.now(),
    hrtime = () => Number(process.hrtime.bigint()),
  } = {}) {
    this._metrics = metrics || new CacheMetrics();
    this._now = now;
    this._hrtime = hrtime;
    this._defaultTtlMs = Number.isFinite(defaultTtlMs) && defaultTtlMs > 0
      ? defaultTtlMs : (Number.isFinite(l1TtlMs) && l1TtlMs > 0 ? l1TtlMs : 5 * 60 * 1000);
    this._l1 = l1 || new MemoryLRU({
      maxEntries: l1MaxEntries,
      ttlMs: l1TtlMs || this._defaultTtlMs,
      now,
      onEvict: () => this._metrics.recordL1Eviction(),
    });
    this._l2 = l2; // may be null
  }

  get metrics() { return this._metrics; }
  get l1() { return this._l1; }
  get l2() { return this._l2; }

  _markLatency(startNs) {
    const elapsedNs = this._hrtime() - startNs;
    // ns → microseconds
    this._metrics.recordLookupLatency(elapsedNs / 1000);
  }

  async get(key) {
    if (!key) {
      this._metrics.recordMiss();
      return undefined;
    }
    const start = this._hrtime();
    const v1 = this._l1.get(key);
    if (v1 !== undefined) {
      this._metrics.recordL1Hit();
      this._markLatency(start);
      return v1;
    }
    if (this._l2) {
      let v2;
      try {
        v2 = await this._l2.get(key);
      } catch (_err) {
        this._metrics.recordL2Error();
        v2 = undefined;
      }
      if (v2 !== undefined) {
        this._metrics.recordL2Hit();
        // Hoist into L1 with default TTL — L2 may have remaining TTL we can't
        // cheaply read; the L1 ttl is short anyway.
        try { this._l1.set(key, v2); } catch (_err) { /* swallow */ }
        this._markLatency(start);
        return v2;
      }
    }
    this._metrics.recordMiss();
    this._markLatency(start);
    return undefined;
  }

  async set(key, value, ttlMs) {
    if (!key) return;
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this._defaultTtlMs;
    this._metrics.recordSet();
    try { this._l1.set(key, value, ttl); } catch (_err) { /* swallow */ }
    if (this._l2) {
      // Fire-and-forget: don't await on the hot path.
      Promise.resolve()
        .then(() => this._l2.set(key, value, ttl))
        .catch(() => this._metrics.recordL2Error());
    }
  }

  /** Awaitable variant for tests / scripts that need confirmation. */
  async setAndWait(key, value, ttlMs) {
    if (!key) return;
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this._defaultTtlMs;
    this._metrics.recordSet();
    try { this._l1.set(key, value, ttl); } catch (_err) { /* swallow */ }
    if (this._l2) {
      try { await this._l2.set(key, value, ttl); }
      catch (_err) { this._metrics.recordL2Error(); }
    }
  }

  async delete(key) {
    if (!key) return false;
    let any = false;
    try { any = this._l1.delete(key) || any; } catch (_err) { /* swallow */ }
    if (this._l2) {
      try { any = (await this._l2.delete(key)) || any; }
      catch (_err) { this._metrics.recordL2Error(); }
    }
    return any;
  }

  recordBypass() { this._metrics.recordBypass(); }

  snapshot() { return this._metrics.snapshot(); }
}

module.exports = { TwoTier };
