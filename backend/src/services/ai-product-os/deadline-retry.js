'use strict';

/**
 * deadline-retry — wraps an async runner with retry + backoff but
 * stops the moment the next backoff would overshoot a wall-clock
 * deadline. Pairs with the jittered-backoff scheduler (#15) and the
 * cascade fallback (#6): cascade slides between models, this one
 * decides "do we even still have time".
 *
 * Two budgets enforced together:
 *   - maxAttempts (defaults to ∞)
 *   - deadlineMs from the call's start instant
 *
 * Public API:
 *   await runWithDeadlineRetry({
 *     run,            // async (attempt, signal) => result
 *     deadlineMs,     // total wall-clock budget
 *     maxAttempts,    // optional hard cap
 *     backoff,        // { next({attempt, retryAfter?, now?}) } from #15
 *                     //   or any object with a .next method.
 *     isRetryable,    // (err) => bool; default: status 408/425/429/5xx
 *     onAttempt,      // ({ attempt, ok, error?, elapsedMs }) sink
 *     now,            // clock injector
 *     signal,         // optional caller AbortSignal
 *   })
 *     → { ok: true,  value, attempts, elapsedMs }
 *     → throws DeadlineExceededError or the underlying error
 */

const { defaultIsRetryable } = require('./model-fallback-cascade');

class DeadlineExceededError extends Error {
  constructor(deadlineMs, attempts) {
    super(`deadline-retry: exceeded ${deadlineMs}ms after ${attempts} attempt(s)`);
    this.name = 'DeadlineExceededError';
    this.code = 'DEADLINE_EXCEEDED';
    this.deadlineMs = deadlineMs;
    this.attempts = attempts;
  }
}

class AbortedError extends Error {
  constructor(reason) {
    super(`deadline-retry: aborted (${reason || 'unknown'})`);
    this.name = 'AbortedError';
    this.code = 'ABORTED';
  }
}

function defaultBackoff() {
  return { next: ({ attempt }) => Math.min(30_000, 200 * Math.pow(2, attempt)) };
}

async function runWithDeadlineRetry(opts = {}) {
  if (typeof opts.run !== 'function') throw new TypeError('deadline-retry: run required');
  const deadlineMs = Number.isFinite(opts.deadlineMs) && opts.deadlineMs > 0 ? Math.floor(opts.deadlineMs) : 30_000;
  const maxAttempts = Number.isFinite(opts.maxAttempts) && opts.maxAttempts > 0 ? Math.floor(opts.maxAttempts) : Infinity;
  const isRetryable = typeof opts.isRetryable === 'function' ? opts.isRetryable : defaultIsRetryable;
  const onAttempt = typeof opts.onAttempt === 'function' ? opts.onAttempt : null;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const backoff = opts.backoff && typeof opts.backoff.next === 'function' ? opts.backoff : defaultBackoff();
  const signal = opts.signal || null;

  const startedAt = now();
  const deadline = startedAt + deadlineMs;
  let attempts = 0;
  let lastError = null;

  for (;;) {
    if (signal && signal.aborted) throw new AbortedError(signal.reason || 'caller_aborted');
    if (attempts >= maxAttempts) break;
    if (now() >= deadline) break;
    attempts += 1;
    const tStart = now();
    try {
      const value = await opts.run(attempts, signal);
      const elapsedMs = now() - tStart;
      if (onAttempt) {
        try { onAttempt({ attempt: attempts, ok: true, elapsedMs }); } catch { /* swallow */ }
      }
      return { ok: true, value, attempts, elapsedMs: now() - startedAt };
    } catch (err) {
      lastError = err;
      const elapsedMs = now() - tStart;
      if (onAttempt) {
        try { onAttempt({ attempt: attempts, ok: false, error: err, elapsedMs }); } catch { /* swallow */ }
      }
      if (!isRetryable(err)) throw err;
      if (attempts >= maxAttempts) break;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const wait = backoff.next({ attempt: attempts - 1, retryAfter: err && err.retryAfter, now: now() });
      if (wait >= remaining) break; // would overshoot the deadline
      try { await sleep(wait); } catch { /* swallow */ }
    }
  }

  if (lastError && lastError.code !== 'DEADLINE_EXCEEDED') {
    // The caller asked for retries on a retryable error; we ran out of
    // budget. Surface a typed deadline error with .cause = lastError.
    const ded = new DeadlineExceededError(deadlineMs, attempts);
    ded.cause = lastError;
    throw ded;
  }
  throw new DeadlineExceededError(deadlineMs, attempts);
}

module.exports = {
  runWithDeadlineRetry,
  DeadlineExceededError,
  AbortedError,
  defaultBackoff,
};
