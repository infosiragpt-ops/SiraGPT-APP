'use strict';

/**
 * plan-quota — single source of truth for "how much of their plan
 * has this user consumed?". The Prisma User model carries two
 * orthogonal counters that previously lived only inside ad-hoc
 * checks scattered across `/api/ai`:
 *
 *   FREE plan:
 *     `monthlyCallLimit` is a REMAINING-call counter. New FREE users
 *     start at 3 (passport.js seeds it on signup) and the chat path
 *     atomically decrements it on each generation. The "limit" is
 *     the original allowance — also 3 for FREE.
 *
 *   PRO / PRO_MAX / ENTERPRISE:
 *     `apiUsage` is a token counter incremented after each
 *     generation. `monthlyLimit` is the user-record cap (paid plans
 *     accumulate credits via the Stripe webhook, so the cap lives
 *     on the user row, not in a constant).
 *
 * This module exposes two pure helpers and one thin DB helper. The
 * pure helpers can be unit-tested without booting Prisma; the DB
 * helper is the single place we touch the database when a route
 * needs the freshest counter.
 *
 * Why this exists as its own service:
 *   The same FREE-vs-PAID branching logic appears at four call sites
 *   in `backend/src/routes/ai.js` (decrement-or-fail patterns at
 *   lines 824, 3020, 3164, 3299). A future commit will refactor
 *   those to use this module; for now we ship the module + the new
 *   `enforce-plan-quota` middleware that uses it on the expensive
 *   endpoints (/api/agent, /api/rag, /api/document-ai) which had
 *   ZERO quota enforcement before this change.
 */

const FREE_CALL_LIMIT = 3;

// Threshold below which we emit a "warning" event but still allow
// the request through. 80% matches usage-monitor.js's existing
// thresholds for email alerts so the dashboards line up.
const WARNING_THRESHOLD = 0.8;

/**
 * Coerce a Prisma BigInt-ish value (BigInt, number, string, null)
 * to a finite plain number. Snapshots are read-only and used for
 * percent math, so a JS number is more useful than a BigInt.
 * Returns 0 for missing / invalid values rather than NaN — the
 * caller uses these in arithmetic and an undetected NaN would silently
 * disable threshold checks.
 */
function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'bigint') return Number(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampPercentage(used, limit) {
  if (!limit || limit <= 0) return 0;
  const ratio = used / limit;
  if (!Number.isFinite(ratio)) return 0;
  return Math.max(0, Math.min(1, ratio));
}

/**
 * getPlanQuotaSnapshot — pure function. Returns a normalized view
 * of the user's quota state with `kind: 'calls' | 'tokens'`. Never
 * throws; null/undefined input returns a "no quota" snapshot so
 * upstream code can treat anonymous traffic uniformly.
 *
 * Returned shape (stable; downstream tooling reads these field names):
 *   {
 *     plan:       'FREE' | 'PRO' | 'PRO_MAX' | 'ENTERPRISE' | null,
 *     kind:       'calls' | 'tokens' | 'none',
 *     used:       number,    // how many calls / tokens consumed this period
 *     limit:      number,    // the cap; 0 means "unlimited / no enforcement"
 *     remaining:  number,    // max(0, limit - used) — clamped, never negative
 *     percentage: number,    // 0..1, clamped
 *     exceeded:   boolean,   // percentage >= 1 (used >= limit)
 *     warning:    boolean,   // percentage >= WARNING_THRESHOLD (and not exceeded)
 *   }
 */
function getPlanQuotaSnapshot(user) {
  if (!user || !user.plan) {
    return {
      plan: null,
      kind: 'none',
      used: 0,
      limit: 0,
      remaining: 0,
      percentage: 0,
      exceeded: false,
      warning: false,
    };
  }

  if (user.plan === 'FREE') {
    // monthlyCallLimit on the user row is the REMAINING counter,
    // not the cap. FREE plans always cap at FREE_CALL_LIMIT (currently
    // 3); changing the cap is a config change here, not a per-user
    // mutation. `used` is derived: limit - remaining, clamped to
    // [0, limit] so a transient negative-remaining race (rare but
    // possible under concurrent atomic decrements) doesn't surface
    // a "used 4 of 3" UI artifact.
    const remaining = toNumber(user.monthlyCallLimit);
    const limit = FREE_CALL_LIMIT;
    const used = Math.max(0, Math.min(limit, limit - remaining));
    const percentage = clampPercentage(used, limit);
    return {
      plan: 'FREE',
      kind: 'calls',
      used,
      limit,
      remaining: Math.max(0, remaining),
      percentage,
      exceeded: percentage >= 1 || remaining <= 0,
      warning: percentage >= WARNING_THRESHOLD && percentage < 1,
    };
  }

  // Paid plans (PRO / PRO_MAX / ENTERPRISE): token-based metering.
  // apiUsage is incremented after each generation; monthlyLimit is
  // the per-user cap (Stripe webhook adds plan credits on upgrade).
  const used = toNumber(user.apiUsage);
  const limit = toNumber(user.monthlyLimit);
  const percentage = clampPercentage(used, limit);
  const remaining = Math.max(0, limit - used);
  return {
    plan: user.plan,
    kind: 'tokens',
    used,
    limit,
    remaining,
    percentage,
    exceeded: limit > 0 && percentage >= 1,
    warning: limit > 0 && percentage >= WARNING_THRESHOLD && percentage < 1,
  };
}

/**
 * fetchUserPlanQuota — DB helper that re-reads the latest counters
 * from Prisma and returns a snapshot. Use this when the request's
 * `req.user` may be stale (e.g., after a long-running websocket).
 *
 * Returns null when the user does not exist, so the caller can
 * decide between "deny" (treat as exhausted) and "allow" (treat as
 * anonymous). Never throws — DB errors degrade to null with a
 * console.warn so a flaky DB doesn't block all requests.
 */
async function fetchUserPlanQuota(userId, prisma) {
  if (!userId || !prisma) return null;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        plan: true,
        apiUsage: true,
        monthlyCallLimit: true,
        monthlyLimit: true,
      },
    });
    if (!user) return null;
    return getPlanQuotaSnapshot(user);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[plan-quota] fetchUserPlanQuota failed:', err && err.message);
    return null;
  }
}

