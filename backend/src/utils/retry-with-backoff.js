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

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const MAX_RETRIES = 20;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_ATTEMPT_EXPONENT = 30;

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
 * A `minDelayMs` floor (e.g. a server-supplied Retry-After / classifier
 * ttlMs) is honoured *after* jitter so an explicit cooldown hint is never
 * jittered down toward zero. The floor itself is clamped to `maxDelayMs`
 * and validated, so a malformed (NaN / Infinity / negative) hint can never
 * push the delay non-finite or below zero.
 *
 * @param {object}  opts
 * @param {number}  [opts.baseDelayMs=1000]
 * @param {number}  [opts.maxDelayMs=30000]
 * @param {number}  [opts.attempt=0]
 * @param {number}  [opts.minDelayMs=0]  Lower bound (clamped to maxDelayMs)
 * @returns {number}  delay in milliseconds
 */
function computeBackoff(opts = {}) {
  const base = normalizeDelay(opts.baseDelayMs, DEFAULT_BASE_DELAY_MS);
  const max = normalizeDelay(opts.maxDelayMs, DEFAULT_MAX_DELAY_MS);
  const attempt = normalizeNonNegativeInt(opts.attempt, 0, MAX_ATTEMPT_EXPONENT);
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const rand = clampRandom(rng());
  const cap = Math.min(max, base * Math.pow(2, attempt));
  const jittered = normalizeDelay(Math.round(rand * cap), 0);
  // A non-finite / negative floor degrades to 0 (no floor), never to NaN.
  const floor = Math.min(normalizeDelay(opts.minDelayMs, 0), max);
  return Math.max(jittered, floor);
}

/**
 * Extract a safe retry-after floor (in ms) from a classifier result.
 * Tolerates a malformed shape or a non-finite/negative `ttlMs`:
 * anything that isn't a finite, non-negative number degrades to 0
 * (no floor) instead of throwing or corrupting the delay computation.
 *
 * @param {*} classification
 * @returns {number}  >= 0, finite
 */
function ttlFloorFromClassification(classification) {
  if (!classification || typeof classification !== 'object') return 0;
  return normalizeDelay(classification.ttlMs, 0);
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
  if (typeof fn !== 'function') throw new TypeError('withRetry: fn must be a function');
  const maxRetries = normalizeNonNegativeInt(opts.maxRetries, DEFAULT_MAX_RETRIES, MAX_RETRIES);
  const classify = opts.classifyError || defaultClassifier;
  const cb = opts.circuitBreaker || null;
  const onRetry = opts.onRetry || null;
  const signal = opts.signal || null;
  const sleepFn = typeof opts.sleep === 'function' ? opts.sleep : sleep;

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
      const classification = safeClassify(classify, err);
      const retryable = classification.retryable === true;

      // Last attempt or non-retryable? Surface immediately.
      if (attempt >= maxRetries || !retryable) {
        break;
      }

      // Retryable: wait with backoff. Honour the classifier's ttlMs
      // (e.g. a Retry-After hint) as a lower bound, guarded so a
      // malformed/non-finite/negative ttlMs degrades to no floor.
      const delayMs = computeBackoff({
        baseDelayMs: opts.baseDelayMs,
        maxDelayMs: opts.maxDelayMs,
        attempt,
        rng: opts.rng,
        minDelayMs: ttlFloorFromClassification(classification),
      });

      if (onRetry) {
        try {
          onRetry({ attempt: attempt + 1, delayMs, error: err, reason: classification.reason || 'unknown' });
        } catch { /* retry observers must not break the operation */ }
      }

      await sleepFn(delayMs, signal);
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

function normalizeNonNegativeInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function normalizeDelay(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), MAX_TIMER_MS);
}

function clampRandom(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function safeClassify(classify, err) {
  try {
    const result = classify(err);
    if (!result || typeof result !== 'object') return { retryable: false, reason: 'invalid_classification' };
    return result;
  } catch {
    return { retryable: false, reason: 'classifier_error' };
  }
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

    const timer = setTimeout(finish, normalizeDelay(ms, 0));
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
  normalizeNonNegativeInt,
  normalizeDelay,
  clampRandom,
  safeClassify,
  ttlFloorFromClassification,
  MAX_RETRIES,
  MAX_TIMER_MS,
};
