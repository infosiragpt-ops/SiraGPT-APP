'use strict';

/**
 * enforce-plan-quota — Express middleware that blocks a request
 * with HTTP 429 when the authenticated user has exhausted the
 * quota of their plan. Always sets `X-Plan-Quota-*` response
 * headers so the client can render a "82% of your monthly quota
 * used" affordance regardless of whether the request is allowed
 * through.
 *
 * MUST run AFTER `authenticateToken` — the snapshot is computed
 * from `req.user`. Anonymous traffic (no `req.user`) is allowed
 * through silently; the rate-limiter is the right gate for that
 * surface, not this one.
 *
 * Why this middleware exists alongside the existing /api/ai
 * decrement-or-fail logic:
 *   - /api/ai already enforces quotas via four duplicated atomic-
 *     decrement code paths. Those paths are battle-tested and we
 *     do NOT touch them in this commit.
 *   - The expensive routes added in phase 8g (/api/agent, /api/rag,
 *     /api/document-ai) had ZERO quota enforcement before this
 *     middleware. A FREE user could fire unbounded document
 *     generations. This middleware closes that gap.
 *   - A future commit will refactor /api/ai's four call sites to
 *     use the same shared `plan-quota` service so all enforcement
 *     reads from one source of truth.
 *
 * Feature-flag posture (PLAN_QUOTAS_ENFORCED):
 *   - default ON. Expensive routes that didn't enforce before
 *     should not regress to "no enforcement" when this code lands.
 *   - PLAN_QUOTAS_ENFORCED=false provides an emergency rollback
 *     for ops if a bug causes false-positive 429s. Headers still
 *     surface in that mode (read-only telemetry stays on).
 */

const {
  getPlanQuotaSnapshot,
  countFreeDailyCalls,
  isPlanQuotaExempt,
  WARNING_THRESHOLD,
} = require('../services/plan-quota');
const prisma = require('../config/database');
const {
  capturePostHogEvent,
} = require('../services/observability/posthog');

const HEADER_USED = 'X-Plan-Quota-Used';
const HEADER_LIMIT = 'X-Plan-Quota-Limit';
const HEADER_REMAINING = 'X-Plan-Quota-Remaining';
const HEADER_KIND = 'X-Plan-Quota-Kind';
const HEADER_PLAN = 'X-Plan-Quota-Plan';

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function isEnforcementEnabled(env = process.env) {
  return parseBoolean(env.PLAN_QUOTAS_ENFORCED, true);
}

function setQuotaHeaders(res, snapshot) {
  if (!snapshot || snapshot.kind === 'none') return;
  res.setHeader(HEADER_PLAN, snapshot.plan);
  res.setHeader(HEADER_KIND, snapshot.kind);
  res.setHeader(HEADER_USED, String(snapshot.used));
  res.setHeader(HEADER_LIMIT, String(snapshot.limit));
  res.setHeader(HEADER_REMAINING, String(snapshot.remaining));
}

/**
 * enforcePlanQuota — middleware factory. Accepts options for
 * scoping the event labels so a /api/document-ai 429 looks
 * different in dashboards than a /api/agent 429.
 *
 *   options.surface: short label included in posthog events
 *                    (e.g. 'document-ai', 'agent', 'rag').
 *   options.envOverride: only used by tests to inject a fake env.
 *
 * Telemetry is always best-effort: a posthog hiccup never blocks
 * the request path. The `capturePostHogEvent` helper itself returns
 * false on failure but does not throw.
 */
function enforcePlanQuota(options = {}) {
  const surface = String(options.surface || 'unknown');
  const env = options.envOverride || process.env;
  const prismaClient = options.prismaClient || prisma;

  return function enforcePlanQuotaMiddleware(req, res, next) {
    // Anonymous traffic — no user, no quota. The rate limiter
    // (rate-limit-policy.js, JWT-aware key generator) handles that
    // surface; we don't double-gate here.
    if (!req || !req.user) return next();

    // superAdmins transcend plan quotas (see plan-quota.isPlanQuotaExempt).
    // Short-circuit before the async block so a staff account never pays
    // the daily-count DB read and never trips the 429 gate.
    if (isPlanQuotaExempt(req.user)) return next();

    Promise.resolve()
      .then(async () => {
        const freeDailyCallsUsed = req.user.plan === 'FREE'
          ? await countFreeDailyCalls({ userId: req.user.id, prisma: prismaClient })
          : null;
        const snapshot = getPlanQuotaSnapshot(req.user, { freeDailyCallsUsed });

        // Always surface the snapshot so clients can render quota state
        // even on success responses. This stays on even when enforcement
        // is disabled — the headers are read-only telemetry.
        setQuotaHeaders(res, snapshot);

        // No quota to enforce (e.g. ENTERPRISE with monthlyLimit=0 means
        // unlimited). Pass through silently with headers set.
        if (snapshot.kind === 'none' || snapshot.limit === 0) return next();

        // Telemetry hooks — fire BEFORE the allow/deny decision so a
        // 429 still emits its own event, and a warning is captured even
        // for an allowed request.
        if (snapshot.exceeded) {
          capturePostHogEvent({
            distinctId: req.user.id,
            event: 'plan.quota_exceeded',
            properties: {
              surface,
              plan: snapshot.plan,
              kind: snapshot.kind,
              used: snapshot.used,
              limit: snapshot.limit,
              percentage: snapshot.percentage,
              method: req.method,
              path: req.originalUrl || req.url,
            },
          });
        } else if (snapshot.warning) {
          capturePostHogEvent({
            distinctId: req.user.id,
            event: 'plan.quota_warning',
            properties: {
              surface,
              plan: snapshot.plan,
              kind: snapshot.kind,
              used: snapshot.used,
              limit: snapshot.limit,
              percentage: snapshot.percentage,
            },
          });
        }

        // Enforcement gate. Disabled mode keeps the headers + telemetry
        // on but never returns 429 — useful for measuring "how many
        // requests would have been blocked?" before flipping the flag.
        if (!isEnforcementEnabled(env)) return next();

        if (snapshot.exceeded) {
          return res.status(429).json({
            error: snapshot.plan === 'FREE'
              ? 'Free daily queries exhausted. Please upgrade to continue.'
              : 'Plan quota exceeded',
            plan: snapshot.plan,
            kind: snapshot.kind,
            used: snapshot.used,
            limit: snapshot.limit,
            remaining: snapshot.remaining,
            upgradeRequired: snapshot.plan === 'FREE',
            surface,
          });
        }

        return next();
      })
      .catch((err) => {
        // Quota accounting should never brick the app because a DB read
        // hiccuped. Log and allow; provider/token accounting still records
        // usage after a successful generation.
        try { console.warn('[enforce-plan-quota] daily quota check failed:', err && err.message); } catch (_) {}
        return next();
      });
  };
}

module.exports = {
  enforcePlanQuota,
  isEnforcementEnabled,
  setQuotaHeaders,
  WARNING_THRESHOLD,
  HEADER_USED,
  HEADER_LIMIT,
  HEADER_REMAINING,
  HEADER_KIND,
  HEADER_PLAN,
};
