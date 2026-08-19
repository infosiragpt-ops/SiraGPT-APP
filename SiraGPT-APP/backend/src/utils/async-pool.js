'use strict';

/**
 * async-pool — bounded-concurrency Promise.all replacement. Runs an
 * iterable of items through an async worker, never letting more than
 * `concurrency` calls be in-flight. Preserves result order, propagates
 * the first error (or collects them all in `settle` mode), and
 * supports caller-driven abort.
 *
 * Pairs with the microbatcher (#23) and token-bulkhead (#18); those
 * coordinate across requests, this one bounds parallelism within a
 * single batch (e.g. embed 1000 chunks but never with > 8 in flight).
 *
 * Public API:
 *   asyncPool({
 *     items,               // array | iterable
 *     worker,              // async (item, index, signal) => result
 *     concurrency = 8,
 *     signal,              // optional AbortSignal
 *     mode = 'all'         // 'all' (throw on first) | 'settle'
 *   })
 *     mode='all'    → Promise<results[]>
 *     mode='settle' → Promise<{status:'fulfilled'|'rejected', value|reason}[]>
 *
 *   asyncMap(items, worker, opts) — alias for the common case
 */

const DEFAULT_CONCURRENCY = 8;

function toArray(items) {
  if (Array.isArray(items)) return items;
  if (items && typeof items[Symbol.iterator] === 'function') return [...items];
  throw new TypeError('async-pool: items must be iterable');
}

class AsyncPoolAbortError extends Error {
  constructor(reason) {
    super(`async-pool aborted: ${reason || 'unknown'}`);
    this.name = 'AsyncPoolAbortError';
    this.code = 'ABORTED';
  }
}

async function asyncPool(opts = {}) {
  if (typeof opts.worker !== 'function') throw new TypeError('async-pool: worker required');
  const items = toArray(opts.items);
  const concurrency = Number.isInteger(opts.concurrency) && opts.concurrency > 0
    ? opts.concurrency
    : DEFAULT_CONCURRENCY;
  const mode = opts.mode === 'settle' ? 'settle' : 'all';
  const signal = opts.signal || null;

  if (signal && signal.aborted) {
    throw new AsyncPoolAbortError(signal.reason || 'caller_aborted');
  }
  if (items.length === 0) return [];

  const results = new Array(items.length);
  let nextIdx = 0;
  let aborted = false;
  let firstError = null;

  function takeNext() {
    if (aborted) return -1;
    if (signal && signal.aborted) { aborted = true; return -1; }
    if (firstError && mode === 'all') return -1;
    if (nextIdx >= items.length) return -1;
    return nextIdx++;
  }

  async function workerLoop() {
    while (true) {
      const i = takeNext();
      if (i === -1) return;
      try {
        results[i] = mode === 'settle'
          ? { status: 'fulfilled', value: await opts.worker(items[i], i, signal) }
          : await opts.worker(items[i], i, signal);
      } catch (err) {
        if (mode === 'settle') {
          results[i] = { status: 'rejected', reason: err };
        } else {
          if (!firstError) firstError = err;
          // mark slot so we don't have undefined in returned array
          results[i] = undefined;
          return; // stop loop early so we drain quickly
        }
      }
    }
  }

  const slots = Math.min(concurrency, items.length);
  const loops = [];
  for (let s = 0; s < slots; s++) loops.push(workerLoop());
  await Promise.all(loops);

  if (signal && signal.aborted) {
    throw new AsyncPoolAbortError(signal.reason || 'caller_aborted');
  }
  if (firstError && mode === 'all') throw firstError;
  return results;
}

function asyncMap(items, worker, opts = {}) {
  return asyncPool({ items, worker, ...opts });
}

module.exports = {
  asyncPool,
  asyncMap,
  AsyncPoolAbortError,
  DEFAULT_CONCURRENCY,
};
