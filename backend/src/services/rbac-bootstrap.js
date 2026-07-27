'use strict';

const {
  ROLES,
  ROLE_CODES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
} = require('./rbac-catalog');
const {
  MODES,
  resolveRbacEnforcementMode,
} = require('./rbac-enforcement-mode');
const {
  bumpRbacPermissionVersion,
} = require('./rbac-permission-version');
const {
  SYSTEM_ASSIGNMENT_TAG_VERSION,
  SYSTEM_ASSIGNMENT_TAG_PREFIX,
  SYSTEM_ASSIGNMENT_TAG,
  LEGACY_SYSTEM_ASSIGNMENT_ID_PREFIXES,
  acquireRbacMutationLock,
} = require('./rbac-system-assignments');

const READINESS_ERROR_CODE = 'RBAC_READINESS_FAILED';
const BOOTSTRAP_ERROR_CODE = 'RBAC_BOOTSTRAP_FAILED';
const BOOTSTRAP_VERSION = SYSTEM_ASSIGNMENT_TAG_VERSION;
const BOOTSTRAP_MARKER_KEY = `rbac_bootstrap:v${BOOTSTRAP_VERSION}`;
const SYSTEM_ASSIGNMENT_PREFIX = `rbac_sys_v${BOOTSTRAP_VERSION}_`;
const SYSTEM_PROVENANCE_SQL = `(
  ur."assignedBy" LIKE '${SYSTEM_ASSIGNMENT_TAG_PREFIX}%'
)`;
const SYSTEM_GLOBAL_PROVENANCE_SQL = `(
  ur."scope" = 'GLOBAL'::"RoleScope"
  AND ur."scopeId" IS NULL
  AND ${SYSTEM_PROVENANCE_SQL}
)`;
const SYSTEM_ORG_PROVENANCE_SQL = `(
  ur."scope" = 'ORG'::"RoleScope"
  AND ur."scopeId" IS NOT NULL
  AND ${SYSTEM_PROVENANCE_SQL}
)`;

class RbacBootstrapError extends Error {
  constructor(code, diagnostics = {}) {
    super(code);
    this.name = 'RbacBootstrapError';
    this.code = code;
    this.diagnostics = Object.freeze({ ...diagnostics });
  }
}

function placeholders(rows, columns) {
  let index = 1;
  return rows.map(() => {
    const tuple = [];
    for (let i = 0; i < columns; i += 1) tuple.push(`$${index++}`);
    return `(${tuple.join(', ')})`;
  }).join(',\n');
}

function roleSeedStatement() {
  return {
    name: 'roles',
    sql: `
      INSERT INTO "roles" ("id", "code", "name", "description", "isSystem")
      VALUES ${placeholders(ROLES, 5)}
      ON CONFLICT ("code") DO UPDATE SET
        "name" = EXCLUDED."name",
        "description" = EXCLUDED."description",
        "isSystem" = TRUE,
        "updatedAt" = CURRENT_TIMESTAMP
    `,
    params: ROLES.flatMap((role) => [
      role.id, role.code, role.name, role.description, true,
    ]),
  };
}

function permissionSeedStatement() {
  return {
    name: 'permissions',
    sql: `
      INSERT INTO "permissions" ("id", "code", "description", "isSystem")
      VALUES ${placeholders(PERMISSIONS, 4)}
      ON CONFLICT ("code") DO UPDATE SET
        "description" = EXCLUDED."description",
        "isSystem" = TRUE
    `,
    params: PERMISSIONS.flatMap((permission) => [
      permission.id, permission.code, permission.description, true,
    ]),
  };
}

function rolePermissionStatement(roleCode, permissionCodes) {
  return {
    name: `role_permissions:${roleCode}`,
    sql: `
      INSERT INTO "role_permissions" ("id", "roleId", "permissionId")
      SELECT
        'rbac_boot_' || md5(r."id" || ':' || p."id"),
        r."id",
        p."id"
      FROM "roles" r
      JOIN "permissions" p ON p."code" = ANY($2::text[])
      WHERE r."code" = $1
      ON CONFLICT ("roleId", "permissionId") DO NOTHING
    `,
    params: [roleCode, permissionCodes],
  };
}

