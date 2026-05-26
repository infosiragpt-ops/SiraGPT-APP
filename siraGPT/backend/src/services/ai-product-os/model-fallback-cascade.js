'use strict';

/**
 * model-fallback-cascade — execute a model call against an ordered
 * cascade (primary → fallback → fallback → …) with per-attempt latency
 * budget and a global wall-clock budget. Goes beyond openclaw v2026.5.7:
 * openclaw added explicit override routing; this module adds the
 * resilience layer on top — when the primary trips a rate-limit, 5xx,
 * or per-attempt timeout, we transparently slide down the cascade
 * before surfacing an error to the caller.
 *
 * The default cascade reflects the project's current Anthropic posture:
 *   claude-opus-4-7  →  claude-sonnet-4-6  →  claude-haiku-4-5
 * but callers may pass any list.
 *
 * Public API:
 *   const cascade = createFallbackCascade({
 *     models,                  // string[] (ordered, primary first)
 *     attemptTimeoutMs,        // per-attempt deadline, default 30_000
 *     totalBudgetMs,           // global wall-clock deadline, default 90_000
 *     isRetryable,             // (err) => bool, default sensible defaults
 *     onAttempt,               // ({ model, attempt, error? }) sink
 *     now,                     // clock injector for tests
 *   })
 *   await cascade.execute(async (modelId, signal) => {...})
 *     → { ok: true, model, value, attempts, totalElapsedMs }
 *     → throws CascadeExhaustedError with .attempts
 *
 * The runner receives an AbortSignal that fires when the per-attempt
 * timeout elapses — runners should forward it to fetch / SDK calls so
 * abandoned attempts free their connection slot.
 */

const DEFAULT_CASCADE = Object.freeze([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);

const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_BUDGET_MS = 90_000;

const RETRYABLE_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'CascadeAttemptTimeout',
  'FetchError',
]);

const RETRYABLE_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH',
]);

function defaultIsRetryable(err) {
  if (!err) return false;
  if (err.retryable === true) return true;
  if (err.retryable === false) return false;
  if (RETRYABLE_NAMES.has(err.name)) return true;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  const status = Number(err.status || err.statusCode || 0);
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

class CascadeAttemptTimeout extends Error {
  constructor(model, ms) {
    super(`cascade attempt for "${model}" timed out after ${ms}ms`);
    this.name = 'CascadeAttemptTimeout';
    this.model = model;
    this.timeoutMs = ms;
    this.retryable = true;
  }
}

class CascadeExhaustedError extends Error {
  constructor(message, attempts) {
    super(message);
    this.name = 'CascadeExhaustedError';
    this.attempts = attempts;
  }
}

function createFallbackCascade(opts = {}) {
  const models = Array.isArray(opts.models) && opts.models.length
    ? opts.models.slice()
    : DEFAULT_CASCADE.slice();
  const attemptTimeoutMs = Number.isFinite(opts.attemptTimeoutMs) && opts.attemptTimeoutMs > 0
    ? Math.floor(opts.attemptTimeoutMs)
    : DEFAULT_ATTEMPT_TIMEOUT_MS;
  const totalBudgetMs = Number.isFinite(opts.totalBudgetMs) && opts.totalBudgetMs > 0
    ? Math.floor(opts.totalBudgetMs)
    : DEFAULT_TOTAL_BUDGET_MS;
  const isRetryable = typeof opts.isRetryable === 'function' ? opts.isRetryable : defaultIsRetryable;
  const onAttempt = typeof opts.onAttempt === 'function' ? opts.onAttempt : null;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  async function runAttempt(runner, model, deadlineMs) {
    const remainingTotal = deadlineMs - now();
    if (remainingTotal <= 0) {
      throw new CascadeAttemptTimeout(model, 0);
    }
    const timeoutMs = Math.min(attemptTimeoutMs, remainingTotal);
    const ctrl = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new CascadeAttemptTimeout(model, timeoutMs));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => runner(model, ctrl.signal)),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function execute(runner) {
    if (typeof runner !== 'function') throw new TypeError('cascade.execute: runner function required');
    const startedAt = now();
    const deadline = startedAt + totalBudgetMs;
    const attempts = [];
    let lastError = null;

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const tStart = now();
      if (tStart >= deadline) {
        attempts.push({ model, ok: false, elapsedMs: 0, error: 'budget_exhausted_before_attempt' });
        break;
      }
      try {
        const value = await runAttempt(runner, model, deadline);
        const elapsedMs = now() - tStart;
        attempts.push({ model, ok: true, elapsedMs });
        if (onAttempt) {
          try { onAttempt({ model, attempt: i + 1, ok: true, elapsedMs }); } catch { /* swallow */ }
        }
        return { ok: true, model, value, attempts, totalElapsedMs: now() - startedAt };
      } catch (err) {
        const elapsedMs = now() - tStart;
        attempts.push({
          model,
          ok: false,
          elapsedMs,
          error: err && err.message,
          retryable: isRetryable(err),
        });
        if (onAttempt) {
          try { onAttempt({ model, attempt: i + 1, ok: false, error: err, elapsedMs }); } catch { /* swallow */ }
        }
        lastError = err;
        if (!isRetryable(err)) break; // 4xx-style: don't try cheaper models
        if (now() >= deadline) break;  // out of total budget
      }
    }

    const exhausted = new CascadeExhaustedError(
      `cascade exhausted after ${attempts.length} attempt(s): ${lastError && lastError.message}`,
      attempts,
    );
    exhausted.cause = lastError;
    throw exhausted;
  }

  return {
    execute,
    models: () => models.slice(),
    attemptTimeoutMs,
    totalBudgetMs,
  };
}

module.exports = {
  createFallbackCascade,
  defaultIsRetryable,
  CascadeAttemptTimeout,
  CascadeExhaustedError,
  DEFAULT_CASCADE,
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_TOTAL_BUDGET_MS,
};
