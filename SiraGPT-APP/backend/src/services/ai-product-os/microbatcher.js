'use strict';

/**
 * microbatcher — coalesces individual calls into batches within a
 * time window OR until a max-size threshold. The classic use case is
 * embeddings: 50 inbound calls each asking for 1 vector turn into
 * 1 outbound call asking for 50 vectors, cutting both latency
 * (under load) and cost (per-request fees).
 *
 * Pairs with the tool-call idempotency LRU (#13): that one collapses
 * duplicate calls in time; this one collapses concurrent unique
 * calls into a single upstream batch.
 *
 * Public API:
 *   const mb = createMicrobatcher({
 *     run,                // async (items[], ctx) => results[] (same length)
 *     maxBatchSize,       // default 32
 *     maxLatencyMs,       // default 25
 *     onFlush,            // ({ size, reason, elapsedMs }) sink
 *   })
 *   await mb.submit(item, ctx?)        → result
 *   mb.size()                          → currently buffered count
 *   mb.flush('manual')                 → force flush; returns Promise
 *   mb.snapshot()                      → counters
 *
 * Contract on `run`:
 *   - Receives the items array in submission order.
 *   - Must return an array of the same length (or throw).
 *   - If it throws, every pending caller in the batch sees the same
 *     error — fail-loud, not silently lose calls.
 */

const DEFAULT_MAX_BATCH_SIZE = 32;
const DEFAULT_MAX_LATENCY_MS = 25;

class MicrobatcherShapeError extends Error {
  constructor(actual, expected) {
    super(`microbatcher: run() returned ${actual} results, expected ${expected}`);
    this.name = 'MicrobatcherShapeError';
  }
}

function createMicrobatcher(opts = {}) {
  if (typeof opts.run !== 'function') throw new TypeError('microbatcher: run function required');
  const run = opts.run;
  const maxBatchSize = Number.isFinite(opts.maxBatchSize) && opts.maxBatchSize > 0
    ? Math.floor(opts.maxBatchSize)
    : DEFAULT_MAX_BATCH_SIZE;
  const maxLatencyMs = Number.isFinite(opts.maxLatencyMs) && opts.maxLatencyMs >= 0
    ? Math.floor(opts.maxLatencyMs)
    : DEFAULT_MAX_LATENCY_MS;
  const onFlush = typeof opts.onFlush === 'function' ? opts.onFlush : null;

  /** @type {Array<{item, ctx, resolve, reject}>} */
  let buffer = [];
  let flushTimer = null;
  let totalFlushes = 0;
  let totalItems = 0;

  function clearTimer() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  }

  async function flushBatch(reason) {
    clearTimer();
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    const startedAt = Date.now();
    const items = batch.map((b) => b.item);
    const ctxs = batch.map((b) => b.ctx);
    let results;
    try {
      results = await run(items, ctxs);
    } catch (err) {
      // Fail-loud: every caller sees the same error.
      for (const b of batch) b.reject(err);
      totalFlushes += 1;
      totalItems += batch.length;
      if (onFlush) {
        try { onFlush({ size: batch.length, reason, elapsedMs: Date.now() - startedAt, error: err }); } catch { /* swallow */ }
      }
      return;
    }
    if (!Array.isArray(results) || results.length !== batch.length) {
      const err = new MicrobatcherShapeError(Array.isArray(results) ? results.length : '<not-array>', batch.length);
      for (const b of batch) b.reject(err);
      totalFlushes += 1;
      totalItems += batch.length;
      if (onFlush) {
        try { onFlush({ size: batch.length, reason, elapsedMs: Date.now() - startedAt, error: err }); } catch { /* swallow */ }
      }
      return;
    }
    for (let i = 0; i < batch.length; i++) batch[i].resolve(results[i]);
    totalFlushes += 1;
    totalItems += batch.length;
    if (onFlush) {
      try { onFlush({ size: batch.length, reason, elapsedMs: Date.now() - startedAt }); } catch { /* swallow */ }
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    if (maxLatencyMs === 0) {
      // Microtask flush — coalesces only what was submitted in the same
      // synchronous burst.
      Promise.resolve().then(() => flushBatch('latency'));
      return;
    }
    // Do NOT unref: while callers are awaiting a submit() promise, the
    // timer must keep the event loop alive so the flush actually runs.
    flushTimer = setTimeout(() => flushBatch('latency'), maxLatencyMs);
  }

  function submit(item, ctx = null) {
    return new Promise((resolve, reject) => {
      buffer.push({ item, ctx, resolve, reject });
      if (buffer.length >= maxBatchSize) {
        // Don't await — submit returns immediately; flush runs async.
        flushBatch('size');
      } else {
        scheduleFlush();
      }
    });
  }

  function size() { return buffer.length; }

  function snapshot() {
    return {
      size: buffer.length,
      maxBatchSize,
      maxLatencyMs,
      totalFlushes,
      totalItems,
      avgBatchSize: totalFlushes > 0 ? totalItems / totalFlushes : 0,
    };
  }

  return { submit, size, flush: (reason = 'manual') => flushBatch(reason), snapshot };
}

module.exports = {
  createMicrobatcher,
  MicrobatcherShapeError,
  DEFAULT_MAX_BATCH_SIZE,
  DEFAULT_MAX_LATENCY_MS,
};
