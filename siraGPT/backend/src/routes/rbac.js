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
const { z } = require('zod');
const { authenticateToken } = require('../middleware/auth');
const requirePermission = require('../middleware/require-permission');
const { getUserPermissions, invalidatePermissionsCache } = requirePermission;
const prisma = require('../config/database');

const meRouter = express.Router();
const adminRouter = express.Router();

const AssignRoleSchema = z.object({
  roleCode: z.enum(['SUPERADMIN', 'ORG_OWNER', 'ORG_ADMIN', 'ORG_MEMBER', 'ORG_VIEWER', 'USER']),
  scope: z.enum(['GLOBAL', 'ORG']).default('GLOBAL'),
  scopeId: z.string().min(1).max(64).optional().nullable(),
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

// ── /api/admin/rbac/* ───────────────────────────────────────────────
adminRouter.get(
  '/roles',
  authenticateToken,
  requirePermission('rbac.manage'),
  async (req, res, next) => {
    try {
      const roles = await prisma.role.findMany({
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
  authenticateToken,
  requirePermission('rbac.manage'),
  async (req, res, next) => {
    try {
      const assignments = await prisma.userRole.findMany({
        where: { userId: req.params.userId },
        orderBy: { assignedAt: 'desc' },
        include: { role: true },
      });
      res.json({
        assignments: assignments.map((ur) => ({
          id: ur.id,
          roleCode: ur.role?.code,
          roleName: ur.role?.name,
          scope: ur.scope,
          scopeId: ur.scopeId,
          assignedBy: ur.assignedBy,
          assignedAt: ur.assignedAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.post(
  '/users/:userId/roles',
  authenticateToken,
  requirePermission('rbac.manage'),
  async (req, res, next) => {
    try {
      const parse = AssignRoleSchema.safeParse(req.body);
      if (!parse.success) {
        return res.status(400).json({ error: 'invalid payload', issues: parse.error.issues });
      }
      const { roleCode, scope, scopeId } = parse.data;
      // ORG-scope assignments require a scopeId; GLOBAL must not have one.
      if (scope === 'ORG' && !scopeId) {
        return res.status(400).json({ error: 'scopeId required for ORG-scoped assignment' });
      }
      const role = await prisma.role.findUnique({ where: { code: roleCode } });
      if (!role) return res.status(404).json({ error: 'role not found' });

      // Avoid duplicates — same (user, role, scope, scopeId) is a no-op.
      const existing = await prisma.userRole.findFirst({
        where: {
          userId: req.params.userId,
          roleId: role.id,
          scope,
          scopeId: scope === 'ORG' ? scopeId : null,
        },
      });
      if (existing) {
        return res.status(200).json({ assignment: serializeUserRole(existing, role), replay: true });
      }

      const assignment = await prisma.userRole.create({
        data: {
          userId: req.params.userId,
          roleId: role.id,
          scope,
          scopeId: scope === 'ORG' ? scopeId : null,
          assignedBy: req.user.id,
        },
      });
      invalidatePermissionsCache(req.params.userId);
      res.status(201).json({ assignment: serializeUserRole(assignment, role) });
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.delete(
  '/users/:userId/roles/:assignmentId',
  authenticateToken,
  requirePermission('rbac.manage'),
  async (req, res, next) => {
    try {
      const row = await prisma.userRole.findUnique({
        where: { id: req.params.assignmentId },
      });
      if (!row || row.userId !== req.params.userId) {
        return res.status(404).json({ error: 'assignment not found' });
      }
      await prisma.userRole.delete({ where: { id: row.id } });
      invalidatePermissionsCache(req.params.userId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

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

module.exports = meRouter;
module.exports.adminRouter = adminRouter;
module.exports.AssignRoleSchema = AssignRoleSchema;
module.exports.serializeUserRole = serializeUserRole;
