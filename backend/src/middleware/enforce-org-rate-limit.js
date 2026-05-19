'use strict';

/**
 * enforce-org-rate-limit — per-organization request-rate limiter.
 *
 * Why a separate middleware (vs. enforce-org-quota)?
 *   - quota = monthly billable usage budget
 *   - rate-limit = per-second burst protection
 * These are independent concerns: a FREE org may still legitimately
 * consume its full month in one minute, but it should not be able to
 * fire 10k requests/sec and starve the worker pool.
 *
 * Plan → requests-per-second mapping:
 *   FREE                1  rps
 *   PRO / PRO_MAX      10  rps
 *   ENTERPRISE        100  rps
 *
 * Override via env: ORG_RPS_FREE / ORG_RPS_PRO / ORG_RPS_ENT.
 *
 * Counter backend:
 *   `rate-limit-store.consume()` already provides a sliding-window
 *   atomic counter (Redis when configured, in-memory fallback when not).
 *   We use a 1-second window so the limit is plain "requests per
 *   second". Key namespace: `org-rps:<orgId>` — distinct from the
 *   monthly quota counters, distinct from user-level limiters.
 *
 * On limit hit:
 *   - HTTP 429
 *   - Retry-After: <seconds> (computed from resetAt)
 *   - JSON body { error, orgId, plan, limitRps, retryAfterMs }
 *
 * The middleware is fail-open: a broken store / misconfigured Redis
 * should never break the API. Errors are logged once per process and
 * the request is allowed through (matching the rest of the stack).
 *
 * The org context is resolved from `req.orgContext.orgId` (when
 * enforce-org-quota ran before us) OR from header / body (mirrors
 * enforce-org-quota's resolveOrgId). When no org context is present
 * the middleware is a no-op — caller is acting personally.
 */

const prisma = require('../config/database');
const rateLimitStore = require('./rate-limit-store');

const HEADER_RPS_LIMIT = 'X-Org-Rps-Limit';
const HEADER_RPS_REMAINING = 'X-Org-Rps-Remaining';
const HEADER_RPS_PLAN = 'X-Org-Rps-Plan';

const WINDOW_MS = 1000;

function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function rpsFor(plan) {
  const RPS_FREE = envInt('ORG_RPS_FREE', 1);
  const RPS_PRO = envInt('ORG_RPS_PRO', 10);
  const RPS_ENT = envInt('ORG_RPS_ENT', 100);
  switch (String(plan || '').toUpperCase()) {
    case 'ENTERPRISE':
    case 'ENT':
      return RPS_ENT;
    case 'PRO':
    case 'PRO_MAX':
      return RPS_PRO;
    case 'FREE':
    default:
      return RPS_FREE;
  }
}

function resolveOrgId(req) {
  if (req && req.orgContext && req.orgContext.orgId) return req.orgContext.orgId;
  const h = req && req.headers && (req.headers['x-org-id'] || req.headers['X-Org-Id']);
  if (typeof h === 'string' && h.trim()) return h.trim();
  const b = req && req.body && typeof req.body === 'object' ? req.body.organizationId : null;
  if (typeof b === 'string' && b.trim()) return b.trim();
  return null;
}

let _resolveFailureLogged = false;
function logOnce(msg, err) {
  if (_resolveFailureLogged) return;
  _resolveFailureLogged = true;
  const detail = err && err.message ? ` (${err.message})` : '';
  // eslint-disable-next-line no-console
  console.warn(`[org-rate-limit] ${msg}${detail}`);
}

/**
 * @param {object} [opts]
 * @param {object} [opts.prisma]       — override prisma client (tests)
 * @param {object} [opts.store]        — override rate-limit-store (tests)
 * @param {number} [opts.windowMs]     — override window length (tests)
 * @param {Function} [opts.now]        — clock injection (tests)
 */
function enforceOrgRateLimit(opts = {}) {
  const client = opts.prisma || prisma;
  const store = opts.store || rateLimitStore;
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0
    ? Number(opts.windowMs)
    : WINDOW_MS;

  return async function enforceOrgRateLimitMiddleware(req, res, next) {
    let orgId;
    try {
      orgId = resolveOrgId(req);
    } catch (_e) {
      orgId = null;
    }
    if (!orgId) return next();

    let plan = 'FREE';
    try {
      // Prefer plan from orgContext if upstream middleware loaded it,
      // to avoid a redundant DB hit per request.
      if (req.orgContext && req.orgContext.plan) {
        plan = req.orgContext.plan;
      } else {
        const org = await client.organization.findUnique({
          where: { id: orgId },
          select: { billingPlan: true },
        });
        if (org && org.billingPlan) plan = org.billingPlan;
      }
    } catch (err) {
      logOnce('plan lookup failed (fail-open)', err);
      return next();
    }

    const limit = rpsFor(plan);
    try { res.setHeader(HEADER_RPS_PLAN, String(plan)); } catch (_e) { /* swallow */ }
    try { res.setHeader(HEADER_RPS_LIMIT, String(limit)); } catch (_e) { /* swallow */ }

    let result;
    try {
      result = await store.consume(`org-rps:${orgId}`, limit, windowMs);
    } catch (err) {
      logOnce('rate-limit store failed (fail-open)', err);
      return next();
    }

    try {
      res.setHeader(HEADER_RPS_REMAINING, String(Math.max(0, Number(result.remaining || 0))));
    } catch (_e) { /* swallow */ }

    if (result && result.allowed === false) {
      const resetAt = result.resetAt instanceof Date ? result.resetAt.getTime() : Date.now() + windowMs;
      const retryAfterMs = Math.max(0, resetAt - Date.now());
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      try { res.setHeader('Retry-After', String(retryAfterSec)); } catch (_e) { /* swallow */ }
      return res.status(429).json({
        error: 'organization rate limit exceeded',
        orgId,
        plan,
        limitRps: limit,
        retryAfterMs,
      });
    }

    return next();
  };
}

module.exports = {
  enforceOrgRateLimit,
  rpsFor,
  resolveOrgId,
  HEADER_RPS_LIMIT,
  HEADER_RPS_REMAINING,
  HEADER_RPS_PLAN,
};
