'use strict';

/**
 * dynamic-cost — cost-based rate limiting on top of the token bucket.
 *
 * The fixed token bucket charges every caller the same up front. That
 * works when requests are uniform, but it breaks down for endpoints
 * whose actual work varies by orders of magnitude:
 *
 *   - `/api/agents/batch` may run a single LLM call (~1k tokens) or a
 *     fork-join of 30 (~60k tokens). Charging both the same is either
 *     too punitive or too permissive.
 *   - `/api/files/*` may parse a 4 KB CSV in 5 ms or a 50 MB PDF in
 *     8000 ms of CPU. Same shape; very different cost.
 *
 * This module lets each handler report its actual cost when it
 * finishes. We charge an `initialCost` up front via `tryConsume` (so
 * abusive callers still get the 429 their burst earned them), then
 * reconcile against the real cost once the work is done. Reconciliation
 * is a clamped `adjust()` — the bucket never goes negative (no debt
 * carried to the next caller) and never exceeds capacity (no refund
 * past the burst ceiling).
 *
 * The cost model is plug-in: callers pass a `costFn({ baseCost,
 * report, cpuMs })` that turns raw signals into a token count. A
 * sensible default is provided (`defaultCostFn`) but the right
 * weights are workload-specific.
 *
 * Why retrospective and not predictive:
 *   We considered estimating cost from the request (file size, batch
 *   length) and charging that up front. In practice the estimate is
 *   wrong often enough that you end up reconciling anyway, and the
 *   prediction step adds latency to the hot path. Charging a flat
 *   initialCost up front and reconciling afterwards is simpler and
 *   the worst-case error is bounded by one bucket's burst capacity.
 *
 * Out of scope:
 *   Sharing dynamic cost across replicas. The reconciliation is local
 *   to the bucket on this replica. If a caller is sharded across
 *   replicas the per-replica bucket still adapts, but global fairness
 *   needs the Redis-backed limiter (which can be augmented with the
 *   same pattern in a follow-up).
 */

const {
  TokenBucketRegistry,
  makeRouteUserKey,
} = require('./token-bucket');

const DEFAULT_INITIAL_COST = 1;
const DEFAULT_TOKENS_PER_UNIT = 1000;
const DEFAULT_CPU_MS_PER_UNIT = 100;
const DEFAULT_MAX_DYNAMIC_COST = 1_000_000;

function nowMs() {
  return Date.now();
}

/**
 * defaultCostFn — turns a {tokens, cpuMs, baseCost} report into a
 * token count for the bucket.
 *
 *   cost = baseCost
 *        + tokens / DEFAULT_TOKENS_PER_UNIT      (1 bucket-token per 1k LLM tokens)
 *        + cpuMs  / DEFAULT_CPU_MS_PER_UNIT      (1 bucket-token per 100 ms CPU)
 *
 * Tune by passing your own `costFn`. The defaults are conservative
 * enough that a "typical" 2k-token, 200ms request costs ~4 bucket
 * tokens — roughly 4x a free request, which gives expensive routes
 * room to breathe without trivializing their effect.
 */
function defaultCostFn({ baseCost = DEFAULT_INITIAL_COST, report = {}, cpuMs = 0 } = {}) {
  let cost = Number.isFinite(baseCost) ? baseCost : DEFAULT_INITIAL_COST;
  if (Number.isFinite(report.tokens) && report.tokens > 0) {
    cost += report.tokens / DEFAULT_TOKENS_PER_UNIT;
  }
  const totalCpuMs = (Number.isFinite(report.cpuMs) ? report.cpuMs : 0)
    + (Number.isFinite(cpuMs) ? cpuMs : 0);
  if (totalCpuMs > 0) {
    cost += totalCpuMs / DEFAULT_CPU_MS_PER_UNIT;
  }
  if (Number.isFinite(report.extraCost) && report.extraCost > 0) {
    cost += report.extraCost;
  }
  if (cost < 0) cost = 0;
  if (cost > DEFAULT_MAX_DYNAMIC_COST) cost = DEFAULT_MAX_DYNAMIC_COST;
  return cost;
}

