// ─────────────────────────────────────────────────────────────────
// siraGPT — Retry utility with exponential backoff + jitter +
// circuit-breaker integration.
// ─────────────────────────────────────────────────────────────────
// Complements classifyTaskError() (in agent-task-runner.js) by
// providing a production retry loop:
//
//   1. Classify the error as retryable / non-retryable.
//   2. If retryable, wait baseDelay × 2^attempt + jitter.
//   3. Delegates circuit-breaker state checks & failure recording
//      to cb.call() — the breaker handles fast-fail (CircuitOpenError),
//      rolling failure counts, and state transitions.
//   4. After maxRetries (or a non-retryable error), rethrow the last
//      error. CircuitOpenError bypasses retry since the circuit is
//      known broken.
//
// Usage:
//   const result = await withRetry(
//     () => callOpenAI(prompt),
//     {
//       maxRetries: 3,
//       baseDelayMs: 1_000,
//       classifyError: classifyTaskError,
//       circuitBreaker: openaiBreaker,
//       onRetry: ({ attempt, delayMs, error }) => log.warn({...}),
//     }
//   );
// ─────────────────────────────────────────────────────────────────

const { CircuitBreaker, CircuitOpenError } = require('./circuit-breaker');

/**
 * Default error classifier — always retryable with a short delay.
 * Override with `classifyTaskError()` or your own.
 */
function defaultClassifier(err) {
  return { retryable: true, reason: 'unknown', ttlMs: 1_000 };
}

/**
 * Compute exponential backoff with full jitter.
 *
 *   delay = min(maxDelay, baseDelay * 2^attempt)
 *   actual = random(uniform 0..delay)
 *
 * Full jitter (rather than capped or equal jitter) avoids thundering
 * herd when N workers all try the same retry for the same upstream.
 *
 * @param {object}  opts
 * @param {number}  [opts.baseDelayMs=1000]
 * @param {number}  [opts.maxDelayMs=30000]
 * @param {number}  [opts.attempt=0]
 * @returns {number}  delay in milliseconds
 */
function computeBackoff(opts = {}) {
  const base = opts.baseDelayMs ?? 1_000;
  const max = opts.maxDelayMs ?? 30_000;
  const attempt = opts.attempt ?? 0;
  const cap = Math.min(max, base * Math.pow(2, attempt));
  return Math.round(Math.random() * cap);
}

/**
 * Wrap an async function with retry + circuit breaker.
 *
 * @param {Function} fn  — async () => T, the operation to retry
 * @param {object}   opts
 * @param {number}   [opts.maxRetries=2]          Max retry attempts
 * @param {number}   [opts.baseDelayMs=1_000]     Base delay before first retry
 * @param {number}   [opts.maxDelayMs=30_000]     Max exponential delay
 * @param {Function} [opts.classifyError]          Error classifier
 *   Signature: (Error) => { retryable:boolean, reason:string, ttlMs:number }
 * @param {CircuitBreaker} [opts.circuitBreaker]  Circuit breaker for fast-fail
 * @param {Function} [opts.onRetry]               Callback on each retry attempt
 *   Signature: ({ attempt, delayMs, error, reason }) => void
 * @param {AbortSignal} [opts.signal]             External abort signal
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const maxRetries = opts.maxRetries ?? 2;
  const classify = opts.classifyError || defaultClassifier;
  const cb = opts.circuitBreaker || null;
  const onRetry = opts.onRetry || null;
  const signal = opts.signal || null;

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // ── Abort check ──────────────────────────────────────────
    if (signal?.aborted) {
      throw signal.reason || new Error('Operation aborted');
    }

    try {
      // Delegate to cb.call() when a circuit breaker is present.
      // This handles:
      //   - Fast-fail if the circuit is OPEN (CircuitOpenError)
      //   - Automatic failure/success recording
      //   - Per-call timeout (if configured on the breaker)
      //
      // cb.call() with no timeout override (timeoutMs:0) means
      // "use the breaker's default timeout, if any".
      const runAttempt = () => (signal ? fn({ signal, attempt }) : fn());
      if (cb) {
        return await cb.call(runAttempt, { signal });
      }
      return await raceWithSignal(runAttempt(), signal);
    } catch (err) {
      lastError = err;

      // CircuitOpenError means the breaker is known-broken.
      // Don't retry — the downstream dependency needs cooldown.
      if (err instanceof CircuitOpenError) {
        break;
      }

      // Classify the error for retry decision
      const classification = classify(err);
      const retryable = classification.retryable === true;

      // Last attempt or non-retryable? Surface immediately.
      if (attempt >= maxRetries || !retryable) {
        break;
      }

      // Retryable: wait with backoff
      const delayMs = computeBackoff({
        baseDelayMs: opts.baseDelayMs,
        maxDelayMs: opts.maxDelayMs,
        attempt,
      });

      if (onRetry) {
        onRetry({ attempt: attempt + 1, delayMs, error: err, reason: classification.reason || 'unknown' });
      }

      await sleep(delayMs, signal);
    }
  }

  // If we exhausted retries and lastError is defined, throw it.
  if (lastError) throw lastError;

  // Should never reach here — either fn() succeeded or we threw.
  throw new Error('withRetry: unexpected state (no error, no result)');
}

function raceWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason || new Error('Operation aborted'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      settle(reject, signal.reason || new Error('Operation aborted'));
    };

    if (typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    Promise.resolve(promise).then(
      value => settle(resolve, value),
      err => settle(reject, err),
    );
  });
}

/**
 * Simple promise-based sleep that respects an AbortSignal.
 * Throws signal.reason on abort.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason || new Error('sleep aborted'));
    }

    const cleanup = () => {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason || new Error('sleep aborted'));
    };

    const timer = setTimeout(finish, ms);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

module.exports = {
  withRetry,
  computeBackoff,
  raceWithSignal,
  sleep,
  defaultClassifier,
  CircuitBreaker,
};
