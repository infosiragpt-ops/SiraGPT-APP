'use strict';

const crypto = require('node:crypto');
const prisma = require('../config/database');
const { writeAuditLogStrict } = require('../utils/audit-log');
const requirePermission = require('../middleware/require-permission');
const {
  ORG_ROLE_TO_ROLE_CODE,
} = require('./rbac-catalog');
const {
  SYSTEM_ASSIGNMENT_TAG_VERSION,
  RbacAssignmentTargetInactiveError,
  acquireRbacMutationLock,
  assertRbacSystemPrincipalMutable,
  systemAssignmentProvenanceFilter,
  upsertSystemManagedAssignment,
} = require('./rbac-system-assignments');
const {
  bumpRbacPermissionVersion,
} = require('./rbac-permission-version');
const {
  assertSuperadminRemains,
} = require('./rbac-superadmin-invariant');
const {
  publishUserSessionsRevoked,
} = require('./auth/user-session-revocation-events');
const {
  acquireAuthUserLock,
} = require('./auth/auth-user-lock');

const SYSTEM_ASSIGNMENT_PREFIX = `rbac_sys_v${SYSTEM_ASSIGNMENT_TAG_VERSION}_`;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function systemGlobalAssignmentId(userId, roleId = '') {
  return `${SYSTEM_ASSIGNMENT_PREFIX}g_${digest(`${userId}:${roleId}`)}`;
}

function systemOrgAssignmentId(userId, orgId, roleId = '') {
  return `${SYSTEM_ASSIGNMENT_PREFIX}o_${digest(`${userId}:${orgId}:${roleId}`)}`;
}

function legacyRoleCode({ isAdmin, isSuperAdmin }) {
  if (isSuperAdmin) return 'SUPERADMIN';
  if (isAdmin) return 'PLATFORM_ADMIN';
  return 'USER';
}

function publicSelection(row, requestedSelect) {
  if (!requestedSelect || !row) return row;
  const result = {};
  for (const [key, included] of Object.entries(requestedSelect)) {
    if (included) result[key] = row[key];
  }
  return result;
}