/**
 * createDynamicCostMiddleware — Express middleware that charges an
 * `initialCost` up front and reconciles against actual cost when the
 * response finishes (or when the handler explicitly calls
 * `req.reportRateCost(...)` and triggers `flush()`).
 *
 * Required options:
 *   capacity, refillRate, route — same as the underlying token bucket.
 *
 * Optional:
 *   keyGenerator   — function(req) → principal key. Defaults to
 *                    `ip:<req.ip>`.
 *   initialCost    — number | function(req) → tokens charged up
 *                    front. Defaults to 1.
 *   costFn         — function({baseCost, report, cpuMs}) → final
 *                    token count. Defaults to `defaultCostFn`.
 *   onLimit        — function(req, res, info) for custom 429 bodies.
 *   skip           — function(req) → boolean. Bypasses both charge
 *                    and reconciliation.
 *   registry       — pre-built TokenBucketRegistry (test injection).
 *   clock          — () → ms (test injection).
 *   measureCpu     — boolean (default true). Auto-measures handler
 *                    CPU via `process.hrtime.bigint()` and passes it
 *                    to `costFn`. Disable when you only want explicit
 *                    handler reports (e.g. proxied requests where
 *                    local CPU is meaningless).
 *
 * Per-request API attached to `req`:
 *   req.reportRateCost({ tokens, cpuMs, extraCost })
 *     — accumulates additive cost signals. Safe to call multiple
 *       times; the reports merge. Calling after the bucket is
 *       flushed is a no-op (with a debug-noise field set so tests
 *       can assert on it).
 *
 * The reconciliation runs at most once per request, on whichever
 * happens first: `res` finishes (`finish` / `close`) or the handler
 * calls `req.flushRateCost()` explicitly. Explicit flush is useful
 * for streaming endpoints that want to bill mid-stream rather than
 * at end of stream.
 */
