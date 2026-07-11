'use strict';

const {
  acquireRbacMutationLock,
  SYSTEM_ASSIGNMENT_TAG_PREFIX,
} = require('./rbac-system-assignments');

class RbacLastSuperadminError extends Error {
  constructor() {
    super('RBAC_LAST_SUPERADMIN');
    this.name = 'RbacLastSuperadminError';
    this.code = 'RBAC_LAST_SUPERADMIN';
    this.statusCode = 409;
  }
}

function countFromRow(row) {
  const value = Number(row?.effective_count ?? row?.effectiveCount ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Serialize all operations that could remove effective global SUPERADMIN
 * access, then count distinct active users after the proposed exclusion.
 */
async function assertSuperadminRemains(transactionClient, {
  excludeAssignmentId = null,
  excludeUserId = null,
  excludeSystemAssignmentsForUserId = null,
  lockAlreadyHeld = false,
} = {}) {
  if (typeof transactionClient?.$queryRawUnsafe !== 'function') {
    const error = new Error('RBAC_SUPERADMIN_INVARIANT_TRANSACTION_REQUIRED');
    error.code = 'RBAC_SUPERADMIN_INVARIANT_TRANSACTION_REQUIRED';
    throw error;
  }
  if (!lockAlreadyHeld) await acquireRbacMutationLock(transactionClient);
  const rows = await transactionClient.$queryRawUnsafe(
    `
      SELECT COUNT(DISTINCT ur."userId")::int AS "effective_count"
      FROM "user_roles" ur
      JOIN "roles" r ON r."id" = ur."roleId"
      JOIN "users" u ON u."id" = ur."userId"
      WHERE r."code" = 'SUPERADMIN'
        AND ur."scope" = 'GLOBAL'::"RoleScope"
        AND ur."scopeId" IS NULL
        AND u."isSuperAdmin" = TRUE
        AND u."deletedAt" IS NULL
        AND ($1::text IS NULL OR ur."id" <> $1)
        AND ($2::text IS NULL OR ur."userId" <> $2)
        AND (
          $3::text IS NULL
          OR ur."userId" <> $3
          OR ur."assignedBy" IS NULL
          OR ur."assignedBy" NOT LIKE '${SYSTEM_ASSIGNMENT_TAG_PREFIX}%'
        )
    `,
    excludeAssignmentId,
    excludeUserId,
    excludeSystemAssignmentsForUserId,
  );
  const remaining = countFromRow(rows?.[0]);
  if (remaining < 1) throw new RbacLastSuperadminError();
  return remaining;
}

module.exports = {
  RbacLastSuperadminError,
  assertSuperadminRemains,
};
