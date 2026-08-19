'use strict';

/**
 * tool-call-idempotency — LRU+TTL store that coalesces identical
 * tool calls (same tool, same canonical args) so a re-running agent
 * (retry, replay, speculative race loser) never re-executes a side-
 * effecting tool twice. Pairs with the existing
 * idempotency-body-aware key (commit 5572652) which protects HTTP
 * routes; this one protects the agent's outbound tool dispatch.
 *
 * Behavior:
 *   const id = createToolCallIdempotency({ maxEntries, ttlMs, now })
 *   await id.runOnce(toolName, args, runner)
 *     - If a fresh entry exists → returns the cached result (or
 *       awaits the in-flight promise if the original call is still
 *       running — single-flight semantics).
 *     - Otherwise calls runner(toolName, args), caches the resolved
 *       value (or the rejection — once), and returns it.
 *
 *   id.invalidate(toolName, args?)
 *     - Without args: clears every entry for the tool.
 *     - With args: clears only the matching entry.
 *
 *   id.size() / id.snapshot()
 *
 * Canonical key = `${toolName}|sha256(stableJson(args))`. Args are
 * stringified deterministically (sorted object keys, arrays in order)
 * so {a:1,b:2} and {b:2,a:1} collide. Functions and undefined are
 * dropped to keep the hash deterministic across worker restarts.
 *
 * The store is in-memory and process-local. The LRU eviction policy
 * uses the standard Map iteration-order trick: re-inserting on hit
 * moves the entry to the end of the list.
 */

const { createHash } = require('node:crypto');

const DEFAULT_MAX_ENTRIES = 1024;
const DEFAULT_TTL_MS = 5 * 60_000;

function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'function') return '"<fn>"';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashArgs(toolName, args) {
  const h = createHash('sha256');
  h.update(toolName);
  h.update('|');
  h.update(stableStringify(args));
  return h.digest('hex');
}

function createToolCallIdempotency(opts = {}) {
  const maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0
    ? Math.floor(opts.maxEntries)
    : DEFAULT_MAX_ENTRIES;
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
    ? Math.floor(opts.ttlMs)
    : DEFAULT_TTL_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /**
   * Map<key, { tool, value?, error?, promise?, expiresAt }>.
   * value/error are populated once the runner settles. While in flight,
   * `promise` holds the inflight promise so concurrent callers
   * single-flight onto the same execution.
   */
  const store = new Map();
  let hits = 0;
  let misses = 0;
  let coalesced = 0;
  let evictions = 0;

  function fresh(entry, t) { return entry && entry.expiresAt > t; }

  function evictExpired(t) {
    for (const [k, e] of store) {
      if (!fresh(e, t)) { store.delete(k); evictions += 1; }
    }
  }

  function evictLruIfNeeded() {
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
      evictions += 1;
    }
  }

  function touch(key, entry) {
    // Re-insert to move to the end of the iteration order.
    store.delete(key);
    store.set(key, entry);
  }

  async function runOnce(toolName, args, runner) {
    if (typeof toolName !== 'string' || !toolName) {
      throw new TypeError('tool-call-idempotency: toolName required');
    }
    if (typeof runner !== 'function') {
      throw new TypeError('tool-call-idempotency: runner required');
    }
    const t = now();
    const key = hashArgs(toolName, args);
    const existing = store.get(key);
    if (fresh(existing, t)) {
      touch(key, existing);
      hits += 1;
      if (existing.promise) {
        coalesced += 1;
        return existing.promise;
      }
      if ('error' in existing) throw existing.error;
      return existing.value;
    }
    if (existing) store.delete(key); // expired

    misses += 1;
    const promise = (async () => runner(toolName, args))();
    const placeholder = { tool: toolName, promise, expiresAt: t + ttlMs };
    store.set(key, placeholder);
    evictLruIfNeeded();

    try {
      const value = await promise;
      // Refresh expiresAt on settle so the cached value lives for the
      // full TTL from completion (not from start of slow call).
      store.set(key, { tool: toolName, value, expiresAt: now() + ttlMs });
      evictLruIfNeeded();
      return value;
    } catch (error) {
      // Cache rejections too — the agent should not retry-loop a
      // deterministically-failing tool call within the TTL.
      store.set(key, { tool: toolName, error, expiresAt: now() + ttlMs });
      evictLruIfNeeded();
      throw error;
    }
  }

  function invalidate(toolName, args) {
    if (typeof toolName !== 'string' || !toolName) return 0;
    if (args !== undefined) {
      const key = hashArgs(toolName, args);
      return store.delete(key) ? 1 : 0;
    }
    let n = 0;
    for (const [k, e] of store) {
      if (e.tool === toolName) { store.delete(k); n += 1; }
    }
    return n;
  }

  function size() {
    evictExpired(now());
    return store.size;
  }

  function snapshot() {
    return { size: size(), hits, misses, coalesced, evictions, maxEntries, ttlMs };
  }

  return { runOnce, invalidate, size, snapshot, hashArgs, stableStringify };
}

module.exports = {
  createToolCallIdempotency,
  hashArgs,
  stableStringify,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
};