const SYSTEM_ASSIGNMENT_PRINCIPAL = Object.freeze({
  name: 'system_assignment_principal',
  sql: `
    INSERT INTO "users" (
      "id", "email", "name", "password", "isAdmin", "isSuperAdmin",
      "createdAt", "updatedAt", "deletedAt"
    )
    VALUES ($1, $2, $3, $4, FALSE, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $5)
    ON CONFLICT ("id") DO UPDATE SET
      "deletedAt" = EXCLUDED."deletedAt",
      "updatedAt" = CURRENT_TIMESTAMP
  `,
  params: Object.freeze([
    SYSTEM_ASSIGNMENT_TAG,
    `rbac-system-v${BOOTSTRAP_VERSION}@internal.invalid`,
    `RBAC System Principal v${BOOTSTRAP_VERSION}`,
    '!rbac-system-principal-no-login!',
    new Date('9999-12-31T23:59:59.000Z'),
  ]),
});

const LEGACY_ASSIGNMENT_PROVENANCE_MIGRATION = Object.freeze({
  name: 'legacy_assignment_provenance',
  sql: `
    UPDATE "user_roles"
    SET "assignedBy" = $1
    WHERE "assignedBy" IS NULL
      AND (
        ${LEGACY_SYSTEM_ASSIGNMENT_ID_PREFIXES.map(
    (_, index) => `"id" LIKE $${index + 2}`,
  ).join('\n        OR ')}
      )
  `,
  params: Object.freeze([
    SYSTEM_ASSIGNMENT_TAG,
    ...LEGACY_SYSTEM_ASSIGNMENT_ID_PREFIXES.map((prefix) => `${prefix}%`),
  ]),
});

const RBAC_RECONCILIATION_CANDIDATES_SQL = `
  SELECT
    u."id" AS user_id,
    r."id" AS role_id,
    'GLOBAL' AS scope,
    NULL AS scope_id
  FROM "users" u
  JOIN "roles" r ON r."code" = CASE
    WHEN u."isSuperAdmin" THEN 'SUPERADMIN'
    WHEN u."isAdmin" THEN 'PLATFORM_ADMIN'
    ELSE 'USER'
  END
  WHERE u."deletedAt" IS NULL
  UNION ALL
  SELECT
    om."userId" AS user_id,
    r."id" AS role_id,
    'ORG' AS scope,
    om."orgId" AS scope_id
  FROM "org_memberships" om
  JOIN "users" u
    ON u."id" = om."userId"
   AND u."deletedAt" IS NULL
  JOIN "roles" r ON r."code" = CASE om."role"::text
    WHEN 'OWNER' THEN 'ORG_OWNER'
    WHEN 'ADMIN' THEN 'ORG_ADMIN'
    WHEN 'MEMBER' THEN 'ORG_MEMBER'
    WHEN 'VIEWER' THEN 'ORG_VIEWER'
  END
  ORDER BY user_id, scope, scope_id
`;