function createDynamicCostMiddleware(options = {}) {
  const {
    capacity,
    refillRate,
    route,
    keyGenerator = (req) => `ip:${(req && req.ip) || 'unknown'}`,
    initialCost = DEFAULT_INITIAL_COST,
    costFn = defaultCostFn,
    onLimit,
    skip,
    registry,
    clock = nowMs,
    measureCpu = true,
  } = options;

  if (!route || typeof route !== 'string') {
    throw new TypeError('createDynamicCostMiddleware: route label is required');
  }
  if (typeof costFn !== 'function') {
    throw new TypeError('createDynamicCostMiddleware: costFn must be a function');
  }

  const reg = registry || new TokenBucketRegistry({ capacity, refillRate, clock });

  function resolveInitialCost(req) {
    let v;
    try {
      v = typeof initialCost === 'function' ? initialCost(req) : initialCost;
    } catch (_err) {
      v = DEFAULT_INITIAL_COST;
    }
    if (!Number.isFinite(v) || v <= 0) v = DEFAULT_INITIAL_COST;
    return v;
  }

  return function dynamicCostMiddleware(req, res, next) {
    if (typeof skip === 'function' && skip(req)) {
      return next();
    }

    let principal;
    try {
      principal = keyGenerator(req);
    } catch (_err) {
      principal = `ip:${(req && req.ip) || 'unknown'}`;
    }
    const key = makeRouteUserKey(route, principal);
    const upfront = resolveInitialCost(req);

    const result = reg.consume(key, upfront);

    if (typeof res.setHeader === 'function') {
      res.setHeader(
        'RateLimit-Policy',
        `${reg.capacity};burst=${reg.capacity};rate=${reg.refillRate}/s;mode=dynamic`,
      );
      res.setHeader('RateLimit-Limit', String(reg.capacity));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, result.remaining)));
      if (!result.allowed) {
        const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(retryAfterSec));
        res.setHeader('RateLimit-Reset', String(retryAfterSec));
      }
    }

    if (!result.allowed) {
      if (typeof onLimit === 'function') {
        return onLimit(req, res, { ...result, key, route });
      }
      if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res
          .status(429)
          .json({ error: 'rate_limited', route, retryAfterMs: result.retryAfterMs });
      }
      if (typeof res.statusCode !== 'undefined') res.statusCode = 429;
      if (typeof res.end === 'function') res.end();
      return undefined;
    }

    // Build the per-request reconciliation context. `report` is
    // accumulative: handlers can call reportRateCost() repeatedly and
    // their signals merge.
    const report = { tokens: 0, cpuMs: 0, extraCost: 0 };
    let flushed = false;
    let flushInfo = null;

    const startCpu = measureCpu && typeof process !== 'undefined'
      && process.cpuUsage
      ? process.cpuUsage()
      : null;

    function measuredCpuMs() {
      if (!startCpu) return 0;
      try {
        const diff = process.cpuUsage(startCpu);
        // user + system, micro→milli
        return (diff.user + diff.system) / 1000;
      } catch (_err) {
        return 0;
      }
    }

    function flush(reason = 'auto') {
      if (flushed) return flushInfo;
      flushed = true;
      let finalCost;
      try {
        finalCost = costFn({
          baseCost: upfront,
          report: { ...report },
          cpuMs: measuredCpuMs(),
        });
      } catch (_err) {
        finalCost = upfront;
      }
      if (!Number.isFinite(finalCost) || finalCost < 0) finalCost = upfront;
      const delta = finalCost - upfront;
      let adjustResult = null;
      if (delta !== 0) {
        adjustResult = reg.adjust(key, delta);
      }
      flushInfo = {
        reason,
        upfront,
        finalCost,
        delta,
        remaining: adjustResult ? adjustResult.remaining : Math.max(0, result.remaining),
        capacity: reg.capacity,
        key,
        route,
      };
      return flushInfo;
    }

    req.reportRateCost = function reportRateCost(input = {}) {
      if (flushed) {
        // Late report — record so callers/tests can detect ordering
        // bugs without throwing in production.
        req._rateCostLateReport = (req._rateCostLateReport || 0) + 1;
        return false;
      }
      if (Number.isFinite(input.tokens) && input.tokens > 0) {
        report.tokens += input.tokens;
      }
      if (Number.isFinite(input.cpuMs) && input.cpuMs > 0) {
        report.cpuMs += input.cpuMs;
      }
      if (Number.isFinite(input.extraCost) && input.extraCost > 0) {
        report.extraCost += input.extraCost;
      }
      return true;
    };

    req.flushRateCost = function flushRateCost() {
      return flush('manual');
    };

    // Auto-flush on response completion. We listen for both `finish`
    // (normal end) and `close` (client aborted) so the bucket is
    // reconciled even when the response was cut short.
    let autoFlushDone = false;
    function autoFlush() {
      if (autoFlushDone) return;
      autoFlushDone = true;
      const info = flush('auto');
      if (info && typeof res.setHeader === 'function' && !res.headersSent) {
        // Best-effort: only set if headers haven't been sent yet.
        try {
          res.setHeader('RateLimit-Remaining', String(Math.max(0, info.remaining)));
        } catch (_err) {
          // ignore — header machinery may have moved on
        }
      }
    }
    if (typeof res.on === 'function') {
      res.on('finish', autoFlush);
      res.on('close', autoFlush);
    }

    return next();
  };
}

module.exports = {
  createDynamicCostMiddleware,
  defaultCostFn,
  DEFAULT_INITIAL_COST,
  DEFAULT_TOKENS_PER_UNIT,
  DEFAULT_CPU_MS_PER_UNIT,
  DEFAULT_MAX_DYNAMIC_COST,
};
