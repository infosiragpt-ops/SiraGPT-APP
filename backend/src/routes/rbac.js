'use strict';

/**
 * /api/rbac — F2 PR10 — Read-only introspection + admin role admin.
 *
 *   GET    /api/rbac/me/permissions                    me, current effective set
 *   GET    /api/admin/rbac/roles                       list catalog
 *   GET    /api/admin/rbac/users/:userId/roles         list user's assignments
 *   POST   /api/admin/rbac/users/:userId/roles         assign  { roleCode, scope, scopeId? }
 *   DELETE /api/admin/rbac/users/:userId/roles/:id     revoke
 *
 * Admin gating uses the new declarative `requirePermission('rbac.manage')`
 * middleware (in shadow mode — see require-permission.js). Every write
 * also invalidates the in-memory permission cache for the affected user
 * so the next request sees the new grants immediately.
 */

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { authenticateToken } = require('../middleware/auth');
const requirePermission = require('../middleware/require-permission');
const { getUserPermissions, invalidatePermissionsCache } = requirePermission;
const requireAdminRoutePermission = require('../services/admin-route-policy');
const prisma = require('../config/database');
const { writeAuditLogStrict } = require('../utils/audit-log');
const {
  bumpRbacPermissionVersion,
} = require('../services/rbac-permission-version');
const {
  acquireRbacMutationLock,
  isRbacSystemPrincipalId,
  isSystemManagedAssignment,
  upsertRoleAssignmentByNaturalTuple,
} = require('../services/rbac-system-assignments');
const {
  assertSuperadminRemains,
} = require('../services/rbac-superadmin-invariant');
const {
  ROLE_CODES,
  GLOBAL_ROLE_CODES,
  ORG_ROLE_CODES,
} = require('../services/rbac-catalog');

const meRouter = express.Router();

const AssignRoleSchema = z.object({
  roleCode: z.enum(ROLE_CODES),
  scope: z.enum(['GLOBAL', 'ORG']).default('GLOBAL'),
  scopeId: z.string().min(1).max(64).optional().nullable(),
}).superRefine(({ roleCode, scope }, ctx) => {
  const valid = scope === 'GLOBAL'
    ? GLOBAL_ROLE_CODES.includes(roleCode)
    : ORG_ROLE_CODES.includes(roleCode);
  if (!valid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['roleCode'],
      message: 'roleCode is not valid for the selected scope',
    });
  }
});

// ── /api/rbac/me/permissions ────────────────────────────────────────
meRouter.get('/me/permissions', authenticateToken, async (req, res, next) => {
  try {
    const perms = await getUserPermissions(req.user.id);
    res.json({
      userId: req.user.id,
      isSuperAdmin: !!req.user.isSuperAdmin,
      permissions: Array.from(perms).sort(),
    });
  } catch (err) {
    next(err);
  }
});

function createRbacControlPlaneMiddleware({
  requirePermissionImpl = requirePermission,
} = {}) {
  const requireGlobalManage = requirePermissionImpl('rbac.manage', {
    globalOnly: true,
    allowOrgApiKey: false,
    legacyPredicate: null,
  });
  return function requireRbacControlPlane(req, res, next) {
    if (req.authMethod === 'api_key' || req.apiKey) {
      return res.status(403).json({
        error: 'forbidden',
        code: 'rbac_session_required',
      });
    }
    if (!req.user?.isSuperAdmin) {
      return res.status(403).json({
        error: 'forbidden',
        code: 'rbac_superadmin_required',
      });
    }
    return requireGlobalManage(req, res, next);
  };
}

function roleWithinGrantCeiling(actorPermissions, role) {
  if (!(actorPermissions instanceof Set) || !role) return false;
  return (role.permissions || []).every((grant) => {
    const code = grant?.permission?.code;
    return Boolean(code && actorPermissions.has(code));
  });
}

