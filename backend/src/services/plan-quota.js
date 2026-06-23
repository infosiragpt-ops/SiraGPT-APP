'use strict';

/**
 * plan-quota — single source of truth for "how much of their plan
 * has this user consumed?". The Prisma User model carries two
 * orthogonal counters that previously lived only inside ad-hoc
 * checks scattered across `/api/ai`:
 *
 *   FREE plan:
 *     TEXT chat is limited to 3 successful generations per local day
 *     across any visible model. Turns that carry a document/image
 *     attachment are EXEMPT — file analysis always works on FREE and
 *     does not consume the text budget (the chat route skips the usage
 *     write for those turns). Legacy `monthlyCallLimit` remains on the
 *     User row for older UI/accounting surfaces, but the live gate
 *     counts ApiUsage rows for today's window.
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
 * isPlanQuotaExempt — superAdmins transcend plan quotas entirely.
 *
 * This mirrors `require-paid-plan.js`, which already lets
 * `req.user.isSuperAdmin` bypass the paid-feature gate. Without this,
 * a superAdmin whose `plan` field is still `FREE` (e.g. the seeded
 * owner/admin account created by `scripts/create-superadmin.js`, or
 * any admin account that predates plan assignment) gets blocked by the
 * FREE 3-calls/day cap — so the very operator of the platform can't
 * use their own product after three messages. The plan-quota gate is a
 * monetization control for end users, not a leash on staff accounts.
 *
 * Exemption keys off `isSuperAdmin` only (not `isAdmin`) to match the
 * exact bypass surface of `require-paid-plan.js`; widening it is a
 * deliberate decision, not an accident of this helper.
 */