const RBAC_SET_BASED_RECONCILIATION_SQL = `
  /* rbac_bootstrap_set_reconcile */
  WITH inactive_cleaned AS (
    DELETE FROM "user_roles" ur
    USING "users" u
    WHERE u."id" = ur."userId"
      AND u."deletedAt" IS NOT NULL
    RETURNING ur."id"
  ),
  desired_source AS (
    ${RBAC_RECONCILIATION_CANDIDATES_SQL}
  ),
  desired AS (
    SELECT
      d.*,
      (
        SELECT ur."id"
        FROM "user_roles" ur
        WHERE ur."userId" = d.user_id
          AND ur."roleId" = d.role_id
          AND ur."scope" = d.scope::"RoleScope"
          AND ur."scopeId" IS NOT DISTINCT FROM d.scope_id
        ORDER BY
          CASE WHEN ur."assignedBy" LIKE '${SYSTEM_ASSIGNMENT_TAG_PREFIX}%' THEN 0 ELSE 1 END,
          ur."assignedAt",
          ur."id"
        LIMIT 1
      ) AS existing_id,
      '${SYSTEM_ASSIGNMENT_PREFIX}' ||
        CASE WHEN d.scope = 'ORG' THEN 'o_' ELSE 'g_' END ||
        md5(
          d.user_id || ':' || d.role_id || ':' || d.scope || ':' ||
          COALESCE(d.scope_id, '')
        ) AS generated_id
    FROM desired_source d
  ),
  adopted AS (
    UPDATE "user_roles" ur
    SET "assignedBy" = $1
    FROM desired d
    WHERE d.existing_id = ur."id"
      AND ur."assignedBy" IS DISTINCT FROM $1
    RETURNING ur."id"
  ),
  inserted AS (
    INSERT INTO "user_roles" (
      "id", "userId", "roleId", "scope", "scopeId", "assignedBy"
    )
    SELECT
      d.generated_id,
      d.user_id,
      d.role_id,
      d.scope::"RoleScope",
      d.scope_id,
      $1
    FROM desired d
    WHERE d.existing_id IS NULL
    RETURNING "id"
  ),
  cleaned AS (
    DELETE FROM "user_roles" ur
    USING desired d
    WHERE ur."userId" = d.user_id
      AND ur."scope" = d.scope::"RoleScope"
      AND ur."scopeId" IS NOT DISTINCT FROM d.scope_id
      AND ur."id" <> COALESCE(d.existing_id, d.generated_id)
      AND (
        ur."assignedBy" LIKE '${SYSTEM_ASSIGNMENT_TAG_PREFIX}%'
        OR ur."roleId" = d.role_id
      )
    RETURNING ur."id"
  )
  SELECT
    (SELECT COUNT(*)::int FROM desired) AS desired_count,
    (SELECT COUNT(*)::int FROM adopted) AS adopted_count,
    (SELECT COUNT(*)::int FROM inserted) AS inserted_count,
    (
      (SELECT COUNT(*)::int FROM cleaned)
      +
      (SELECT COUNT(*)::int FROM inactive_cleaned)
    ) AS deleted_count
`;

const SYSTEM_ASSIGNMENT_CLEANUP = Object.freeze({
  name: 'system_assignment_cleanup',
  sql: `
    DELETE FROM "user_roles" ur
    WHERE ${SYSTEM_PROVENANCE_SQL}
      AND (
        (
          ur."scope" = 'GLOBAL'::"RoleScope"
          AND NOT EXISTS (
            SELECT 1
            FROM "users" u
            JOIN "roles" r ON r."code" = CASE
              WHEN u."isSuperAdmin" THEN 'SUPERADMIN'
              WHEN u."isAdmin" THEN 'PLATFORM_ADMIN'
              ELSE 'USER'
            END
            WHERE u."id" = ur."userId"
              AND u."deletedAt" IS NULL
              AND ur."scopeId" IS NULL
              AND ur."roleId" = r."id"
          )
        )
        OR
        (
          ur."scope" = 'ORG'::"RoleScope"
          AND NOT EXISTS (
            SELECT 1
            FROM "org_memberships" om
            JOIN "users" u
              ON u."id" = om."userId"
             AND u."deletedAt" IS NULL
            JOIN "roles" r ON r."code" = CASE om."role"::text
              WHEN 'OWNER' THEN 'ORG_OWNER'
              WHEN 'ADMIN' THEN 'ORG_ADMIN'
              WHEN 'MEMBER' THEN 'ORG_MEMBER'
              WHEN 'VIEWER' THEN 'ORG_VIEWER'
            END
            WHERE om."userId" = ur."userId"
              AND om."orgId" = ur."scopeId"
              AND ur."roleId" = r."id"
          )
        )
      )
  `,
  params: Object.freeze([]),
});

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const ROLE_PERMISSION_VALUE_SQL = Object.entries(ROLE_PERMISSIONS)
  .flatMap(([roleCode, permissionCodes]) => permissionCodes.map(
    (permissionCode) => `(${sqlLiteral(roleCode)}, ${sqlLiteral(permissionCode)})`,
  ))
  .join(',\n');

function canonicalRolePermissionCleanupStatement() {
  return {
    name: 'canonical_role_permission_cleanup',
    sql: `
      DELETE FROM "role_permissions" rp
      USING "roles" r, "permissions" p
      WHERE rp."roleId" = r."id"
        AND rp."permissionId" = p."id"
        AND r."code" = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1
          FROM (VALUES ${ROLE_PERMISSION_VALUE_SQL}) expected(role_code, permission_code)
          WHERE expected.role_code = r."code"
            AND expected.permission_code = p."code"
        )
    `,
    params: [ROLE_CODES],
  };
}

