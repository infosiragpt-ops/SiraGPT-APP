'use strict';

/**
 * token-bulkhead — concurrency control sized by tokens-in-flight per
 * model rather than just request count. Pairs with the cost-budget
 * breaker (#10): the breaker stops you when budget is gone, this one
 * stops you sooner when concurrent token pressure would overrun the
 * provider's rate limit (TPM = tokens-per-minute).
 *
 * Two limits enforced together:
 *   - maxConcurrent      — hard cap on simultaneous in-flight calls.
 *   - maxTokensInFlight  — sum of `tokens` reserved by currently
 *                          executing acquisitions; queue waits when
 *                          the next would push the sum over.
 *
 * Acquisitions are FIFO with a priority override: higher
 * `priority` numbers cut the line. A pending acquisition with an
 * AbortSignal that fires drops out of the queue cleanly.
 *
 * Public API:
 *   const bh = createTokenBulkhead({
 *     model,                  // label only
 *     maxConcurrent,          // default 8
 *     maxTokensInFlight,      // default 100_000
 *   })
 *   const release = await bh.acquire({ tokens, priority?, signal? })
 *   try { ... } finally { release() }
 *   bh.snapshot()  → { inFlight, tokensInFlight, queued, ... }
 *   bh.drain()     → wait for in-flight + queue to empty
 */

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_TOKENS = 100_000;

class BulkheadAcquireError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BulkheadAcquireError';
    this.code = code;
  }
}

function createTokenBulkhead(opts = {}) {
  const model = typeof opts.model === 'string' ? opts.model : 'unknown';
  const maxConcurrent = Number.isFinite(opts.maxConcurrent) && opts.maxConcurrent > 0
    ? Math.floor(opts.maxConcurrent)
    : DEFAULT_MAX_CONCURRENT;
  const maxTokens = Number.isFinite(opts.maxTokensInFlight) && opts.maxTokensInFlight > 0
    ? Math.floor(opts.maxTokensInFlight)
    : DEFAULT_MAX_TOKENS;

  let inFlight = 0;
  let tokensInFlight = 0;
  let totalAcquires = 0;
  let totalRejects = 0;
  let drainResolvers = [];
  /** @type {Array<{tokens, priority, resolve, reject, signal, onAbort, removed:boolean}>} */
  const queue = [];

  function canFit(tokens) {
    return inFlight < maxConcurrent && tokensInFlight + tokens <= maxTokens;
  }

  function tryStartFromQueue() {
    // Sort by priority desc each pump (queue is small enough).
    queue.sort((a, b) => (b.priority - a.priority));
    while (queue.length > 0) {
      const head = queue[0];
      if (head.removed) { queue.shift(); continue; }
      if (!canFit(head.tokens)) break;
      queue.shift();
      startAcquire(head.tokens, head.resolve, head.signal, head.onAbort);
    }
  }

  function startAcquire(tokens, resolve, signal, prevOnAbort) {
    inFlight += 1;
    tokensInFlight += tokens;
    totalAcquires += 1;
    if (signal && prevOnAbort) {
      try { signal.removeEventListener('abort', prevOnAbort); } catch { /* swallow */ }
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight -= 1;
      tokensInFlight -= tokens;
      tryStartFromQueue();
      if (inFlight === 0 && queue.length === 0 && drainResolvers.length) {
        const list = drainResolvers; drainResolvers = [];
        for (const r of list) r();
      }
    };
    resolve(release);
  }

  function acquire({ tokens, priority = 0, signal = null } = {}) {
    const t = Math.max(0, Math.floor(Number(tokens) || 0));
    if (t > maxTokens) {
      totalRejects += 1;
      return Promise.reject(new BulkheadAcquireError(
        `tokens=${t} exceeds bulkhead capacity ${maxTokens}`,
        'CAPACITY_EXCEEDED',
      ));
    }
    if (signal && signal.aborted) {
      totalRejects += 1;
      return Promise.reject(new BulkheadAcquireError('aborted before acquire', 'ABORTED'));
    }
    return new Promise((resolve, reject) => {
      if (canFit(t)) {
        startAcquire(t, resolve, signal, null);
        return;
      }
      const slot = { tokens: t, priority: Number(priority) || 0, resolve, reject, signal, onAbort: null, removed: false };
      if (signal) {
        slot.onAbort = () => {
          if (slot.removed) return;
          slot.removed = true;
          totalRejects += 1;
          reject(new BulkheadAcquireError('aborted while queued', 'ABORTED_IN_QUEUE'));
        };
        try { signal.addEventListener('abort', slot.onAbort, { once: true }); } catch { /* swallow */ }
      }
      queue.push(slot);
    });
  }

  function snapshot() {
    return {
      model,
      maxConcurrent,
      maxTokensInFlight: maxTokens,
      inFlight,
      tokensInFlight,
      queued: queue.filter((q) => !q.removed).length,
      totalAcquires,
      totalRejects,
    };
  }

  function drain() {
    if (inFlight === 0 && queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => drainResolvers.push(resolve));
  }

  return { acquire, snapshot, drain };
}

module.exports = {
  createTokenBulkhead,
  BulkheadAcquireError,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_TOKENS,
};
