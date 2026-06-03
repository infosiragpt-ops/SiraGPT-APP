'use strict';

/**
 * F2 PR9 — requirePermission middleware (shadow mode).
 *
 * Gates an Express route on a declarative permission code from the
 * F1 RBAC catalog. Reads `user_roles ⋈ role_permissions ⋈ permissions`
 * for the authenticated user, with a small in-memory cache (TTL 60s
 * by default) so the hot path stays cheap.
 *
 * Shadow mode (default until F5): when RBAC_SHADOW_MODE !== 'false',
 * the legacy `req.user.isSuperAdmin` flag is accepted EVEN IF the
 * declarative permission check would reject. The discrepancy is logged
 * as `kind: 'rbac.shadow.diff'` so we can confirm zero diffs before
 * the F5 PR23 hard cutover.
 *
 *   router.delete('/users/:id',
 *     authenticateToken,
 *     requirePermission('users.delete'),
 *     handler);
 *
 * On cache invalidation (role assignment / revocation), call
 * `invalidatePermissionsCache(userId)`. F3 PR14's admin RBAC routes
 * will wire this in.
 */

const prisma = require('../config/database');

const DEV_ADMIN_EMAIL = 'carrerajorge874@gmail.com';
function isDevAdmin(user) {
  return process.env.NODE_ENV === 'development' && user && user.email === DEV_ADMIN_EMAIL;
}

const DEFAULT_TTL_MS = Number(process.env.RBAC_CACHE_TTL_MS || 60_000);
const cache = new Map(); // userId -> { perms: Set<string>, expiresAt: number }

function shadowEnabled() {
  // Default: shadow ON; flip to 'false' at sunset (F5 PR23).
  return process.env.RBAC_SHADOW_MODE !== 'false';
}

function now() {
  return Date.now();
}

async function loadUserPermissions(userId) {
  // Pull every active role assignment for the user (GLOBAL + ORG) and
  // collect the union of their permission codes. Inactive / soft-deleted
  // roles are excluded by the schema's CASCADE behaviour on user_roles.
  const assignments = await prisma.userRole.findMany({
    where: { userId },
    include: {
      role: {
        include: {
          permissions: { include: { permission: true } },
        },
      },
    },
  });
  const perms = new Set();
  for (const ur of assignments) {
    if (!ur.role) continue;
    for (const rp of ur.role.permissions || []) {
      if (rp.permission?.code) perms.add(rp.permission.code);
    }
  }
  return perms;
}

async function getUserPermissions(userId) {
  if (!userId) return new Set();
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > now()) return cached.perms;
  const perms = await loadUserPermissions(userId);
  cache.set(userId, { perms, expiresAt: now() + DEFAULT_TTL_MS });
  return perms;
}

function invalidatePermissionsCache(userId) {
  if (!userId) {
    cache.clear();
    return;
  }
  cache.delete(userId);
}

function logShadowDiff({ userId, permissionCode, isSuperAdmin, hasPermission, req }) {
  const payload = {
    kind: 'rbac.shadow.diff',
    userId,
    permissionCode,
    isSuperAdmin,
    hasPermission,
    route: req?.originalUrl,
    method: req?.method,
    ts: new Date().toISOString(),
  };
  try {
    // Prefer structured logger if attached by middleware chain.
    if (req?.log?.warn) return req.log.warn(payload, 'rbac.shadow.diff');
  } catch (_) { /* fall through */ }
  // Fallback: stdout JSON line for ops grep / metrics ingestion.
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify(payload));
}

/**
 * Express middleware factory.
 *
 * @param {string|((req)=>string)} permissionCode
 * @param {object} [options]
 * @param {boolean} [options.requireUser=true]  Reject if no req.user.
 * @returns {import('express').RequestHandler}
 */
function requirePermission(permissionCode, options = {}) {
  if (!permissionCode) {
    throw new Error('requirePermission: permissionCode is required');
  }
  const { requireUser = true } = options;
  return async function requirePermissionMiddleware(req, res, next) {
    try {
      if (requireUser && (!req.user || !req.user.id)) {
        return res.status(401).json({ error: 'auth required' });
      }
      if (isDevAdmin(req.user)) {
        req.user.isSuperAdmin = true;
        return next();
      }
      const code =
        typeof permissionCode === 'function'
          ? permissionCode(req)
          : permissionCode;
      const perms = await getUserPermissions(req.user.id);
      const hasPermission = perms.has(code);
      const isSuperAdmin = !!req.user.isSuperAdmin;
      const allowed = hasPermission || (shadowEnabled() && isSuperAdmin);

      // Always log the diff in shadow mode if isSuperAdmin gates open
      // while the declarative check would have closed — those are the
      // assignments we still need to backfill in F2 PR4 + F5 PR23.
      if (shadowEnabled() && isSuperAdmin && !hasPermission) {
        logShadowDiff({
          userId: req.user.id,
          permissionCode: code,
          isSuperAdmin,
          hasPermission,
          req,
        });
      }

      if (!allowed) {
        return res
          .status(403)
          .json({ error: 'forbidden', missingPermission: code });
      }
      // Stash the resolved permission for downstream handlers.
      req._rbacAllowed = { code, hasPermission, isSuperAdmin };
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = requirePermission;
module.exports.requirePermission = requirePermission;
module.exports.getUserPermissions = getUserPermissions;
module.exports.loadUserPermissions = loadUserPermissions;
module.exports.invalidatePermissionsCache = invalidatePermissionsCache;
module.exports.shadowEnabled = shadowEnabled;
module.exports._cacheForTests = cache;