const SYSTEM_ASSIGNMENT_DRIFT_COUNT_SQL = `
  (
    (
      SELECT COUNT(*)
      FROM "users" u
      JOIN "roles" r ON r."code" = CASE
        WHEN u."isSuperAdmin" THEN 'SUPERADMIN'
        WHEN u."isAdmin" THEN 'PLATFORM_ADMIN'
        ELSE 'USER'
      END
      WHERE u."deletedAt" IS NULL
        AND (
          SELECT COUNT(*)
          FROM "user_roles" ur
          WHERE ${SYSTEM_GLOBAL_PROVENANCE_SQL}
            AND ur."userId" = u."id"
            AND ur."roleId" = r."id"
        ) <> 1
    )
    +
    (
      SELECT COUNT(*)
      FROM "org_memberships" om
      JOIN "users" u
        ON u."id" = om."userId"
       AND u."deletedAt" IS NULL
      JOIN "roles" r ON r."code" = CASE om."role"::text
        WHEN 'OWNER' THEN 'ORG_OWNER'
        WHEN 'ADMIN' THEN 'ORG_ADMIN'
        WHEN 'MEMBER' THEN 'ORG_MEMBER'
        WHEN 'VIEWER' THEN 'ORG_VIEWER'
      END
      WHERE (
        SELECT COUNT(*)
        FROM "user_roles" ur
        WHERE ${SYSTEM_ORG_PROVENANCE_SQL}
          AND ur."userId" = om."userId"
          AND ur."roleId" = r."id"
          AND ur."scopeId" = om."orgId"
      ) <> 1
    )
    +
    (
      SELECT COUNT(*)
      FROM "user_roles" ur
      WHERE ${SYSTEM_PROVENANCE_SQL}
        AND (
          (
            ${SYSTEM_GLOBAL_PROVENANCE_SQL}
            AND NOT EXISTS (
              SELECT 1
              FROM "users" u
              JOIN "roles" r ON r."code" = CASE
                WHEN u."isSuperAdmin" THEN 'SUPERADMIN'
                WHEN u."isAdmin" THEN 'PLATFORM_ADMIN'
                ELSE 'USER'
              END
              WHERE u."id" = ur."userId"
                AND u."deletedAt" IS NULL
                AND ur."roleId" = r."id"
            )
          )
          OR
          (
            ${SYSTEM_ORG_PROVENANCE_SQL}
            AND NOT EXISTS (
              SELECT 1
              FROM "org_memberships" om
              JOIN "users" u
                ON u."id" = om."userId"
               AND u."deletedAt" IS NULL
              JOIN "roles" r ON r."code" = CASE om."role"::text
                WHEN 'OWNER' THEN 'ORG_OWNER'
                WHEN 'ADMIN' THEN 'ORG_ADMIN'
                WHEN 'MEMBER' THEN 'ORG_MEMBER'
                WHEN 'VIEWER' THEN 'ORG_VIEWER'
              END
              WHERE om."userId" = ur."userId"
                AND om."orgId" = ur."scopeId"
                AND ur."roleId" = r."id"
            )
          )
        )
    )
  )
`;

const RBAC_SYSTEM_ASSIGNMENT_DRIFT_SQL = `
  SELECT ${SYSTEM_ASSIGNMENT_DRIFT_COUNT_SQL} AS system_assignment_drift_count
`;