async function readLockedControlPlaneActor(transactionClient, actorId) {
  if (typeof transactionClient?.user?.findUnique !== 'function'
      || typeof transactionClient?.userRole?.findMany !== 'function') {
    const error = new Error('RBAC_CONTROL_PLANE_TRANSACTION_REQUIRED');
    error.code = 'RBAC_CONTROL_PLANE_TRANSACTION_REQUIRED';
    throw error;
  }
  const actor = await transactionClient.user.findUnique({
    where: { id: actorId },
    select: {
      id: true,
      isSuperAdmin: true,
      deletedAt: true,
    },
  });
  if (!actor || actor.deletedAt != null) {
    return { denied: true, code: 'rbac_actor_inactive' };
  }
  if (!actor.isSuperAdmin) {
    return { denied: true, code: 'rbac_actor_superadmin_required' };
  }

  const assignments = await transactionClient.userRole.findMany({
    where: {
      userId: actorId,
      scope: 'GLOBAL',
      scopeId: null,
    },
    include: {
      role: {
        include: {
          permissions: { include: { permission: true } },
        },
      },
    },
  });
  const globalRoles = new Set();
  const permissions = new Set();
  for (const assignment of assignments || []) {
    const role = assignment?.role;
    if (!role) continue;
    if (role.code) globalRoles.add(role.code);
    for (const grant of role.permissions || []) {
      const permissionCode = grant?.permission?.code;
      if (permissionCode) permissions.add(permissionCode);
    }
  }
  if (!globalRoles.has('SUPERADMIN')) {
    return { denied: true, code: 'rbac_actor_superadmin_required' };
  }
  if (!permissions.has('rbac.manage')) {
    return { denied: true, code: 'rbac_actor_manage_required' };
  }
  return {
    denied: false,
    actor,
    globalRoles,
    permissions,
  };
}

function manualAssignmentId({ userId, roleId, scope, scopeId }) {
  const digest = crypto
    .createHash('sha256')
    .update(`${userId}\u0000${roleId}\u0000${scope}\u0000${scopeId || ''}`)
    .digest('hex')
    .slice(0, 24);
  return `rbac_grant_${digest}`;
}

async function auditAssignmentMutation(auditWriter, db, {
  action,
  actorId,
  targetUserId,
  roleCode,
  scope,
  scopeId,
  result,
}) {
  await auditWriter(db, {
    action,
    userId: actorId,
    actorType: 'user',
    resource: 'rbac_assignment',
    resourceId: targetUserId,
    metadata: {
      actorId,
      targetUserId,
      roleCode,
      scope,
      scopeId: scopeId || null,
      result,
    },
    tags: ['security', 'rbac', 'mutation'],
  });
}

