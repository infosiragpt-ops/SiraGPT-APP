'use strict';

const SYSTEM_ASSIGNMENT_TAG_VERSION = 4;
const SYSTEM_ASSIGNMENT_TAG_PREFIX = 'rbac-system:v';
const SYSTEM_ASSIGNMENT_TAG = `${SYSTEM_ASSIGNMENT_TAG_PREFIX}${SYSTEM_ASSIGNMENT_TAG_VERSION}`;
const SYSTEM_ASSIGNMENT_TAG_PREFIXES = Object.freeze([
  SYSTEM_ASSIGNMENT_TAG_PREFIX,
]);
const LEGACY_SYSTEM_ASSIGNMENT_ID_PREFIXES = Object.freeze([
  'rbac_sys_v',
  'rbac_global_',
  'rbac_org_',
  'ur_g_',
  'ur_o_',
]);

/**
 * One cluster-wide transaction lock serializes every RBAC mutation.
 *
 * Keep this integer stable across releases and replicas. A single lock domain
 * deliberately trades RBAC write throughput for simple, auditable ordering:
 * bootstrap, lifecycle dual-write, cleanup, and control-plane mutations can
 * never observe partially-transitioned authorization state.
 */
const RBAC_MUTATION_LOCK_KEY = 1_917_221_337;
const RBAC_MUTATION_LOCK_SQL = `
  WITH lock_acquired AS (
    SELECT pg_advisory_xact_lock($1::bigint)
  )
  SELECT 1::int AS locked
  FROM lock_acquired
`;
const RBAC_MUTATION_LOCK_TIMEOUT_SQL =
  "SELECT set_config('lock_timeout', $1, TRUE) AS lock_timeout";
const RBAC_MUTATION_LOCK_TIMEOUT_RESET = '0';
const DEFAULT_RBAC_MUTATION_LOCK_TIMEOUT_MS = 500;
const MIN_RBAC_MUTATION_LOCK_TIMEOUT_MS = 25;
const MAX_RBAC_MUTATION_LOCK_TIMEOUT_MS = 5_000;

function isSystemAssignmentTag(value) {
  const normalized = String(value || '');
  return SYSTEM_ASSIGNMENT_TAG_PREFIXES.some(
    (prefix) => normalized.startsWith(prefix),
  );
}

function isRbacSystemPrincipalId(userId) {
  return isSystemAssignmentTag(userId);
}

function assertRbacSystemPrincipalMutable(userId) {
  if (!isRbacSystemPrincipalId(userId)) return;
  const error = new Error('RBAC_SYSTEM_PRINCIPAL_PROTECTED');
  error.code = 'RBAC_SYSTEM_PRINCIPAL_PROTECTED';
  error.statusCode = 409;
  throw error;
}

function excludeRbacSystemPrincipalsWhere(where = {}) {
  return {
    AND: [
      where,
      { NOT: { id: { startsWith: SYSTEM_ASSIGNMENT_TAG_PREFIX } } },
    ],
  };
}

function isSystemManagedAssignment(assignment) {
  return isSystemAssignmentTag(assignment?.assignedBy);
}

function systemAssignmentProvenanceFilter({ exceptId = null } = {}) {
  const family = {
    OR: SYSTEM_ASSIGNMENT_TAG_PREFIXES.map(
      (startsWith) => ({ assignedBy: { startsWith } }),
    ),
  };
  if (!exceptId) return family;
  return {
    AND: [
      family,
      { id: { not: exceptId } },
    ],
  };
}

class RbacMutationBusyError extends Error {
  constructor({ timeoutMs = DEFAULT_RBAC_MUTATION_LOCK_TIMEOUT_MS } = {}) {
    super('RBAC_MUTATION_BUSY');
    this.name = 'RbacMutationBusyError';
    this.code = 'RBAC_MUTATION_BUSY';
    this.status = 503;
    this.statusCode = 503;
    this.retryable = true;
    this.retryAfterSeconds = 1;
    this.expose = true;
    this.details = { timeoutMs };
  }
}

class RbacAssignmentTargetInactiveError extends Error {
  constructor() {
    super('RBAC assignment target is inactive');
    this.name = 'RbacAssignmentTargetInactiveError';
    this.code = 'rbac_assignment_target_inactive';
    this.status = 409;
    this.statusCode = 409;
    this.expose = true;
  }
}

function normalizeRbacMutationLockTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_RBAC_MUTATION_LOCK_TIMEOUT_MS;
  return Math.min(
    MAX_RBAC_MUTATION_LOCK_TIMEOUT_MS,
    Math.max(MIN_RBAC_MUTATION_LOCK_TIMEOUT_MS, Math.floor(parsed)),
  );
}

function isRbacMutationLockTimeout(error) {
  const codes = [
    error?.code,
    error?.meta?.code,
    error?.cause?.code,
    error?.cause?.meta?.code,
  ].map((value) => String(value || '').toUpperCase());
  if (codes.includes('55P03')) return true;
  return /lock timeout|canceling statement due to lock timeout/i.test(
    String(error?.message || ''),
  );
}

