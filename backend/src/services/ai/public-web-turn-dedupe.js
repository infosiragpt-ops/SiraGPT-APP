'use strict';

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 120_000;
const DEFAULT_MAX_ENTRIES = 200;

// Process-local by design for the current production topology (one backend
// container running one Node process). Before horizontal/cluster scaling,
// replace this map with a Redis singleflight + replay result keyed identically.
function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createPublicWebTurnDedupe(options = {}) {
  const ttlMs = positiveInt(options.ttlMs, DEFAULT_TTL_MS);
  const maxEntries = positiveInt(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const turns = new Map();

  function makeKey({ userId, streamId, query } = {}) {
    if (!userId || !streamId || !query) return null;
    return crypto
      .createHash('sha256')
      .update([
        String(userId),
        String(streamId),
        String(query),
      ].join('\u0000'))
      .digest('hex');
  }

  function prune() {
    const timestamp = now();
    for (const [key, entry] of turns) {
      // Never release an in-flight key just because a wall-clock TTL elapsed.
      // A reconnect would become a second owner and duplicate model/quota
      // work. Owners are removed on reject/finally; only settled replay
      // results expire here.
      if (entry.settled && entry.expiresAt <= timestamp) turns.delete(key);
    }
  }

  function ensureCapacity() {
    if (turns.size < maxEntries) return;
    // Never evict an unexpired entry, settled or in flight. Either kind still
    // carries the idempotency guarantee for a reconnect; eviction would let
    // that reconnect become a second owner and repeat quota/fetch/model work.
    const error = new Error('public web turn dedupe capacity exhausted');
    error.code = 'public_web_turn_capacity';
    error.status = 503;
    throw error;
  }

  function acquire(input) {
    const key = makeKey(input);
    if (!key) return { key: null, owner: true, entry: null };
    prune();
    const existing = turns.get(key);
    if (existing) return { key, owner: false, entry: existing };
    ensureCapacity();

    let resolvePromise;
    let rejectPromise;
    const entry = {
      key,
      settled: false,
      expiresAt: Number.POSITIVE_INFINITY,
      promise: null,
      resolve: null,
      reject: null,
    };
    entry.promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    entry.promise.catch(() => {});
    entry.resolve = (result) => {
      if (entry.settled) return;
      entry.settled = true;
      entry.expiresAt = now() + ttlMs;
      resolvePromise(result);
    };
    entry.reject = (error) => {
      if (entry.settled) return;
      entry.settled = true;
      turns.delete(key);
      rejectPromise(error);
    };
    turns.set(key, entry);
    return { key, owner: true, entry };
  }

  return {
    acquire,
    clear: () => turns.clear(),
    makeKey,
    size: () => turns.size,
  };
}

module.exports = {
  createPublicWebTurnDedupe,
  publicWebTurnDedupe: createPublicWebTurnDedupe(),
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
};
