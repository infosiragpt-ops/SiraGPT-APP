'use strict';

/**
 * F2 PR9 — requirePermission middleware (shadow mode).
 *
 * Gates an Express route on a declarative permission code from the
 * F1 RBAC catalog. Reads `user_roles ⋈ role_permissions ⋈ permissions`
 * for the authenticated user, with a small in-memory cache (TTL 60s
 * by default) so the hot path stays cheap.
 *
 * `RBAC_ENFORCEMENT_MODE=shadow|enforce` controls legacy compatibility.
 * Production defaults to enforce; other environments default to shadow.
 * In shadow mode callers can provide the legacy predicate whose decision is
 * observed and logged while declarative assignments are being backfilled.
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
const {
  MODES,
  resolveRbacEnforcementMode,
} = require('../services/rbac-enforcement-mode');
const {
  createRbacPermissionCache,
} = require('../services/rbac-permission-cache');
const {
  readRbacPermissionVersion,
} = require('../services/rbac-permission-version');

const permissionCache = createRbacPermissionCache({
  env: process.env,
  readVersion: () => (
    resolveRbacEnforcementMode(process.env) === MODES.ENFORCE
      ? readRbacPermissionVersion(prisma)
      : '0'
  ),
});
const cache = permissionCache._entriesForTests;

function enforcementMode() {
  return resolveRbacEnforcementMode(process.env);
}

function shadowEnabled() {
  return enforcementMode() === MODES.SHADOW;
}

async function loadUserPermissions(userId, options = {}) {
  const { globalOnly = false, scopeId = null } = options;
  // Pull every active role assignment for the user (GLOBAL + ORG) and
  // collect the union of their permission codes. Inactive / soft-deleted
  // roles are excluded by the schema's CASCADE behaviour on user_roles.
  const where = { userId };
  if (globalOnly) {
    where.scope = 'GLOBAL';
    where.scopeId = null;
  } else if (scopeId) {
    where.OR = [
      { scope: 'GLOBAL', scopeId: null },
      { scope: 'ORG', scopeId },
    ];
  }
  const assignments = await prisma.userRole.findMany({
    where,
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

function permissionCacheKey(userId, options = {}) {
  if (options.globalOnly) return `${userId}\u0000GLOBAL`;
  if (options.scopeId) return `${userId}\u0000ORG:${options.scopeId}`;
  return userId;
}

async function getUserPermissions(userId, options = {}) {
  if (!userId) return new Set();
  const key = permissionCacheKey(userId, options);
  return permissionCache.get(key, () => loadUserPermissions(userId, options));
}

function invalidatePermissionsCache(userId) {
  return permissionCache.invalidate(userId || null);
}

function initializePermissionsCache() {
  return permissionCache.init();
}

function closePermissionsCache() {
  return permissionCache.close();
}

function apiKeyHasPermissionScope(scopes, permissionCode) {
  if (!Array.isArray(scopes) || !permissionCode) return false;
  if (scopes.includes('*') || scopes.includes(permissionCode)) return true;
  const dot = permissionCode.indexOf('.');
  if (dot > 0 && scopes.includes(`${permissionCode.slice(0, dot)}.*`)) return true;
  return false;
}

function logShadowDiff({
  userId,
  permissionCode,
  isSuperAdmin,
  hasPermission,
  legacyAllowed,
  permissionLookupError = false,
  req,
}) {
  const payload = {
    kind: 'rbac.shadow.diff',
    userId,
    permissionCode,
    isSuperAdmin,
    hasPermission,
    legacyAllowed,
    direction: permissionLookupError
      ? (
        legacyAllowed
          ? 'legacy_allow_rbac_error'
          : 'legacy_deny_rbac_error'
      )
      : (
        legacyAllowed
          ? 'legacy_allow_rbac_deny'
          : 'legacy_deny_rbac_allow'
      ),
    ...(permissionLookupError
      ? { errorCode: 'RBAC_PERMISSION_LOOKUP_FAILED' }
      : {}),
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
 * @param {(user: object, req: object) => boolean} [options.legacyPredicate]
 * @param {boolean} [options.allowOrgApiKey=true]
 * @returns {import('express').RequestHandler}
 */
function requirePermission(permissionCode, options = {}) {
  if (!permissionCode) {
    throw new Error('requirePermission: permissionCode is required');
  }
  const {
    requireUser = true,
    legacyPredicate = null,
    allowOrgApiKey = true,
    globalOnly = false,
  } = options;
  return async function requirePermissionMiddleware(req, res, next) {
    try {
      if (requireUser && (!req.user || !req.user.id)) {
        return res.status(401).json({ error: 'auth required' });
      }
      const code =
        typeof permissionCode === 'function'
          ? permissionCode(req)
          : permissionCode;
      if (
        req.authMethod === 'api_key'
        && req.apiKey?.organizationId
        && !allowOrgApiKey
      ) {
        return res.status(403).json({
          error: 'forbidden',
          code: 'api_key_role_boundary',
          missingPermission: code,
        });
      }
      const isSuperAdmin = !!req.user.isSuperAdmin;
      const hasLegacyGate = typeof legacyPredicate === 'function';
      const legacyAllowed = hasLegacyGate
        ? Boolean(legacyPredicate(req.user, req))
        : null;
      const mode = enforcementMode();
      const legacyShadowDecision = mode === MODES.SHADOW && hasLegacyGate;
      let hasPermission;
      let permissionLookupError = false;
      try {
        const perms = await getUserPermissions(req.user.id, { globalOnly });
        hasPermission = perms.has(code);
      } catch (error) {
        if (!legacyShadowDecision) throw error;
        hasPermission = null;
        permissionLookupError = true;
      }
      const roleAllowed = legacyShadowDecision ? legacyAllowed : hasPermission;
      const apiKeyScopeAllowed = req.authMethod !== 'api_key'
        || apiKeyHasPermissionScope(req.apiKey?.scopes, code);
      const allowed = roleAllowed && apiKeyScopeAllowed;

      // Replacement gates are observe-only in shadow mode: the legacy
      // predicate remains authoritative while we record discrepancies in
      // either direction. Generic RBAC-only routes never enter this branch.
      if (
        legacyShadowDecision
        && (permissionLookupError || legacyAllowed !== hasPermission)
      ) {
        logShadowDiff({
          userId: req.user.id,
          permissionCode: code,
          isSuperAdmin,
          hasPermission,
          legacyAllowed,
          permissionLookupError,
          req,
        });
      }

      if (!allowed) {
        if (!apiKeyScopeAllowed) {
          return res.status(403).json({
            error: 'forbidden',
            code: 'insufficient_api_key_scope',
            missingPermission: code,
          });
        }
        return res
          .status(403)
          .json({ error: 'forbidden', missingPermission: code });
      }
      // Stash the resolved permission for downstream handlers.
      req._rbacAllowed = {
        code,
        hasPermission,
        isSuperAdmin,
        legacyAllowed,
        decisionSource: permissionLookupError
          ? 'legacy_shadow_error'
          : (legacyShadowDecision ? 'legacy_shadow' : 'rbac'),
      };
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
module.exports.initializePermissionsCache = initializePermissionsCache;
module.exports.closePermissionsCache = closePermissionsCache;
module.exports.permissionsCacheStatus = () => permissionCache.status();
module.exports.apiKeyHasPermissionScope = apiKeyHasPermissionScope;
module.exports.enforcementMode = enforcementMode;
module.exports.shadowEnabled = shadowEnabled;
module.exports._cacheForTests = cache;
