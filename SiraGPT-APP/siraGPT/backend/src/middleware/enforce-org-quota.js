'use strict';

/**
 * enforce-org-quota — Express middleware that enforces a per-org
 * monthly AI request budget when the caller is acting "on behalf of"
 * an organization. The org context is signaled via either:
 *   - request header `X-Org-Id: <orgId>`, or
 *   - request body `organizationId: <orgId>`
 *
 * If no org context is present the middleware is a no-op and the
 * request falls back to the per-user quota path. This is intentional:
 * personal usage should not be billed to an org and vice versa.
 *
 * Behaviour:
 *   1. Resolve org context from header/body.
 *   2. Verify caller has a membership on that org (403 otherwise).
 *   3. Load the org; reset `usedThisMonth` if the calendar month has
 *      rolled over since `quotaResetAt`.
 *   4. Block (HTTP 429 with X-Org-Quota-* headers) if usedThisMonth
 *      already meets/exceeds monthlyQuota.
 *   5. Increment `usedThisMonth` BEFORE the handler runs (optimistic
 *      reservation pattern). On request failure the route can call
 *      `req.orgContext.refund()` to roll back the +1.
 *
 * Feature-flag posture (ORG_QUOTAS_ENFORCED):
 *   - default ON. Set ORG_QUOTAS_ENFORCED=false to disable enforcement
 *     while still surfacing the X-Org-Quota-* headers for telemetry.
 *
 * Designed to run AFTER `authenticateToken` — anonymous requests are
 * passed through (the rate-limiter is the right gate for those).
 */

const prisma = require('../config/database');

const HEADER_USED = 'X-Org-Quota-Used';
const HEADER_LIMIT = 'X-Org-Quota-Limit';
const HEADER_REMAINING = 'X-Org-Quota-Remaining';
const HEADER_ORG = 'X-Org-Quota-OrgId';

function isEnforced() {
  const v = process.env.ORG_QUOTAS_ENFORCED;
  if (v == null) return true;
  return String(v).toLowerCase() !== 'false';
}

function sameCalendarMonth(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date)) return false;
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth();
}

function resolveOrgId(req) {
  const header = req.headers && (req.headers['x-org-id'] || req.headers['X-Org-Id']);
  if (typeof header === 'string' && header.trim()) return header.trim();
  const body = req.body && typeof req.body === 'object' ? req.body.organizationId : null;
  if (typeof body === 'string' && body.trim()) return body.trim();
  return null;
}

function setHeaders(res, { used, limit, orgId }) {
  if (!res || typeof res.setHeader !== 'function') return;
  try {
    res.setHeader(HEADER_USED, String(used));
    res.setHeader(HEADER_LIMIT, String(limit));
    res.setHeader(HEADER_REMAINING, String(Math.max(0, Number(limit) - Number(used))));
    if (orgId) res.setHeader(HEADER_ORG, orgId);
  } catch (_) {
    // headers already sent — telemetry is best-effort
  }
}

/**
 * @param {object} [opts]
 * @param {object} [opts.prisma] — override prisma client (tests)
 * @param {number} [opts.cost=1] — units consumed per request
 */
function enforceOrgQuota(opts = {}) {
  const client = opts.prisma || prisma;
  const cost = Number.isFinite(opts.cost) && opts.cost > 0 ? Number(opts.cost) : 1;

  return async function enforceOrgQuotaMiddleware(req, res, next) {
    try {
      const user = req.user;
      if (!user || !user.id) return next();
      const orgId = resolveOrgId(req);
      if (!orgId) return next();

      // Verify membership.
      const membership = await client.orgMembership.findUnique({
        where: { orgId_userId: { orgId, userId: user.id } },
      });
      if (!membership) {
        return res.status(403).json({ error: 'not a member of organization' });
      }

      // Load org.
      const org = await client.organization.findUnique({ where: { id: orgId } });
      if (!org) return res.status(404).json({ error: 'organization not found' });

      // Reset counter if month rolled over.
      const now = new Date();
      const resetAt = org.quotaResetAt instanceof Date ? org.quotaResetAt : new Date(org.quotaResetAt);
      let used = Number(org.usedThisMonth || 0);
      const limit = Number(org.monthlyQuota || 0);
      if (!sameCalendarMonth(now, resetAt)) {
        used = 0;
        await client.organization.update({
          where: { id: orgId },
          data: { usedThisMonth: BigInt(0), quotaResetAt: now },
        });
      }

      setHeaders(res, { used, limit, orgId });

      const enforced = isEnforced();
      if (enforced && used + cost > limit) {
        return res.status(429).json({
          error: 'organization monthly quota exceeded',
          orgId,
          used,
          limit,
        });
      }

      // Optimistic reservation: increment first; expose refund() in
      // case the wrapped handler decides to bail out without consuming.
      await client.organization.update({
        where: { id: orgId },
        data: { usedThisMonth: { increment: BigInt(cost) } },
      });
      const newUsed = used + cost;
      setHeaders(res, { used: newUsed, limit, orgId });

      req.orgContext = {
        orgId,
        role: membership.role,
        cost,
        used: newUsed,
        limit,
        refund: async () => {
          try {
            await client.organization.update({
              where: { id: orgId },
              data: { usedThisMonth: { decrement: BigInt(cost) } },
            });
          } catch (e) {
            console.error('[org-quota] refund failed:', e.message);
          }
        },
      };

      return next();
    } catch (err) {
      console.error('[org-quota] middleware error:', err.message);
      // Fail-open: a broken middleware should not break the platform.
      return next();
    }
  };
}

module.exports = {
  enforceOrgQuota,
  resolveOrgId,
  sameCalendarMonth,
  HEADER_USED,
  HEADER_LIMIT,
  HEADER_REMAINING,
  HEADER_ORG,
};
