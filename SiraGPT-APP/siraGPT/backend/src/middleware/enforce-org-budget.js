'use strict';

/**
 * enforce-org-budget — hard-block requests to /api/ai/generate when an
 * organization has crossed its month-to-date spend cap AND has opted
 * into hard enforcement via `Organization.settings.budget.enforceLimit`.
 *
 * Cycle 95 introduced budget alerts (warn / error severity) but those
 * are advisory — they fire telemetry without affecting the request. This
 * middleware adds the opt-in second tier: when an org owner toggles
 * `settings.budget.enforceLimit = true`, the same MTD figure that drives
 * the alert is used to refuse new requests with HTTP 402 Payment
 * Required until either the org bumps `monthlyCapUSD` or the calendar
 * month rolls over.
 *
 * Settings shape (read from Organization.settings):
 *   {
 *     budget: {
 *       monthlyCapUSD:   number,    // required for enforcement
 *       enforceLimit:    boolean,   // default false (warn-only)
 *       warnThresholdPct: number    // unused here, see cost-alert.js
 *     }
 *   }
 *
 * Wiring:
 *   - Mounted after `enforceOrgQuotaSafe` (so `req.orgContext.orgId` is
 *     already resolved when present).
 *   - When no org context exists OR settings.budget.enforceLimit !== true
 *     the middleware is a no-op.
 *   - MTD is computed from cost-tracker's in-memory record snapshot,
 *     filtered to the org's member ids (same logic as
 *     services/ai/cost-alert.js#checkOrgBudget).
 *
 * Failure posture: fail-open. If the membership lookup, settings parse,
 * or cost snapshot throws we proceed to `next()` rather than block a
 * legitimate request on telemetry plumbing.
 */

const prisma = require('../config/database');

const HEADER_USED = 'X-Org-Budget-Used';
const HEADER_CAP = 'X-Org-Budget-Cap';
const HEADER_ENFORCED = 'X-Org-Budget-Enforced';

function _round6(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Extract a normalised budget config from raw `Organization.settings`.
 * Returns null when the org has no usable cap configured OR has not
 * opted into hard enforcement (`enforceLimit !== true`).
 */
function readEnforcedBudget(settings) {
  if (!settings || typeof settings !== 'object') return null;
  const budget = settings.budget;
  if (!budget || typeof budget !== 'object') return null;
  if (budget.enforceLimit !== true) return null;
  const cap = Number(budget.monthlyCapUSD);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  return { monthlyCapUSD: _round6(cap), enforceLimit: true };
}

/**
 * Sum month-to-date USD spend across a set of member ids from an
 * in-memory cost-tracker record snapshot. Month is computed in UTC.
 */
function sumMonthToDate(records, memberSet, nowMs = Date.now()) {
  if (!Array.isArray(records) || records.length === 0) return 0;
  const now = new Date(nowMs);
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  let total = 0;
  for (const r of records) {
    if (!r) continue;
    if (!memberSet.has(String(r.userId))) continue;
    const t = new Date(r.ts).getTime();
    if (!Number.isFinite(t) || t < monthStart) continue;
    const cost = Number(r.costUSD) || 0;
    if (cost > 0) total += cost;
  }
  return _round6(total);
}

/**
 * @param {object} [opts]
 * @param {object} [opts.prisma]      override prisma client (tests)
 * @param {Function} [opts.getRecords] override cost-tracker snapshot (tests)
 * @param {Function} [opts.now]        injected clock (tests)
 */
function enforceOrgBudget(opts = {}) {
  const client = opts.prisma || prisma;
  const getRecords = typeof opts.getRecords === 'function'
    ? opts.getRecords
    : (() => {
      try {
        // eslint-disable-next-line global-require
        const tracker = require('../services/ai/cost-tracker');
        return typeof tracker._peekRecords === 'function' ? tracker._peekRecords() : [];
      } catch (_e) {
        return [];
      }
    });
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();

  return async function enforceOrgBudgetMiddleware(req, res, next) {
    try {
      const orgId = (req.orgContext && req.orgContext.orgId)
        || (req.headers && (req.headers['x-org-id'] || req.headers['X-Org-Id']))
        || (req.body && typeof req.body === 'object' ? req.body.organizationId : null);
      if (!orgId) return next();

      const org = await client.organization.findUnique({ where: { id: orgId } });
      if (!org) return next();

      const enforced = readEnforcedBudget(org.settings);
      if (!enforced) return next();

      const memberRows = await client.orgMembership.findMany({
        where: { orgId },
        select: { userId: true },
      });
      const memberSet = new Set(memberRows.map((m) => String(m.userId)));
      if (memberSet.size === 0) return next();

      const usedThisMonthUSD = sumMonthToDate(getRecords(), memberSet, nowFn());

      try {
        res.setHeader(HEADER_USED, String(usedThisMonthUSD));
        res.setHeader(HEADER_CAP, String(enforced.monthlyCapUSD));
        res.setHeader(HEADER_ENFORCED, 'true');
      } catch (_e) { /* headers already sent — telemetry is best-effort */ }

      if (usedThisMonthUSD >= enforced.monthlyCapUSD) {
        // Refund the optimistic +1 reserved by enforceOrgQuota so a
        // blocked request does not silently burn the request budget.
        if (req.orgContext && typeof req.orgContext.refund === 'function') {
          try { await req.orgContext.refund(); } catch (_e) { /* swallow */ }
        }
        return res.status(402).json({
          error: 'organization_budget_exhausted',
          message: 'Organization has reached its enforced monthly spend cap.',
          orgId,
          usedThisMonthUSD,
          monthlyCapUSD: enforced.monthlyCapUSD,
        });
      }

      return next();
    } catch (err) {
      try { console.warn('[org-budget] middleware error:', err && err.message); } catch (_e) { /* swallow */ }
      // Fail-open: budget telemetry must never break the platform.
      return next();
    }
  };
}

module.exports = {
  enforceOrgBudget,
  readEnforcedBudget,
  sumMonthToDate,
  HEADER_USED,
  HEADER_CAP,
  HEADER_ENFORCED,
};