function isPlanQuotaExempt(user) {
  return Boolean(user && user.isSuperAdmin === true);
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
function getFreeDailyWindow(now = new Date(), env = process.env) {
  const rawOffset = Number.parseInt(env.SIRAGPT_FREE_DAILY_TZ_OFFSET_MINUTES || '-240', 10);
  const offsetMinutes = Number.isFinite(rawOffset) ? rawOffset : -240;
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  const shiftedStartUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  );
  const start = new Date(shiftedStartUtc - offsetMinutes * 60_000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

async function countFreeDailyCalls({ userId, prisma, now = new Date(), env = process.env } = {}) {
  if (!userId || !prisma?.apiUsage?.count) return 0;
  const { start, end } = getFreeDailyWindow(now, env);
  return prisma.apiUsage.count({
    where: {
      userId,
      timestamp: {
        gte: start,
        lt: end,
      },
    },
  });
}

function getPlanQuotaSnapshot(user, options = {}) {
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

  // superAdmins are never metered. Report an unlimited, never-exceeded
  // snapshot so quota headers and dashboards show "no enforcement"
  // rather than a misleading "3/3 used" for a staff account.
  if (isPlanQuotaExempt(user)) {
    return {
      plan: user.plan,
      kind: 'none',
      used: 0,
      limit: 0,
      remaining: 0,
      percentage: 0,
      exceeded: false,
      warning: false,
      unlimited: true,
    };
  }

  if (user.plan === 'FREE') {
    const usedFromDailyRows = options.freeDailyCallsUsed == null ? null : toNumber(options.freeDailyCallsUsed);
    const legacyRemaining = Math.max(0, Math.min(FREE_CALL_LIMIT, toNumber(user.monthlyCallLimit ?? FREE_CALL_LIMIT)));
    const used = usedFromDailyRows == null
      ? Math.max(0, FREE_CALL_LIMIT - legacyRemaining)
      : Math.max(0, usedFromDailyRows);
    const percentage = clampPercentage(used, FREE_CALL_LIMIT);
    return {
      plan: 'FREE',
      kind: 'calls',
      used,
      limit: FREE_CALL_LIMIT,
      remaining: Math.max(0, FREE_CALL_LIMIT - used),
      percentage,
      exceeded: used >= FREE_CALL_LIMIT,
      warning: percentage >= WARNING_THRESHOLD && used < FREE_CALL_LIMIT,
      unlimited: false,
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
    const freeDailyCallsUsed = user.plan === 'FREE'
      ? await countFreeDailyCalls({ userId, prisma })
      : null;
    return getPlanQuotaSnapshot(user, { freeDailyCallsUsed });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[plan-quota] fetchUserPlanQuota failed:', err && err.message);
    return null;
  }
}

/**
 * checkPaidTokenCap — pure, synchronous "is this paid user over their
 * token cap?" check. This is the single source of truth for the
 * `apiUsage >= monthlyLimit → 429` gate that was previously inlined
 * byte-for-byte at four call sites in `backend/src/routes/ai.js`
 * (/paraphrase, /generate-image ×2, /generate-video).
 *
 * Those routes sit behind `requirePaidPlan`, so the caller is always a
 * paid plan (or a superAdmin) — there is no FREE daily-call branch to
 * run, which is why they use this pure helper rather than
 * `tryConsumePlanQuota` (the latter does an async FREE daily-count DB
 * read that would be pointless, and would change behavior for the
 * superAdmin-on-FREE edge case). Keeping it pure means it never throws
 * and never touches the DB.
 *
 * Behavior is preserved exactly from the inline blocks:
 *   - comparison is the raw `>=` on whatever `apiUsage` / `monthlyLimit`
 *     are (BigInt or number), so the 429 boundary is identical;
 *   - the 429 body forwards the raw values under `usage: { current,
 *     limit }` (the existing `bigintSerializerMiddleware` serializes
 *     BigInt);
 *   - `message` defaults to the generic 'Monthly API limit exceeded'
 *     and is overridable so the video route keeps its domain-specific
 *     'Monthly video generation limit exceeded' string.
 *
 * @param {Object|null} user                 The req.user row (null → allow).
 * @param {Object} [opts]
 * @param {string} [opts.message]            429 error string override.
 * @returns {{ok: true} | {ok: false, status: number, body: object}}
 */
function checkPaidTokenCap(user, { message = 'Monthly API limit exceeded' } = {}) {
  if (!user) return { ok: true };
  // monthlyLimit === 0 means "no enforcement" (legacy / staff / unlimited
  // accounts), matching getPlanQuotaSnapshot's `limit > 0 && …` posture. Without
  // this guard, apiUsage >= 0 is always true and those accounts get bricked with
  // a 429 on every paid route (paraphrase / image / video).
  if (user.monthlyLimit > 0 && user.apiUsage >= user.monthlyLimit) {
    return {
      ok: false,
      status: 429,
      body: {
        error: message,
        usage: { current: user.apiUsage, limit: user.monthlyLimit },
      },
    };
  }
  return { ok: true };
}

/**
 * recordApiUsage — single source of truth for the post-generation
 * "write an ApiUsage row + bump the user's apiUsage counter" pattern
 * that was inlined identically at three image/video call sites in
 * `backend/src/routes/ai.js`. Mirrors the original two writes exactly:
 *
 *   1. prisma.apiUsage.create({ data: { userId, model, tokens,
 *        cost: tokens * 0.001 } })
 *   2. prisma.user.update({ where: { id: userId },
 *        data: { apiUsage: { increment: tokens } } })
 *
 * The cost-per-token factor (0.001) is the constant every site used.
 * Returns the updated user row (the second write's result) so callers
 * can keep echoing `usage: { current: updatedUser.apiUsage, limit:
 * updatedUser.monthlyLimit }` in their responses. Awaiting the create
 * before the update preserves the original ordering: a failed usage
 * insert short-circuits before the counter is bumped.
 *
 * @param {Object} params
 * @param {Object} params.prisma  Prisma client.
 * @param {string} params.userId  User id.
 * @param {string} params.model   Model id stamped on the ApiUsage row.
 * @param {number} params.tokens  Token count to record + increment by.
 * @returns {Promise<Object>} the updated user row.
 */
async function recordApiUsage({ prisma, userId, model, tokens } = {}) {
  // Write the ApiUsage row and bump the user counter as ONE unit — otherwise a
  // failure between them leaves the row-based FREE gate and the counter-based
  // paid gate disagreeing about how much the user has spent.
  const [, updatedUser] = await prisma.$transaction([
    prisma.apiUsage.create({
      data: { userId, model, tokens, cost: tokens * 0.001 },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { apiUsage: { increment: tokens } },
    }),
  ]);
  return updatedUser;
}

/**
 * tryConsumePlanQuota — atomic check-and-consume primitive used by
 * the chat path (`backend/src/routes/ai.js`). Replaces seven byte-
 * identical inline blocks that each:
 *
 *   FREE plan:
 *     - allow up to 3 successful generations per local day across
 *       any visible model.
 *
 *   PAID plans:
 *     - if user.apiUsage >= user.monthlyLimit → 429 with the
 *       monthly-API-limit message and the current usage / limit.
 *
 * The paid 429 response shape is preserved so client UI that branches
 * off `error === 'Monthly API limit exceeded'` continues to work
 * unchanged. BigInt apiUsage / monthlyLimit values are forwarded as-is;
 * the existing `bigintSerializerMiddleware` in index.js handles JSON
 * serialization.
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
async function tryConsumePlanQuota({ userId, prisma, user, hasAttachments = false } = {}) {
  if (!user) return { ok: true };

  // superAdmins bypass the plan gate entirely (see isPlanQuotaExempt).
  // Returning before the FREE branch also skips the daily-count DB read.
  if (isPlanQuotaExempt(user)) {
    return { ok: true, unlimited: true, bypass: 'superadmin' };
  }

  if (user.plan === 'FREE') {
    // Product rule: the FREE daily cap meters TEXT-only generations
    // (3/day). A turn that carries a document/image attachment is exempt
    // — file analysis must always work on FREE. We return before the
    // daily-count read so the attachment turn is never blocked; the chat
    // route also skips its usage write so it doesn't consume the text
    // budget (see saveChatAndTrackUsage in routes/ai.js).
    if (hasAttachments) {
      return { ok: true, exempt: 'attachment', dailyLimit: FREE_CALL_LIMIT };
    }
    const usedToday = await countFreeDailyCalls({ userId: userId || user.id, prisma });
    if (usedToday >= FREE_CALL_LIMIT) {
      const { end } = getFreeDailyWindow();
      return {
        ok: false,
        status: 429,
        body: {
          error: 'Free daily queries exhausted. Please upgrade to continue.',
          remaining: 0,
          dailyLimit: FREE_CALL_LIMIT,
          usedToday,
          resetAt: end.toISOString(),
          upgradeRequired: true,
        },
      };
    }
    return {
      ok: true,
      remaining: Math.max(0, FREE_CALL_LIMIT - usedToday),
      dailyLimit: FREE_CALL_LIMIT,
    };
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
  //
  // The cap check itself is delegated to checkPaidTokenCap so the
  // paid-plan 429 shape lives in exactly one place (this path and the
  // four /api/ai paid routes now produce byte-identical bodies).
  return checkPaidTokenCap(user);
}

module.exports = {
  getPlanQuotaSnapshot,
  getFreeDailyWindow,
  isPlanQuotaExempt,
  countFreeDailyCalls,
  fetchUserPlanQuota,
  tryConsumePlanQuota,
  checkPaidTokenCap,
  recordApiUsage,
  FREE_CALL_LIMIT,
  WARNING_THRESHOLD,
};
