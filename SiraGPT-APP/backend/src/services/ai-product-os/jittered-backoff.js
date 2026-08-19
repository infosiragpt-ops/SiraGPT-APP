'use strict';

/**
 * jittered-backoff — pure-function backoff schedule generator. Returns
 * the delay (ms) the caller should sleep before retry attempt N. Three
 * strategies are supported:
 *
 *   - 'full'         : random in [0, base * 2^attempt], capped at maxMs.
 *                      Best general-purpose default per AWS' "Exponential
 *                      Backoff and Jitter" guidance — minimizes thundering
 *                      herd while keeping retries close to the optimal cap.
 *   - 'decorrelated' : random in [base, prev * 3], capped at maxMs.
 *                      Carries state between calls; smoother distribution
 *                      under sustained load.
 *   - 'fixed'        : exact base * 2^attempt, no randomness. Useful for
 *                      deterministic tests.
 *
 * Always honors a server's Retry-After hint when present (parsed from
 * either seconds or HTTP-date) — server hints win over computed delay.
 * Never exceeds maxMs.
 *
 * Public API:
 *   const sched = createJitteredBackoff({
 *     baseMs,        // default 200
 *     maxMs,         // default 30_000
 *     strategy,      // 'full' (default) | 'decorrelated' | 'fixed'
 *     rng,           // () => float in [0,1); default Math.random
 *   })
 *   sched.next({ attempt, retryAfter? })   → integer ms
 *   sched.reset()                          → resets decorrelated state
 *   parseRetryAfter(value, now)            → ms | null (exported helper)
 */

const DEFAULT_BASE_MS = 200;
const DEFAULT_MAX_MS = 30_000;
const DEFAULT_STRATEGY = 'full';
const STRATEGIES = new Set(['full', 'decorrelated', 'fixed']);

function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  // Numeric seconds.
  const asNum = Number(value);
  if (Number.isFinite(asNum)) return Math.max(0, Math.floor(asNum * 1000));
  // HTTP-date.
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed)) {
    const delta = parsed - Number(now);
    return Math.max(0, Math.floor(delta));
  }
  return null;
}

function createJitteredBackoff(opts = {}) {
  const baseMs = Number.isFinite(opts.baseMs) && opts.baseMs > 0 ? Math.floor(opts.baseMs) : DEFAULT_BASE_MS;
  const maxMs = Number.isFinite(opts.maxMs) && opts.maxMs > 0 ? Math.floor(opts.maxMs) : DEFAULT_MAX_MS;
  const strategy = STRATEGIES.has(opts.strategy) ? opts.strategy : DEFAULT_STRATEGY;
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;

  let prev = baseMs;

  function clamp(v) {
    if (!Number.isFinite(v) || v < 0) return 0;
    if (v > maxMs) return maxMs;
    return Math.floor(v);
  }

  function next({ attempt = 0, retryAfter = null, now = Date.now() } = {}) {
    if (retryAfter != null) {
      // Match HTTP semantics: numeric Retry-After is seconds.
      const hint = parseRetryAfter(retryAfter, now);
      if (hint != null) return clamp(hint);
    }
    const safeAttempt = Number.isFinite(attempt) && attempt >= 0 ? Math.floor(attempt) : 0;
    const exp = Math.min(maxMs, baseMs * Math.pow(2, safeAttempt));
    if (strategy === 'fixed') return clamp(exp);
    if (strategy === 'full') return clamp(rng() * exp);
    // decorrelated
    const lo = baseMs;
    const hi = Math.max(lo, Math.min(maxMs, prev * 3));
    const next = lo + rng() * (hi - lo);
    prev = next;
    return clamp(next);
  }

  function reset() { prev = baseMs; }

  return { next, reset, baseMs, maxMs, strategy };
}

module.exports = {
  createJitteredBackoff,
  parseRetryAfter,
  DEFAULT_BASE_MS,
  DEFAULT_MAX_MS,
  DEFAULT_STRATEGY,
  STRATEGIES,
};
