'use strict';

/**
 * skills/snapshot-cache — single-writer in-memory snapshot of the
 * skills registry, invalidated by an event bus. Mirrors the openclaw
 * v2026.5.7 fix: gateway sessions must clear cached skills snapshots
 * during `/new` and `sessions.reset` so changes to the skill registry
 * (install / uninstall / scope flip) become visible on the next call
 * instead of being shadowed by a stale cache.
 *
 * Public API:
 *   const cache = createSkillsSnapshotCache({
 *     source,                                 // () => snapshot
 *     eventBus,                               // optional EventEmitter-like
 *     invalidateOn: ['session.new', ...],     // events that invalidate
 *     ttlMs,                                  // optional safety TTL
 *     now,                                    // optional clock injector
 *   })
 *   cache.get()              → snapshot (cached unless invalidated)
 *   cache.invalidate(reason) → boolean (true if there was a cached value)
 *   cache.onInvalidate(fn)   → unsubscribe()
 *   cache.stats()            → { hits, misses, invalidations, lastReason }
 *
 * The bus is optional — tests pass a fake; production wires it to
 * the real chat/session bus. The cache never throws on bus failures.
 */

const DEFAULT_INVALIDATE_EVENTS = Object.freeze(['session.new', 'sessions.reset', 'skills.changed']);

function createSkillsSnapshotCache(opts = {}) {
  if (typeof opts.source !== 'function') {
    throw new TypeError('skills/snapshot-cache: source function is required');
  }
  const source = opts.source;
  const eventBus = opts.eventBus || null;
  const invalidateOn = Array.isArray(opts.invalidateOn) && opts.invalidateOn.length
    ? opts.invalidateOn.slice()
    : DEFAULT_INVALIDATE_EVENTS.slice();
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? Math.floor(opts.ttlMs) : 0;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  let cached = null;
  let cachedAt = 0;
  let stats = { hits: 0, misses: 0, invalidations: 0, lastReason: null };
  const listeners = new Set();

  function invalidate(reason = 'manual') {
    const had = cached !== null;
    cached = null;
    cachedAt = 0;
    stats = {
      ...stats,
      invalidations: stats.invalidations + (had ? 1 : 0),
      lastReason: reason,
    };
    for (const fn of listeners) {
      try { fn(reason); } catch { /* swallow — listeners must not break the cache */ }
    }
    return had;
  }

  function rebuild() {
    cached = source();
    cachedAt = now();
    return cached;
  }

  function get() {
    if (cached !== null) {
      if (ttlMs > 0 && now() - cachedAt > ttlMs) {
        invalidate('ttl_expired');
        stats = { ...stats, misses: stats.misses + 1 };
        return rebuild();
      }
      stats = { ...stats, hits: stats.hits + 1 };
      return cached;
    }
    stats = { ...stats, misses: stats.misses + 1 };
    return rebuild();
  }

  function onInvalidate(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // Wire the event bus. Each invalidating event clears the snapshot
  // and forwards the event name as the invalidation reason.
  const busHandlers = [];
  if (eventBus && typeof eventBus.on === 'function') {
    for (const ev of invalidateOn) {
      const h = () => invalidate(ev);
      try {
        eventBus.on(ev, h);
        busHandlers.push({ ev, h });
      } catch { /* swallow */ }
    }
  }

  function detach() {
    if (!eventBus || typeof eventBus.off !== 'function') return;
    for (const { ev, h } of busHandlers) {
      try { eventBus.off(ev, h); } catch { /* swallow */ }
    }
    busHandlers.length = 0;
  }

  return {
    get,
    invalidate,
    onInvalidate,
    detach,
    stats: () => ({ ...stats, cached: cached !== null, cachedAt }),
  };
}

module.exports = {
  createSkillsSnapshotCache,
  DEFAULT_INVALIDATE_EVENTS,
};