/**
 * tryConsumePlanQuota — atomic check-and-consume primitive used by
 * the chat path (`backend/src/routes/ai.js`). Replaces seven byte-
 * identical inline blocks that each:
 *
 *   FREE plan:
 *     - prisma.user.updateMany({
 *         where: { id, monthlyCallLimit: { gt: 0 } },
 *         data:  { monthlyCallLimit: { decrement: 1 } },
 *       })
 *     - if no row matched → 429 with the exhausted-queries message.
 *
 *   PAID plans:
 *     - if user.apiUsage >= user.monthlyLimit → 429 with the
 *       monthly-API-limit message and the current usage / limit.
 *
 * The shape of the 429 responses is preserved BYTE-FOR-BYTE so a
 * client UI that branches off `error === 'Free monthly queries
 * exhausted. Please upgrade to continue.'` continues to work
 * unchanged. Field order and types in the response body are also
 * preserved (BigInt apiUsage / monthlyLimit are forwarded as-is;
 * the existing `bigintSerializerMiddleware` in index.js handles
 * JSON serialization).
 *
 * Why a discriminated `{ ok, status, body }` and not `throw`:
 *   The caller already owns the response object. Throwing forces
 *   the route into a try/catch that turns a 429 into a 500, which
 *   is exactly the regression we want to avoid. A plain object
 *   keeps the existing call shape (`if (!result) return ...`).
 *
 * @param {Object} params
 * @param {string} params.userId   The Prisma User id (must match
 *                                 req.user.id; passed separately for
 *                                 stub-friendly testing).
 * @param {Object} params.prisma   The Prisma client (so tests can
 *                                 inject a stub without booting
 *                                 the real DB).
 * @param {Object|null} params.user The req.user row. When null/
 *                                 undefined (anonymous traffic) the
 *                                 function returns `{ ok: true }`
 *                                 immediately — anonymous traffic is
 *                                 already gated by other layers
 *                                 (rate limit, auth middleware) and
 *                                 has no plan to enforce against.
 * @returns {Promise<{ok: true} | {ok: false, status: number, body: object}>}
 */
async function tryConsumePlanQuota({ userId, prisma, user } = {}) {
  if (!user) return { ok: true };

  if (user.plan === 'FREE') {
    // Atomic CAS-style decrement: the WHERE clause both reads the
    // current counter (>0) and the UPDATE writes the new value in
    // a single Prisma query. Concurrent requests that race for the
    // last call will see exactly one winner — the loser gets count:0.
    const result = await prisma.user.updateMany({
      where: {
        id: userId,
        monthlyCallLimit: { gt: 0 },
      },
      data: {
        monthlyCallLimit: { decrement: 1 },
      },
    });
    if (!result || result.count === 0) {
      return {
        ok: false,
        status: 429,
        body: {
          error: 'Free monthly queries exhausted. Please upgrade to continue.',
          remaining: 0,
        },
      };
    }
    return { ok: true };
  }

  // Paid plans: token-based check is non-atomic on purpose. The
  // counter (apiUsage) is incremented AFTER the LLM call returns,
  // so there's a race where two concurrent calls both pass this
  // check and the running total exceeds the cap by one request.
  // That's acceptable — token over-shoot of one request is far
  // cheaper than the latency cost of a synchronous DB roundtrip
  // before every chat turn. The snapshot in `getPlanQuotaSnapshot`
  // already clamps percentage to 1 so dashboards and headers
  // never lie about a 110% used count.
  if (user.apiUsage >= user.monthlyLimit) {
    return {
      ok: false,
      status: 429,
      body: {
        error: 'Monthly API limit exceeded',
        usage: { current: user.apiUsage, limit: user.monthlyLimit },
      },
    };
  }

  return { ok: true };
}

module.exports = {
  getPlanQuotaSnapshot,
  fetchUserPlanQuota,
  tryConsumePlanQuota,
  FREE_CALL_LIMIT,
  WARNING_THRESHOLD,
};