const RBAC_READINESS_SQL = `
  SELECT
    (
      SELECT COUNT(*)
      FROM "users" u
      WHERE u."deletedAt" IS NULL
        AND (u."isAdmin" OR u."isSuperAdmin")
        AND NOT EXISTS (
          SELECT 1
          FROM "user_roles" ur
          JOIN "roles" r ON r."id" = ur."roleId"
          WHERE ur."userId" = u."id"
            AND ur."scope" = 'GLOBAL'::"RoleScope"
            AND ur."scopeId" IS NULL
            AND r."code" = CASE
              WHEN u."isSuperAdmin" THEN 'SUPERADMIN'
              ELSE 'PLATFORM_ADMIN'
            END
        )
    ) AS legacy_admin_gap_count,
    (
      SELECT COUNT(*)
      FROM "permissions" p
      WHERE p."isSystem" = TRUE
        AND NOT EXISTS (
          SELECT 1
          FROM "role_permissions" rp
          JOIN "roles" r ON r."id" = rp."roleId"
          WHERE r."code" = 'SUPERADMIN'
            AND rp."permissionId" = p."id"
        )
    ) AS superadmin_permission_gap_count,
    (
      SELECT COUNT(*)
      FROM (
        SELECT expected.code
        FROM (VALUES ${ROLES.map((role) => `(${sqlLiteral(role.code)})`).join(', ')}) expected(code)
        WHERE NOT EXISTS (SELECT 1 FROM "roles" r WHERE r."code" = expected.code)
        UNION ALL
        SELECT expected.code
        FROM (VALUES ${PERMISSIONS.map((permission) => `(${sqlLiteral(permission.code)})`).join(', ')}) expected(code)
        WHERE NOT EXISTS (SELECT 1 FROM "permissions" p WHERE p."code" = expected.code)
        UNION ALL
        SELECT expected.role_code || ':' || expected.permission_code
        FROM (VALUES ${ROLE_PERMISSION_VALUE_SQL}) expected(role_code, permission_code)
        WHERE NOT EXISTS (
          SELECT 1
          FROM "role_permissions" rp
          JOIN "roles" r ON r."id" = rp."roleId"
          JOIN "permissions" p ON p."id" = rp."permissionId"
          WHERE r."code" = expected.role_code
            AND p."code" = expected.permission_code
        )
      ) gaps
    ) AS canonical_catalog_gap_count,
    (
      SELECT COUNT(*)
      FROM "role_permissions" rp
      JOIN "roles" r ON r."id" = rp."roleId"
      JOIN "permissions" p ON p."id" = rp."permissionId"
      WHERE r."code" IN (${ROLE_CODES.map(sqlLiteral).join(', ')})
        AND NOT EXISTS (
          SELECT 1
          FROM (VALUES ${ROLE_PERMISSION_VALUE_SQL}) expected(role_code, permission_code)
          WHERE expected.role_code = r."code"
            AND expected.permission_code = p."code"
        )
    ) AS canonical_role_permission_excess_count,
    ${SYSTEM_ASSIGNMENT_DRIFT_COUNT_SQL} AS system_assignment_drift_count
`;

async function reconcileSystemAssignments(tx) {
  const rows = await tx.$queryRawUnsafe(
    RBAC_SET_BASED_RECONCILIATION_SQL,
    SYSTEM_ASSIGNMENT_TAG,
  );
  return numberFromRow(Array.isArray(rows) ? rows[0] : rows, 'desired_count');
}

function buildRbacBootstrapStatements() {
  return [
    roleSeedStatement(),
    permissionSeedStatement(),
    ...Object.entries(ROLE_PERMISSIONS).map(([roleCode, permissions]) =>
      rolePermissionStatement(roleCode, permissions)),
    canonicalRolePermissionCleanupStatement(),
    SYSTEM_ASSIGNMENT_PRINCIPAL,
    LEGACY_ASSIGNMENT_PROVENANCE_MIGRATION,
    SYSTEM_ASSIGNMENT_CLEANUP,
  ];
}

