'use strict';

/**
 * single-flight — coalescing barrier for expensive computations.
 *
 * When N concurrent callers ask for the same expensive value (cache miss
 * for the same key, RAG retrieval for the same query, embedding batch for
 * the same input), only the first caller actually does the work. The
 * remaining N-1 await the first caller's result and receive the same
 * value — a "thundering herd" stampede becomes a single request.
 *
 * Why this exists:
 *   - LLM completions, vector retrievals, document parses, and HTTP
 *     fetches are expensive. Without coalescing, a popular key arriving
 *     concurrently amplifies cost N-fold and saturates downstream
 *     services for no benefit.
 *   - The Go community calls this "singleflight"; it's a standard piece
 *     of any production cache. SiraGPT had no such primitive.
 *
 * Design:
 *   - Promise-based. The first caller installs a Promise placeholder
 *     under the key; subsequent callers await it. On settlement, the
 *     placeholder is removed (so a *future* call repeats the work).
 *   - Errors propagate to every waiter. A failing computation does NOT
 *     poison the key — the next call gets a fresh attempt.
 *   - `forget(key)` lets the holder explicitly clear an in-flight entry
 *     (e.g. to abort a stale computation; new arrivals will re-fetch).
 *   - Optional per-key timeout: after N ms, every waiter is rejected
 *     with SingleFlightTimeoutError; the in-flight work continues but
 *     no longer affects new callers (the entry is forgotten).
 *   - Metrics: shared (coalesced waiters), leaders (first to do work),
 *     errors, timeouts, in-flight count.
 *
 * Public API:
 *   - SingleFlight class
 *   - getSingleFlight(opts) — process-wide singleton
 *   - resetSingleFlightForTests() — drops the singleton
 *   - SingleFlightError, SingleFlightTimeoutError
 *
 * Non-goals:
 *   - Cross-process coalescing. This is in-memory; for cluster-wide
 *     coalescing layer a Redis-backed shared lock on top of single-flight.
 */

class SingleFlightError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SingleFlightError';
    Object.assign(this, details);
  }
}

class SingleFlightTimeoutError extends SingleFlightError {
  constructor(key, timeoutMs) {
    super(`single-flight timeout after ${timeoutMs}ms for key=${key}`);
    this.name = 'SingleFlightTimeoutError';
    this.code = 'single_flight_timeout';
    this.key = key;
    this.timeoutMs = timeoutMs;
  }
}

class SingleFlight {
  constructor({ defaultTimeoutMs = 0 } = {}) {
    this.inflight = new Map(); // key → { promise, leaderStartedAt, waiters, timeoutHandle }
    this.defaultTimeoutMs = Math.max(0, defaultTimeoutMs | 0);
    this.metrics = {
      leaders: 0,
      shared: 0,
      errors: 0,
      timeouts: 0,
      forgotten: 0,
    };
  }

  /** Number of in-flight keys right now. */
  size() {
    return this.inflight.size;
  }

  /** Snapshot of the in-flight key list (cheap; for observability). */
  keys() {
    return Array.from(this.inflight.keys());
  }

  getMetrics() {
    return { ...this.metrics, inflight: this.inflight.size };
  }

  /**
   * Run `work()` exactly once for `key`. Concurrent callers with the same
   * key share the result. The promise resolves/rejects with whatever
   * `work()` produces.
   *
   * @param {string} key
   * @param {() => Promise<any>} work
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] — overrides defaultTimeoutMs; 0 disables
   * @returns {Promise<any>}
   */
  do(key, work, opts = {}) {
    if (typeof key !== 'string' || key.length === 0) {
      return Promise.reject(new SingleFlightError('do: key must be a non-empty string'));
    }
    if (typeof work !== 'function') {
      return Promise.reject(new SingleFlightError('do: work must be a function'));
    }

    const existing = this.inflight.get(key);
    if (existing) {
      existing.waiters += 1;
      this.metrics.shared += 1;
      return existing.promise;
    }

    const timeoutMs = opts.timeoutMs != null ? Math.max(0, opts.timeoutMs | 0) : this.defaultTimeoutMs;
    this.metrics.leaders += 1;

    const entry = {
      promise: null,
      leaderStartedAt: Date.now(),
      waiters: 1,
      timeoutHandle: null,
      settled: false,
    };

    const timeoutPromise = timeoutMs > 0
      ? new Promise((_, reject) => {
          entry.timeoutHandle = setTimeout(() => {
            if (entry.settled) return;
            const err = new SingleFlightTimeoutError(key, timeoutMs);
            this.metrics.timeouts += 1;
            // Detach this entry so future calls retry. The underlying work
            // continues but its result is discarded by waiters.
            if (this.inflight.get(key) === entry) this.inflight.delete(key);
            entry.settled = true;
            reject(err);
          }, timeoutMs);
        })
      : null;

    // Call work() synchronously so the leader's side effects (counters,
    // logging, etc.) happen at do()-call time. Sync throws and non-promise
    // returns are normalized into a settled promise; thenables pass through
    // unchanged so we don't add an extra microtask hop.
    let workPromise;
    try {
      const r = work();
      workPromise = (r && typeof r.then === 'function') ? r : Promise.resolve(r);
    } catch (syncErr) {
      workPromise = Promise.reject(syncErr);
    }

    const settle = () => {
      if (entry.settled) return;
      entry.settled = true;
      if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    };

    const winner = workPromise.then(
      value => {
        settle();
        return value;
      },
      err => {
        this.metrics.errors += 1;
        settle();
        throw err;
      },
    );

    entry.promise = timeoutPromise
      ? Promise.race([winner, timeoutPromise])
      : winner;

    // Suppress unhandled-rejection on the unraced timeout side-channel.
    if (timeoutPromise) {
      timeoutPromise.catch(() => {});
    }

    this.inflight.set(key, entry);
    return entry.promise;
  }

  /**
   * Drop the in-flight entry for `key` (if any). Waiters already attached
   * to its promise still receive whatever `work()` ultimately produced;
   * new callers will re-execute `work`. Returns true if an entry existed.
   */
  forget(key) {
    if (typeof key !== 'string') return false;
    const had = this.inflight.delete(key);
    if (had) this.metrics.forgotten += 1;
    return had;
  }

  /** Drop every in-flight entry. */
  clear() {
    const n = this.inflight.size;
    this.inflight.clear();
    this.metrics.forgotten += n;
    return n;
  }
}

let _singleton = null;

function getSingleFlight(opts) {
  if (!_singleton) _singleton = new SingleFlight(opts);
  return _singleton;
}

function resetSingleFlightForTests() {
  _singleton = null;
}

module.exports = {
  SingleFlight,
  SingleFlightError,
  SingleFlightTimeoutError,
  getSingleFlight,
  resetSingleFlightForTests,
};