function createRbacAssignmentSyncService({
  prisma: rootPrisma = prisma,
  invalidatePermissionsCache = requirePermission.invalidatePermissionsCache,
  writeAuditLog: auditWriter = writeAuditLogStrict,
  bumpPermissionVersion: bumpVersion = bumpRbacPermissionVersion,
    emitSessionsRevoked = publishUserSessionsRevoked,
} = {}) {
  if (!rootPrisma) throw new TypeError('RBAC assignment sync requires Prisma');
  const invalidate = typeof invalidatePermissionsCache === 'function'
    ? invalidatePermissionsCache
    : async () => {};
  if (typeof auditWriter !== 'function') {
    throw new TypeError('RBAC assignment sync requires a strict audit writer');
  }
  if (typeof bumpVersion !== 'function') {
    throw new TypeError('RBAC assignment sync requires a permission-version writer');
  }
  const audit = auditWriter;

  async function revokeAuthenticationState(db, userId) {
    const models = [
      db.session,
      db.partialSession,
      db.twoFAChallenge,
    ];
    for (const model of models) {
      if (typeof model?.deleteMany === 'function') {
        await model.deleteMany({ where: { userId } });
      }
    }
  }

  async function auditMutation(db, {
    actorId,
    userId,
    roleCode,
    scope,
    scopeId = null,
    result,
    action = 'rbac_system_assignment_sync',
  }) {
    await audit(db, {
      action,
      userId: actorId || null,
      actorType: actorId ? 'user' : 'system',
      resource: 'rbac_assignment',
      resourceId: userId,
      metadata: {
        actorId: actorId || null,
        targetUserId: userId,
        roleCode: roleCode || null,
        scope,
        scopeId,
        result,
        systemManaged: true,
      },
      tags: ['security', 'rbac', 'mutation'],
    });
  }

  async function roleByCode(db, roleCode) {
    const role = await db.role.findUnique({ where: { code: roleCode } });
    if (!role) {
      const error = new Error('RBAC_ROLE_NOT_SEEDED');
      error.code = 'RBAC_ROLE_NOT_SEEDED';
      throw error;
    }
    return role;
  }

  async function readUserState(db, userId) {
    if (typeof db?.user?.findUnique !== 'function') {
      const error = new Error('RBAC_USER_STATE_READER_REQUIRED');
      error.code = 'RBAC_USER_STATE_READER_REQUIRED';
      throw error;
    }
    return db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isAdmin: true,
        isSuperAdmin: true,
        deletedAt: true,
      },
    });
  }

  function isActiveUser(user) {
    return Boolean(user && user.deletedAt == null);
  }

  async function cleanInactiveAssignments(db, {
    userId,
    actorId = null,
    scope = 'ALL',
    scopeId = null,
  }) {
    const result = await db.userRole.deleteMany({ where: { userId } });
    await auditMutation(db, {
      actorId,
      userId,
      roleCode: null,
      scope,
      scopeId,
      result: 'denied_inactive',
      action: 'rbac_inactive_user_assignments_cleanup',
    });
    await bumpVersion(db);
    return {
      denied: true,
      reason: 'inactive_user',
      deleted: result.count || 0,
    };
  }

  async function readOrgMembership(db, { userId, orgId }) {
    if (typeof db?.orgMembership?.findUnique !== 'function') {
      const error = new Error('RBAC_ORG_MEMBERSHIP_READER_REQUIRED');
      error.code = 'RBAC_ORG_MEMBERSHIP_READER_REQUIRED';
      throw error;
    }
    return db.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: { userId: true, orgId: true, role: true },
    });
  }

  async function existingSystemGlobalAssignment(db, userId) {
    if (typeof db?.userRole?.findFirst !== 'function') return null;
    return db.userRole.findFirst({
      where: {
        userId,
        scope: 'GLOBAL',
        scopeId: null,
        ...systemAssignmentProvenanceFilter(),
      },
      include: { role: true },
    });
  }

  async function syncLegacyAdminAssignmentInTransaction(db, {
    userId,
    actorId = null,
    skipSuperadminGuard = false,
    lockAlreadyHeld = false,
  }) {
    if (!userId) throw new TypeError('syncLegacyAdminAssignment: userId required');
    assertRbacSystemPrincipalMutable(userId);
    if (!lockAlreadyHeld) {
      await acquireRbacMutationLock(db);
    }
    const user = await readUserState(db, userId);
    if (!isActiveUser(user)) {
      return cleanInactiveAssignments(db, {
        userId,
        actorId,
        scope: 'GLOBAL',
      });
    }
    const roleCode = legacyRoleCode(user);
    const role = await roleByCode(db, roleCode);
    const proposedAssignmentId = systemGlobalAssignmentId(userId, role.id);
    if (!skipSuperadminGuard && roleCode !== 'SUPERADMIN') {
      const prior = await existingSystemGlobalAssignment(db, userId);
      if (prior?.role?.code === 'SUPERADMIN') {
        await assertSuperadminRemains(db, {
          excludeSystemAssignmentsForUserId: userId,
          lockAlreadyHeld: true,
        });
      }
    }
    const assignment = await upsertSystemManagedAssignment(db, {
      id: proposedAssignmentId,
      userId,
      roleId: role.id,
      scope: 'GLOBAL',
      scopeId: null,
    }, { lockAlreadyHeld: true });
    const assignmentId = assignment.id;
    await db.userRole.findFirst({
      where: {
        userId,
        scope: 'GLOBAL',
        scopeId: null,
        ...systemAssignmentProvenanceFilter(),
      },
      select: { id: true },
    });
    await db.userRole.deleteMany({
      where: {
        userId,
        scope: 'GLOBAL',
        scopeId: null,
        ...systemAssignmentProvenanceFilter({
          exceptId: assignmentId,
        }),
      },
    });
    await auditMutation(db, {
      actorId,
      userId,
      roleCode,
      scope: 'GLOBAL',
      result: 'synchronized',
    });
    await bumpVersion(db);
    return { assignmentId, roleCode, scope: 'GLOBAL', scopeId: null };
  }

  async function syncLegacyAdminAssignment({
    prismaClient = null,
    invalidateAfter = true,
    ...args
  }) {
    if (prismaClient) {
      const result = await syncLegacyAdminAssignmentInTransaction(prismaClient, args);
      if (invalidateAfter) await invalidate(args.userId);
      return result;
    }
    const result = await rootPrisma.$transaction(
      (tx) => syncLegacyAdminAssignmentInTransaction(tx, args),
    );
    if (invalidateAfter) await invalidate(args.userId);
    return result;
  }

  async function syncOrgRoleAssignmentInTransaction(db, {
    userId,
    orgId,
    actorId = null,
    lockAlreadyHeld = false,
  }) {
    if (!userId || !orgId) {
      throw new TypeError('syncOrgRoleAssignment: userId and orgId required');
    }
    assertRbacSystemPrincipalMutable(userId);
    if (!lockAlreadyHeld) await acquireRbacMutationLock(db);
    const user = await readUserState(db, userId);
    if (!isActiveUser(user)) {
      return cleanInactiveAssignments(db, {
        userId,
        actorId,
        scope: 'ORG',
        scopeId: orgId,
      });
    }
    const membership = await readOrgMembership(db, { userId, orgId });
    if (!membership) {
      const removed = await db.userRole.deleteMany({
        where: {
          userId,
          scope: 'ORG',
          scopeId: orgId,
          ...systemAssignmentProvenanceFilter(),
        },
      });
      await auditMutation(db, {
        actorId,
        userId,
        roleCode: null,
        scope: 'ORG',
        scopeId: orgId,
        result: 'denied_missing_membership',
      });
      await bumpVersion(db);
      return {
        denied: true,
        reason: 'membership_missing',
        deleted: removed.count || 0,
      };
    }
    const roleCode = ORG_ROLE_TO_ROLE_CODE[String(membership.role || '').toUpperCase()];
    if (!roleCode) {
      const error = new Error('RBAC_ORG_ROLE_INVALID');
      error.code = 'RBAC_ORG_ROLE_INVALID';
      throw error;
    }
    const role = await roleByCode(db, roleCode);
    const proposedAssignmentId = systemOrgAssignmentId(userId, orgId, role.id);
    const assignment = await upsertSystemManagedAssignment(db, {
      id: proposedAssignmentId,
      userId,
      roleId: role.id,
      scope: 'ORG',
      scopeId: orgId,
    }, { lockAlreadyHeld: true });
    const assignmentId = assignment.id;
    await db.userRole.findFirst({
      where: {
        userId,
        scope: 'ORG',
        scopeId: orgId,
        ...systemAssignmentProvenanceFilter(),
      },
      select: { id: true },
    });
    await db.userRole.deleteMany({
      where: {
        userId,
        scope: 'ORG',
        scopeId: orgId,
        ...systemAssignmentProvenanceFilter({
          exceptId: assignmentId,
        }),
      },
    });
    await auditMutation(db, {
      actorId,
      userId,
      roleCode,
      scope: 'ORG',
      scopeId: orgId,
      result: 'synchronized',
    });
    await bumpVersion(db);
    return { assignmentId, roleCode, scope: 'ORG', scopeId: orgId };
  }

  async function syncOrgRoleAssignment({
    prismaClient = null,
    invalidateAfter = true,
    ...args
  }) {
    if (prismaClient) {
      const result = await syncOrgRoleAssignmentInTransaction(prismaClient, args);
      if (invalidateAfter) await invalidate(args.userId);
      return result;
    }
    const result = await rootPrisma.$transaction(
      (tx) => syncOrgRoleAssignmentInTransaction(tx, args),
    );
    if (invalidateAfter) await invalidate(args.userId);
    return result;
  }

  async function removeOrgRoleAssignmentInTransaction(db, {
    userId,
    orgId,
    actorId = null,
    orgRole = null,
    lockAlreadyHeld = false,
  }) {
    if (!userId || !orgId) {
      throw new TypeError('removeOrgRoleAssignment: userId and orgId required');
    }
    assertRbacSystemPrincipalMutable(userId);
    if (!lockAlreadyHeld) await acquireRbacMutationLock(db);
    const user = await readUserState(db, userId);
    if (!isActiveUser(user)) {
      return cleanInactiveAssignments(db, {
        userId,
        actorId,
        scope: 'ORG',
        scopeId: orgId,
      });
    }
    const membership = await readOrgMembership(db, { userId, orgId });
    if (membership) {
      return syncOrgRoleAssignmentInTransaction(db, {
        userId,
        orgId,
        actorId,
        lockAlreadyHeld: true,
      });
    }
    await db.userRole.findFirst({
      where: {
        userId,
        scope: 'ORG',
        scopeId: orgId,
        ...systemAssignmentProvenanceFilter(),
      },
      select: { id: true },
    });
    const result = await db.userRole.deleteMany({
      where: {
        userId,
        scope: 'ORG',
        scopeId: orgId,
        ...systemAssignmentProvenanceFilter(),
      },
    });
    await auditMutation(db, {
      actorId,
      userId,
      roleCode: ORG_ROLE_TO_ROLE_CODE[String(orgRole || '').toUpperCase()] || null,
      scope: 'ORG',
      scopeId: orgId,
      result: result.count > 0 ? 'deleted' : 'absent',
      action: 'rbac_system_assignment_remove',
    });
    await bumpVersion(db);
    return { deleted: result.count || 0 };
  }

  async function removeOrgRoleAssignment({
    prismaClient = null,
    invalidateAfter = true,
    ...args
  }) {
    if (prismaClient) {
      const result = await removeOrgRoleAssignmentInTransaction(prismaClient, args);
      if (invalidateAfter) await invalidate(args.userId);
      return result;
    }
    const result = await rootPrisma.$transaction(
      (tx) => removeOrgRoleAssignmentInTransaction(tx, args),
    );
    if (invalidateAfter) await invalidate(args.userId);
    return result;
  }

  async function updateLegacyAdminUser({
    userId,
    data,
    select = null,
    actorId = null,
  }) {
    assertRbacSystemPrincipalMutable(userId);
    const requestedSelect = select || null;
    const dbSelect = requestedSelect
      ? { ...requestedSelect, id: true, isAdmin: true, isSuperAdmin: true }
      : undefined;
    const row = await rootPrisma.$transaction(async (tx) => {
      await acquireRbacMutationLock(tx);
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          isAdmin: true,
          isSuperAdmin: true,
          deletedAt: true,
        },
      });
      if (!current) {
        const error = new Error('USER_NOT_FOUND');
        error.code = 'P2025';
        throw error;
      }
      if (!isActiveUser(current)) {
        await cleanInactiveAssignments(tx, {
          userId,
          actorId,
          scope: 'GLOBAL',
        });
        return { __rbacInactive: true };
      }
      const nextIsSuperAdmin = data.isSuperAdmin ?? current.isSuperAdmin;
      if (current.isSuperAdmin && !nextIsSuperAdmin) {
        await assertSuperadminRemains(tx, {
          excludeUserId: userId,
          lockAlreadyHeld: true,
        });
      }
      const updated = await tx.user.update({
        where: { id: userId },
        data,
        ...(dbSelect ? { select: dbSelect } : {}),
      });
      await syncLegacyAdminAssignmentInTransaction(tx, {
        userId,
        isAdmin: data.isAdmin ?? updated.isAdmin ?? current.isAdmin,
        isSuperAdmin: data.isSuperAdmin ?? updated.isSuperAdmin ?? current.isSuperAdmin,
        actorId,
        skipSuperadminGuard: true,
        lockAlreadyHeld: true,
      });
      return updated;
    });
    if (row?.__rbacInactive) throw new RbacAssignmentTargetInactiveError();
    await invalidate(userId);
    return publicSelection(row, requestedSelect);
  }

  async function createLegacyAdminUser({
    data,
    select = null,
    actorId = null,
    prismaClient = null,
    invalidateAfter = true,
  }) {
    if (data?.id) assertRbacSystemPrincipalMutable(data.id);
    const requestedSelect = select || null;
    const dbSelect = requestedSelect
      ? { ...requestedSelect, id: true, isAdmin: true, isSuperAdmin: true }
      : undefined;
    const createInTransaction = async (db) => {
      await acquireRbacMutationLock(db);
      const created = await db.user.create({
        data,
        ...(dbSelect ? { select: dbSelect } : {}),
      });
      await syncLegacyAdminAssignmentInTransaction(db, {
        userId: created.id,
        isAdmin: created.isAdmin ?? data.isAdmin ?? false,
        isSuperAdmin: created.isSuperAdmin ?? data.isSuperAdmin ?? false,
        actorId,
        lockAlreadyHeld: true,
      });
      return created;
    };
    const row = prismaClient
      ? await createInTransaction(prismaClient)
      : await rootPrisma.$transaction(createInTransaction);
    if (invalidateAfter) await invalidate(row.id);
    return publicSelection(row, requestedSelect);
  }

  async function removeUserSystemAssignmentsInTransaction(db, {
    userId,
    actorId = null,
    lockAlreadyHeld = false,
    removeAll = false,
  }) {
    if (!userId) throw new TypeError('removeUserSystemAssignments: userId required');
    assertRbacSystemPrincipalMutable(userId);
    if (typeof db?.userRole?.findMany !== 'function') {
      const error = new Error('RBAC_ASSIGNMENT_TRANSACTION_REQUIRED');
      error.code = 'RBAC_ASSIGNMENT_TRANSACTION_REQUIRED';
      throw error;
    }
    if (!lockAlreadyHeld) await acquireRbacMutationLock(db);
    const user = await readUserState(db, userId);
    const deleteAll = removeAll || !isActiveUser(user);
    const currentAssignments = await db.userRole.findMany({
      where: deleteAll
        ? { userId }
        : {
            userId,
            ...systemAssignmentProvenanceFilter(),
          },
      select: { id: true, scope: true, scopeId: true },
    });
    const result = await db.userRole.deleteMany({
      where: { id: { in: currentAssignments.map((row) => row.id) } },
    });
    await auditMutation(db, {
      actorId,
      userId,
      roleCode: null,
      scope: 'ALL',
      result: result.count > 0
        ? (deleteAll ? 'deleted_all' : 'deleted')
        : 'absent',
      action: 'rbac_user_system_assignments_remove',
    });
    await bumpVersion(db);
    return { deleted: result.count || 0 };
  }

  async function removeUserSystemAssignments({
    prismaClient = null,
    userId,
    actorId = null,
    invalidateAfter = true,
  }) {
    const args = { userId, actorId };
    const result = prismaClient
      ? await removeUserSystemAssignmentsInTransaction(prismaClient, args)
      : await rootPrisma.$transaction(
        (tx) => removeUserSystemAssignmentsInTransaction(tx, args),
      );
    if (invalidateAfter) await invalidate(userId);
    return result;
  }

  async function softDeleteUser({
    userId,
    actorId = null,
    deletedAt = new Date(),
  }) {
    assertRbacSystemPrincipalMutable(userId);
    const row = await rootPrisma.$transaction(async (tx) => {
      await acquireRbacMutationLock(tx);
      await acquireAuthUserLock(tx, userId);
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, isSuperAdmin: true, deletedAt: true },
      });
      if (!current) {
        const error = new Error('USER_NOT_FOUND');
        error.code = 'P2025';
        throw error;
      }
      if (current.isSuperAdmin && !current.deletedAt) {
        await assertSuperadminRemains(tx, {
          excludeUserId: userId,
          lockAlreadyHeld: true,
        });
      }
      const updated = await tx.user.update({
        where: { id: userId },
        data: { deletedAt },
      });
      await revokeAuthenticationState(tx, userId);
      await removeUserSystemAssignmentsInTransaction(tx, {
        userId,
        actorId,
        lockAlreadyHeld: true,
      });
      return updated;
    });
    await invalidate(userId);
    await emitSessionsRevoked?.({ userId, reason: 'account_deleted' });
    return row;
  }

  async function hardDeleteUser({
    userId,
    actorId = null,
  }) {
    assertRbacSystemPrincipalMutable(userId);
    const row = await rootPrisma.$transaction(async (tx) => {
      await acquireRbacMutationLock(tx);
      await acquireAuthUserLock(tx, userId);
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, isSuperAdmin: true, deletedAt: true },
      });
      if (!current) {
        const error = new Error('USER_NOT_FOUND');
        error.code = 'P2025';
        throw error;
      }
      if (current.isSuperAdmin && !current.deletedAt) {
        await assertSuperadminRemains(tx, {
          excludeUserId: userId,
          lockAlreadyHeld: true,
        });
      }
      await removeUserSystemAssignmentsInTransaction(tx, {
        userId,
        actorId,
        lockAlreadyHeld: true,
        removeAll: true,
      });
      await revokeAuthenticationState(tx, userId);
      return tx.user.delete({ where: { id: userId } });
    });
    await invalidate(userId);
    await emitSessionsRevoked?.({ userId, reason: 'account_deleted' });
    return row;
  }

  async function invalidateUser(userId) {
    return invalidate(userId);
  }

  return {
    syncLegacyAdminAssignment,
    syncOrgRoleAssignment,
    removeOrgRoleAssignment,
    removeUserSystemAssignments,
    updateLegacyAdminUser,
    createLegacyAdminUser,
    softDeleteUser,
    hardDeleteUser,
    invalidateUser,
  };
}

let defaultService = null;
function getDefaultService() {
  if (!defaultService) defaultService = createRbacAssignmentSyncService();
  return defaultService;
}

function defaultMethod(name) {
  return (...args) => getDefaultService()[name](...args);
}

module.exports = {
  SYSTEM_ASSIGNMENT_PREFIX,
  systemGlobalAssignmentId,
  systemOrgAssignmentId,
  legacyRoleCode,
  createRbacAssignmentSyncService,
  syncLegacyAdminAssignment: defaultMethod('syncLegacyAdminAssignment'),
  syncOrgRoleAssignment: defaultMethod('syncOrgRoleAssignment'),
  removeOrgRoleAssignment: defaultMethod('removeOrgRoleAssignment'),
  removeUserSystemAssignments: defaultMethod('removeUserSystemAssignments'),
  updateLegacyAdminUser: defaultMethod('updateLegacyAdminUser'),
  createLegacyAdminUser: defaultMethod('createLegacyAdminUser'),
  softDeleteUser: defaultMethod('softDeleteUser'),
  hardDeleteUser: defaultMethod('hardDeleteUser'),
  invalidateUser: defaultMethod('invalidateUser'),
};