function numberFromRow(row, key) {
  const value = Number(row?.[key] ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function diagnosticsFromReadiness(row) {
  const diagnostics = {
    legacyAdminGapCount: numberFromRow(row, 'legacy_admin_gap_count'),
    superadminPermissionGapCount: numberFromRow(row, 'superadmin_permission_gap_count'),
  };
  if (Object.prototype.hasOwnProperty.call(row || {}, 'canonical_catalog_gap_count')) {
    diagnostics.canonicalCatalogGapCount = numberFromRow(row, 'canonical_catalog_gap_count');
  }
  if (
    Object.prototype.hasOwnProperty.call(
      row || {},
      'canonical_role_permission_excess_count',
    )
  ) {
    diagnostics.canonicalRolePermissionExcessCount = numberFromRow(
      row,
      'canonical_role_permission_excess_count',
    );
  }
  if (Object.prototype.hasOwnProperty.call(row || {}, 'system_assignment_drift_count')) {
    diagnostics.systemAssignmentDriftCount = numberFromRow(
      row,
      'system_assignment_drift_count',
    );
  }
  return diagnostics;
}

function readinessPassed(diagnostics) {
  return diagnostics.legacyAdminGapCount === 0
    && diagnostics.superadminPermissionGapCount === 0
    && (diagnostics.canonicalCatalogGapCount ?? 0) === 0
    && (diagnostics.canonicalRolePermissionExcessCount ?? 0) === 0
    && (diagnostics.systemAssignmentDriftCount ?? 0) === 0;
}

function safeStatus(status) {
  return Object.freeze({
    state: status.state,
    ready: status.ready,
    mode: status.mode,
    errorCode: status.errorCode || null,
    checkedAt: status.checkedAt || null,
    bootstrapVersion: status.bootstrapVersion || BOOTSTRAP_VERSION,
    reconciled: status.reconciled === true,
  });
}

function markerVersion(row) {
  if (!row?.value) return 0;
  try {
    const parsed = JSON.parse(row.value);
    const version = Number(parsed?.version);
    return Number.isInteger(version) && version > 0 ? version : 0;
  } catch (_) {
    return 0;
  }
}

async function readBootstrapMarker(tx) {
  if (tx.systemSettings?.findUnique) {
    return tx.systemSettings.findUnique({ where: { key: BOOTSTRAP_MARKER_KEY } });
  }
  return null;
}

async function writeBootstrapMarker(tx) {
  const value = JSON.stringify({
    version: BOOTSTRAP_VERSION,
    assignmentPrefix: SYSTEM_ASSIGNMENT_PREFIX,
    reconciledAt: new Date().toISOString(),
  });
  if (tx.systemSettings?.upsert) {
    await tx.systemSettings.upsert({
      where: { key: BOOTSTRAP_MARKER_KEY },
      create: { key: BOOTSTRAP_MARKER_KEY, value },
      update: { value },
    });
    return;
  }
  await tx.$executeRawUnsafe(
    `
      INSERT INTO "system_settings" ("id", "key", "value")
      VALUES ($1, $2, $3)
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"
    `,
    `rbac_bootstrap_marker_v${BOOTSTRAP_VERSION}`,
    BOOTSTRAP_MARKER_KEY,
    value,
  );
}

function createRbacBootstrapService({
  prisma,
  env = process.env,
  invalidatePermissionsCache,
  writeAuditLog,
  logger = console,
} = {}) {
  if (!prisma || typeof prisma.$transaction !== 'function') {
    throw new TypeError('RBAC bootstrap requires a Prisma client with $transaction');
  }

  const invalidate = typeof invalidatePermissionsCache === 'function'
    ? invalidatePermissionsCache
    : () => {};
  const audit = typeof writeAuditLog === 'function' ? writeAuditLog : async () => null;
  let status = safeStatus({
    state: 'not_started',
    ready: false,
    mode: null,
    errorCode: null,
    reconciled: false,
  });
  let runPromise = null;
  let completed = false;

  function getStatus() {
    return status;
  }

  async function emitAudit(action, mode, diagnostics, reconciled = false) {
    try {
      await audit(prisma, {
        actorType: 'system',
        action,
        resource: 'rbac',
        metadata: {
          mode,
          bootstrapVersion: BOOTSTRAP_VERSION,
          reconciled,
          legacyAdminGapCount: diagnostics?.legacyAdminGapCount ?? null,
          superadminPermissionGapCount: diagnostics?.superadminPermissionGapCount ?? null,
          canonicalCatalogGapCount: diagnostics?.canonicalCatalogGapCount ?? null,
          canonicalRolePermissionExcessCount:
            diagnostics?.canonicalRolePermissionExcessCount ?? null,
          systemAssignmentDriftCount: diagnostics?.systemAssignmentDriftCount ?? null,
        },
        tags: ['security', 'rbac', 'startup'],
      });
    } catch (_) {
      // Startup authorization must not depend on audit storage availability.
    }
  }

  async function run() {
    const mode = resolveRbacEnforcementMode(env);
    status = safeStatus({
      state: 'running',
      ready: false,
      mode,
      errorCode: null,
      reconciled: false,
    });
    try {
      const result = await prisma.$transaction(async (tx) => {
        await acquireRbacMutationLock(tx);
        const marker = await readBootstrapMarker(tx);
        const reconciled = markerVersion(marker) < BOOTSTRAP_VERSION;
        if (reconciled) {
          const statements = buildRbacBootstrapStatements();
          for (const statement of statements) {
            if (statement.name === SYSTEM_ASSIGNMENT_CLEANUP.name) continue;
            await tx.$executeRawUnsafe(statement.sql, ...statement.params);
          }
          await reconcileSystemAssignments(tx);
          await tx.$executeRawUnsafe(
            SYSTEM_ASSIGNMENT_CLEANUP.sql,
            ...SYSTEM_ASSIGNMENT_CLEANUP.params,
          );
        }
        const rows = await tx.$queryRawUnsafe(RBAC_READINESS_SQL);
        const diagnostics = diagnosticsFromReadiness(
          Array.isArray(rows) ? rows[0] : rows,
        );
        if (!readinessPassed(diagnostics)) {
          throw new RbacBootstrapError(READINESS_ERROR_CODE, diagnostics);
        }
        if (reconciled) {
          await writeBootstrapMarker(tx);
          await bumpRbacPermissionVersion(tx);
        }
        return {
          reconciled,
          diagnostics,
        };
      });
      const { diagnostics, reconciled } = result;

      if (reconciled) await invalidate();
      const checkedAt = new Date().toISOString();
      status = safeStatus({
        state: 'ready',
        ready: true,
        mode,
        errorCode: null,
        checkedAt,
        reconciled,
      });
      await emitAudit('rbac_bootstrap_ready', mode, diagnostics, reconciled);
      logger.info?.({ mode }, 'rbac_bootstrap_ready');
      completed = true;
      return status;
    } catch (error) {
      const checkedAt = new Date().toISOString();
      if (
        error instanceof RbacBootstrapError
        && error.code === READINESS_ERROR_CODE
      ) {
        status = safeStatus({
          state: mode === MODES.ENFORCE ? 'failed' : 'degraded',
          ready: false,
          mode,
          errorCode: READINESS_ERROR_CODE,
          checkedAt,
          reconciled: false,
        });
        await emitAudit('rbac_bootstrap_not_ready', mode, error.diagnostics, false);
        logger.warn?.({
          code: READINESS_ERROR_CODE,
          mode,
          ...error.diagnostics,
        }, 'rbac_bootstrap_not_ready');
        if (mode === MODES.ENFORCE) throw error;
        completed = true;
        return status;
      }
      if (error instanceof RbacBootstrapError) throw error;
      status = safeStatus({
        state: mode === MODES.ENFORCE ? 'failed' : 'degraded',
        ready: false,
        mode,
        errorCode: BOOTSTRAP_ERROR_CODE,
        checkedAt,
        reconciled: false,
      });
      await emitAudit('rbac_bootstrap_failed', mode, null, false);
      logger.error?.({ code: BOOTSTRAP_ERROR_CODE, mode }, 'rbac_bootstrap_failed');
      if (mode === MODES.ENFORCE) {
        throw new RbacBootstrapError(BOOTSTRAP_ERROR_CODE);
      }
      completed = true;
      return status;
    }
  }

  function bootstrap() {
    if (completed) return Promise.resolve(Object.freeze({ ...status, replay: true }));
    if (!runPromise) {
      runPromise = run().finally(() => {
        if (!completed) runPromise = null;
      });
    }
    return runPromise;
  }

  return {
    bootstrap,
    getStatus,
  };
}

module.exports = {
  READINESS_ERROR_CODE,
  BOOTSTRAP_ERROR_CODE,
  BOOTSTRAP_VERSION,
  BOOTSTRAP_MARKER_KEY,
  SYSTEM_ASSIGNMENT_PREFIX,
  RBAC_READINESS_SQL,
  RBAC_SYSTEM_ASSIGNMENT_DRIFT_SQL,
  RBAC_RECONCILIATION_CANDIDATES_SQL,
  RBAC_SET_BASED_RECONCILIATION_SQL,
  RbacBootstrapError,
  buildRbacBootstrapStatements,
  diagnosticsFromReadiness,
  createRbacBootstrapService,
};