function createAdminRbacRouter({
  prismaClient = prisma,
  authenticateMiddleware = authenticateToken,
  routePermissionMiddleware = null,
  controlPlaneMiddleware = createRbacControlPlaneMiddleware(),
  invalidatePermissionsCacheImpl = invalidatePermissionsCache,
  writeAuditLogImpl = writeAuditLogStrict,
  bumpPermissionVersionImpl = bumpRbacPermissionVersion,
} = {}) {
  const adminRouter = express.Router();
  adminRouter.use(authenticateMiddleware);
  if (routePermissionMiddleware) adminRouter.use(routePermissionMiddleware);
  adminRouter.use(controlPlaneMiddleware);
  adminRouter.use('/users/:userId', (req, res, next) => {
    if (!isRbacSystemPrincipalId(req.params.userId)) return next();
    if (req.method === 'GET' || req.method === 'HEAD') {
      return res.status(404).json({ error: 'assignment not found' });
    }
    return res.status(409).json({
      error: 'conflict',
      code: 'rbac_system_principal_protected',
    });
  });

  adminRouter.get(
    '/roles',
    async (_req, res, next) => {
      try {
        const roles = await prismaClient.role.findMany({
          orderBy: [{ isSystem: 'desc' }, { code: 'asc' }],
          include: {
            permissions: { include: { permission: true } },
          },
        });
        res.json({
          roles: roles.map((role) => ({
            id: role.id,
            code: role.code,
            name: role.name,
            description: role.description,
            isSystem: role.isSystem,
            permissions: role.permissions
              .map((rp) => rp.permission?.code)
              .filter(Boolean)
              .sort(),
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  adminRouter.get(
    '/users/:userId/roles',
    async (req, res, next) => {
      try {
        const assignments = await prismaClient.userRole.findMany({
          where: { userId: req.params.userId },
          orderBy: { assignedAt: 'desc' },
          include: { role: true },
        });
        res.json({
          assignments: assignments.map((assignment) => (
            serializeUserRole(assignment, assignment.role)
          )),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  adminRouter.post(
    '/users/:userId/roles',
    async (req, res, next) => {
      try {
        const parse = AssignRoleSchema.safeParse(req.body);
        if (!parse.success) {
          return res.status(400).json({ error: 'invalid payload', issues: parse.error.issues });
        }
        const { roleCode, scope, scopeId } = parse.data;
        if (scope === 'ORG' && !scopeId) {
          return res.status(400).json({ error: 'scopeId required for ORG-scoped assignment' });
        }
        const normalizedScopeId = scope === 'ORG' ? scopeId : null;

        const result = await prismaClient.$transaction(async (tx) => {
          await acquireRbacMutationLock(tx);
          const actorAuthorization = await readLockedControlPlaneActor(
            tx,
            req.user.id,
          );
          if (actorAuthorization.denied) {
            return { actorDenied: actorAuthorization.code };
          }
          const target = await tx.user.findUnique({
            where: { id: req.params.userId },
            select: { id: true, deletedAt: true },
          });
          if (!target || target.deletedAt != null) {
            const removed = await tx.userRole.deleteMany({
              where: { userId: req.params.userId },
            });
            await auditAssignmentMutation(writeAuditLogImpl, tx, {
              action: 'rbac_assignment_grant',
              actorId: req.user.id,
              targetUserId: req.params.userId,
              roleCode,
              scope,
              scopeId: normalizedScopeId,
              result: 'denied_inactive',
            });
            await bumpPermissionVersionImpl(tx);
            return {
              inactive: true,
              cleaned: removed.count || 0,
            };
          }
          const role = await tx.role.findUnique({
            where: { code: roleCode },
            include: { permissions: { include: { permission: true } } },
          });
          if (!role) return { roleMissing: true };
          if (!roleWithinGrantCeiling(actorAuthorization.permissions, role)) {
            return { ceilingDenied: true };
          }
          const where = {
            userId: req.params.userId,
            roleId: role.id,
            scope,
            scopeId: normalizedScopeId,
          };
          const naturalUpsert = await upsertRoleAssignmentByNaturalTuple(
            tx,
            {
              id: manualAssignmentId(where),
              ...where,
            },
            {
              assignedBy: req.user.id,
              adoptExistingProvenance: false,
              lockAlreadyHeld: true,
            },
          );
          const assignment = naturalUpsert.assignment;
          const mutationResult = naturalUpsert.created ? 'created' : 'existing';
          await auditAssignmentMutation(writeAuditLogImpl, tx, {
            action: 'rbac_assignment_grant',
            actorId: req.user.id,
            targetUserId: req.params.userId,
            roleCode: role.code,
            scope,
            scopeId: normalizedScopeId,
            result: mutationResult,
          });
          await bumpPermissionVersionImpl(tx);
          return {
            assignment,
            role,
            replay: !naturalUpsert.created,
            mutationResult,
          };
        });

        if (result.actorDenied) {
          return res.status(403).json({
            error: 'forbidden',
            code: result.actorDenied,
          });
        }
        if (result.inactive) {
          if (result.cleaned > 0) {
            await invalidatePermissionsCacheImpl(req.params.userId);
          }
          return res.status(409).json({
            error: 'conflict',
            code: 'rbac_assignment_target_inactive',
          });
        }
        if (result.roleMissing) return res.status(404).json({ error: 'role not found' });
        if (result.ceilingDenied) {
          return res.status(403).json({
            error: 'forbidden',
            code: 'rbac_grant_ceiling',
          });
        }
        await invalidatePermissionsCacheImpl(req.params.userId);
        return res.status(result.replay ? 200 : 201).json({
          assignment: serializeUserRole(result.assignment, result.role),
          replay: result.replay,
        });
      } catch (err) {
        return next(err);
      }
    },
  );

  adminRouter.delete(
    '/users/:userId/roles/:assignmentId',
    async (req, res, next) => {
      try {
        const result = await prismaClient.$transaction(async (tx) => {
          await acquireRbacMutationLock(tx);
          const actorAuthorization = await readLockedControlPlaneActor(
            tx,
            req.user.id,
          );
          if (actorAuthorization.denied) {
            return { actorDenied: actorAuthorization.code };
          }
          const target = await tx.user.findUnique({
            where: { id: req.params.userId },
            select: { id: true, deletedAt: true },
          });
          if (!target || target.deletedAt != null) {
            const removed = await tx.userRole.deleteMany({
              where: { userId: req.params.userId },
            });
            await auditAssignmentMutation(writeAuditLogImpl, tx, {
              action: 'rbac_assignment_revoke',
              actorId: req.user.id,
              targetUserId: req.params.userId,
              roleCode: null,
              scope: 'ALL',
              scopeId: null,
              result: 'denied_inactive',
            });
            await bumpPermissionVersionImpl(tx);
            return {
              inactive: true,
              cleaned: removed.count || 0,
            };
          }
          const lockedRow = await tx.userRole.findUnique({
            where: { id: req.params.assignmentId },
            include: { role: true },
          });
          if (!lockedRow || lockedRow.userId !== req.params.userId) return null;
          if (isSystemManagedAssignment(lockedRow)) {
            return { protected: true };
          }
          if (!roleWithinGrantCeiling(actorAuthorization.permissions, lockedRow.role)) {
            return { ceilingDenied: true };
          }
          if (lockedRow.scope === 'GLOBAL'
              && lockedRow.scopeId == null
              && lockedRow.role?.code === 'SUPERADMIN') {
            await assertSuperadminRemains(tx, {
              excludeAssignmentId: lockedRow.id,
              lockAlreadyHeld: true,
            });
          }
          const deleted = await tx.userRole.deleteMany({
            where: {
              id: lockedRow.id,
              userId: req.params.userId,
            },
          });
          if (!deleted.count) return null;
          await auditAssignmentMutation(writeAuditLogImpl, tx, {
            action: 'rbac_assignment_revoke',
            actorId: req.user.id,
            targetUserId: req.params.userId,
            roleCode: lockedRow.role?.code || null,
            scope: lockedRow.scope,
            scopeId: lockedRow.scopeId,
            result: 'deleted',
          });
          await bumpPermissionVersionImpl(tx);
          return { row: lockedRow };
        });
        if (result?.actorDenied) {
          return res.status(403).json({
            error: 'forbidden',
            code: result.actorDenied,
          });
        }
        if (!result) return res.status(404).json({ error: 'assignment not found' });
        if (result.inactive) {
          if (result.cleaned > 0) {
            await invalidatePermissionsCacheImpl(req.params.userId);
          }
          return res.status(409).json({
            error: 'conflict',
            code: 'rbac_assignment_target_inactive',
          });
        }
        if (result.protected) {
          return res.status(409).json({
            error: 'conflict',
            code: 'rbac_system_assignment_protected',
          });
        }
        if (result.ceilingDenied) {
          return res.status(403).json({
            error: 'forbidden',
            code: 'rbac_grant_ceiling',
          });
        }
        await invalidatePermissionsCacheImpl(req.params.userId);
        return res.json({ ok: true });
      } catch (err) {
        if (err?.code === 'RBAC_LAST_SUPERADMIN') {
          return res.status(409).json({
            error: 'conflict',
            code: 'rbac_last_superadmin',
          });
        }
        return next(err);
      }
    },
  );

  return adminRouter;
}

function serializeUserRole(assignment, role) {
  return {
    id: assignment.id,
    userId: assignment.userId,
    roleCode: role?.code || null,
    roleName: role?.name || null,
    scope: assignment.scope,
    scopeId: assignment.scopeId,
    assignedBy: assignment.assignedBy,
    assignedAt: assignment.assignedAt,
  };
}

const adminRouter = createAdminRbacRouter({
  routePermissionMiddleware: requireAdminRoutePermission,
});

module.exports = meRouter;
module.exports.adminRouter = adminRouter;
module.exports.AssignRoleSchema = AssignRoleSchema;
module.exports.serializeUserRole = serializeUserRole;
module.exports.createRbacControlPlaneMiddleware = createRbacControlPlaneMiddleware;
module.exports.roleWithinGrantCeiling = roleWithinGrantCeiling;
module.exports.readLockedControlPlaneActor = readLockedControlPlaneActor;
module.exports.createAdminRbacRouter = createAdminRbacRouter;
module.exports.isSystemManagedAssignment = isSystemManagedAssignment;