async function acquireRbacMutationLock(
  transactionClient,
  { timeoutMs = process.env.RBAC_MUTATION_LOCK_TIMEOUT_MS } = {},
) {
  if (typeof transactionClient?.$queryRawUnsafe !== 'function') {
    const error = new Error('RBAC_MUTATION_TRANSACTION_REQUIRED');
    error.code = 'RBAC_MUTATION_TRANSACTION_REQUIRED';
    throw error;
  }
  const boundedTimeoutMs = normalizeRbacMutationLockTimeoutMs(timeoutMs);
  await transactionClient.$queryRawUnsafe(
    RBAC_MUTATION_LOCK_TIMEOUT_SQL,
    `${boundedTimeoutMs}ms`,
  );
  try {
    await transactionClient.$queryRawUnsafe(
      RBAC_MUTATION_LOCK_SQL,
      RBAC_MUTATION_LOCK_KEY,
    );
  } catch (error) {
    if (isRbacMutationLockTimeout(error)) {
      throw new RbacMutationBusyError({ timeoutMs: boundedTimeoutMs });
    }
    throw error;
  }
  // The bounded timeout applies only while waiting for the global advisory
  // lock. Restore PostgreSQL's normal transaction-local setting immediately
  // after acquisition so authorization reads/writes are not spuriously
  // cancelled. This call deliberately sits outside the acquisition catch:
  // only a timeout from pg_advisory_xact_lock maps to RBAC_MUTATION_BUSY.
  await transactionClient.$queryRawUnsafe(
    RBAC_MUTATION_LOCK_TIMEOUT_SQL,
    RBAC_MUTATION_LOCK_TIMEOUT_RESET,
  );
}

/**
 * Fresh `prisma db push` schemas do not contain the historical expression
 * unique index. Serialize the natural tuple, then re-read after acquiring the
 * transaction-scoped lock before choosing UPDATE or INSERT.
 */
async function upsertRoleAssignmentByNaturalTuple(
  transactionClient,
  assignment,
  {
    assignedBy,
    adoptExistingProvenance = false,
    lockAlreadyHeld = false,
  },
) {
  if (
    typeof transactionClient?.$queryRawUnsafe !== 'function'
    || typeof transactionClient?.userRole?.findFirst !== 'function'
    || typeof transactionClient?.userRole?.update !== 'function'
    || typeof transactionClient?.userRole?.create !== 'function'
  ) {
    const error = new Error('RBAC_ASSIGNMENT_TRANSACTION_REQUIRED');
    error.code = 'RBAC_ASSIGNMENT_TRANSACTION_REQUIRED';
    throw error;
  }
  const tuple = {
    userId: assignment?.userId,
    roleId: assignment?.roleId,
    scope: assignment?.scope,
    scopeId: assignment?.scopeId ?? null,
  };
  if (!tuple.roleId) throw new TypeError('RBAC_ASSIGNMENT_TUPLE_INVALID');
  if (!lockAlreadyHeld) {
    await acquireRbacMutationLock(transactionClient);
  }
  const existing = await transactionClient.userRole.findFirst({
    where: tuple,
    orderBy: { assignedAt: 'asc' },
  });
  if (existing) {
    if (adoptExistingProvenance) {
      return {
        assignment: await transactionClient.userRole.update({
          where: { id: existing.id },
          data: { assignedBy },
        }),
        created: false,
      };
    }
    return { assignment: existing, created: false };
  }
  return {
    assignment: await transactionClient.userRole.create({
      data: {
        id: assignment.id,
        ...tuple,
        assignedBy,
      },
    }),
    created: true,
  };
}

async function upsertSystemManagedAssignment(
  transactionClient,
  assignment,
  { lockAlreadyHeld = false } = {},
) {
  const result = await upsertRoleAssignmentByNaturalTuple(
    transactionClient,
    assignment,
    {
      assignedBy: SYSTEM_ASSIGNMENT_TAG,
      adoptExistingProvenance: true,
      lockAlreadyHeld,
    },
  );
  return result.assignment;
}

module.exports = {
  SYSTEM_ASSIGNMENT_TAG_VERSION,
  SYSTEM_ASSIGNMENT_TAG_PREFIX,
  SYSTEM_ASSIGNMENT_TAG,
  SYSTEM_ASSIGNMENT_TAG_PREFIXES,
  LEGACY_SYSTEM_ASSIGNMENT_ID_PREFIXES,
  RBAC_MUTATION_LOCK_KEY,
  RBAC_MUTATION_LOCK_SQL,
  RBAC_MUTATION_LOCK_TIMEOUT_SQL,
  RBAC_MUTATION_LOCK_TIMEOUT_RESET,
  DEFAULT_RBAC_MUTATION_LOCK_TIMEOUT_MS,
  MIN_RBAC_MUTATION_LOCK_TIMEOUT_MS,
  MAX_RBAC_MUTATION_LOCK_TIMEOUT_MS,
  RbacMutationBusyError,
  RbacAssignmentTargetInactiveError,
  isSystemAssignmentTag,
  isRbacSystemPrincipalId,
  assertRbacSystemPrincipalMutable,
  excludeRbacSystemPrincipalsWhere,
  isSystemManagedAssignment,
  systemAssignmentProvenanceFilter,
  normalizeRbacMutationLockTimeoutMs,
  isRbacMutationLockTimeout,
  acquireRbacMutationLock,
  upsertRoleAssignmentByNaturalTuple,
  upsertSystemManagedAssignment,
};
