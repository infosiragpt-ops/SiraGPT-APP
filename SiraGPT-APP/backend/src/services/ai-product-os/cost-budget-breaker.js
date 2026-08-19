'use strict';

/**
 * cost-budget-breaker — per-tenant dollar/token spend tracker with a
 * circuit breaker that rejects calls once the configured window
 * budget is exhausted. Pairs with the streaming-budget-governor (#7)
 * which protects a single response, and the cascade fallback (#6)
 * which protects a single call; this one protects an account from
 * runaway month-over-month spend.
 *
 * Sliding window is bucketed at 1-minute granularity so the cost
 * accounting is O(1) per record() and the GC walk is O(buckets).
 *
 * Public API:
 *   const cb = createCostBudgetBreaker({
 *     tenantId,                         // required
 *     windowMs,                         // required (e.g. 24h, 1h, 30d)
 *     budgetUsd,                        // required, > 0
 *     halfOpenAfterMs,                  // default 60_000 — probe interval
 *     halfOpenAllowance,                // default 1 — probes during HALF_OPEN
 *     now,                              // clock injector
 *   })
 *   cb.allow()                          → { ok, state, spent, remaining, until? }
 *   cb.record({ usd, tokens, model })   → { spent, remaining, state }
 *   cb.snapshot()                       → state + totals
 *   cb.reset()                          → wipes counters; state → CLOSED
 *
 * STATE machine:
 *   CLOSED     — under budget; allow() returns ok:true.
 *   OPEN       — budget exhausted; allow() returns ok:false until
 *                halfOpenAfterMs elapses.
 *   HALF_OPEN  — probes are allowed (up to halfOpenAllowance). If a
 *                probe completes within budget, return to CLOSED;
 *                another over-budget record() snaps back to OPEN.
 */

const STATE_CLOSED = 'CLOSED';
const STATE_OPEN = 'OPEN';
const STATE_HALF_OPEN = 'HALF_OPEN';
const BUCKET_MS = 60_000; // 1-minute buckets

const DEFAULT_HALF_OPEN_AFTER_MS = 60_000;
const DEFAULT_HALF_OPEN_ALLOWANCE = 1;

function createCostBudgetBreaker(opts = {}) {
  if (!opts || typeof opts.tenantId !== 'string' || !opts.tenantId) {
    throw new TypeError('cost-budget-breaker: tenantId required');
  }
  const windowMs = Number(opts.windowMs);
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError('cost-budget-breaker: windowMs must be > 0');
  }
  const budgetUsd = Number(opts.budgetUsd);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new TypeError('cost-budget-breaker: budgetUsd must be > 0');
  }
  const halfOpenAfterMs = Number.isFinite(opts.halfOpenAfterMs) && opts.halfOpenAfterMs > 0
    ? Math.floor(opts.halfOpenAfterMs)
    : DEFAULT_HALF_OPEN_AFTER_MS;
  const halfOpenAllowance = Number.isFinite(opts.halfOpenAllowance) && opts.halfOpenAllowance > 0
    ? Math.floor(opts.halfOpenAllowance)
    : DEFAULT_HALF_OPEN_ALLOWANCE;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** @type {Map<number, {usd:number, tokens:number, count:number}>} */
  const buckets = new Map();
  let state = STATE_CLOSED;
  let openedAt = 0;
  let halfOpenProbes = 0;

  function bucketKey(t) { return Math.floor(t / BUCKET_MS) * BUCKET_MS; }

  function gc(t) {
    const cutoff = t - windowMs;
    for (const k of buckets.keys()) {
      if (k < cutoff) buckets.delete(k);
    }
  }

  function spent() {
    const t = now();
    gc(t);
    let usd = 0; let tokens = 0; let count = 0;
    for (const b of buckets.values()) { usd += b.usd; tokens += b.tokens; count += b.count; }
    return { usd, tokens, count };
  }

  function maybeTransitionFromOpen(t) {
    if (state !== STATE_OPEN) return;
    if (t - openedAt >= halfOpenAfterMs) {
      state = STATE_HALF_OPEN;
      halfOpenProbes = 0;
    }
  }

  function allow() {
    const t = now();
    maybeTransitionFromOpen(t);
    const s = spent();
    if (state === STATE_OPEN) {
      return { ok: false, state, spent: s, remaining: Math.max(0, budgetUsd - s.usd), until: openedAt + halfOpenAfterMs };
    }
    if (state === STATE_HALF_OPEN) {
      if (halfOpenProbes >= halfOpenAllowance) {
        return { ok: false, state, spent: s, remaining: Math.max(0, budgetUsd - s.usd) };
      }
      halfOpenProbes += 1;
      return { ok: true, state, spent: s, remaining: Math.max(0, budgetUsd - s.usd) };
    }
    return { ok: true, state, spent: s, remaining: Math.max(0, budgetUsd - s.usd) };
  }

  function record({ usd = 0, tokens = 0 } = {}) {
    const t = now();
    const k = bucketKey(t);
    const u = Math.max(0, Number(usd) || 0);
    const tk = Math.max(0, Number(tokens) || 0);
    const b = buckets.get(k) || { usd: 0, tokens: 0, count: 0 };
    b.usd += u; b.tokens += tk; b.count += 1;
    buckets.set(k, b);
    gc(t);
    const s = spent();
    if (s.usd >= budgetUsd) {
      state = STATE_OPEN;
      openedAt = t;
      halfOpenProbes = 0;
    } else if (state === STATE_HALF_OPEN) {
      // A probe completed under budget → recover to CLOSED.
      state = STATE_CLOSED;
      halfOpenProbes = 0;
    }
    return { spent: s, remaining: Math.max(0, budgetUsd - s.usd), state };
  }

  function snapshot() {
    const s = spent();
    return {
      tenantId: opts.tenantId,
      state,
      spent: s,
      budgetUsd,
      windowMs,
      remaining: Math.max(0, budgetUsd - s.usd),
      buckets: buckets.size,
      openedAt: state === STATE_OPEN ? openedAt : 0,
    };
  }

  function reset() {
    buckets.clear();
    state = STATE_CLOSED;
    openedAt = 0;
    halfOpenProbes = 0;
  }

  return { allow, record, snapshot, reset };
}

module.exports = {
  createCostBudgetBreaker,
  STATE_CLOSED,
  STATE_OPEN,
  STATE_HALF_OPEN,
  BUCKET_MS,
  DEFAULT_HALF_OPEN_AFTER_MS,
  DEFAULT_HALF_OPEN_ALLOWANCE,
};
