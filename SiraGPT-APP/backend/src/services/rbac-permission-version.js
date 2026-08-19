'use strict';

const PERMISSION_VERSION_KEY = 'rbac:permission-version';
const PERMISSION_VERSION_ROW_ID = 'rbac_permission_version';

function normalizePermissionVersion(value) {
  const text = String(value ?? '').trim();
  return /^(?:0|[1-9]\d*)$/.test(text) ? text : '0';
}

async function readRbacPermissionVersion(prismaClient) {
  if (!prismaClient?.systemSettings
      || typeof prismaClient.systemSettings.findUnique !== 'function') {
    const error = new Error('RBAC_PERMISSION_VERSION_STORE_UNAVAILABLE');
    error.code = 'RBAC_PERMISSION_VERSION_STORE_UNAVAILABLE';
    throw error;
  }
  const row = await prismaClient.systemSettings.findUnique({
    where: { key: PERMISSION_VERSION_KEY },
    select: { value: true },
  });
  return normalizePermissionVersion(row?.value);
}

/**
 * Atomically increments the durable invalidation generation. This must be
 * called with the same Prisma transaction client as the protected mutation.
 */
async function bumpRbacPermissionVersion(transactionClient) {
  if (!transactionClient || typeof transactionClient.$queryRawUnsafe !== 'function') {
    const error = new Error('RBAC_PERMISSION_VERSION_TRANSACTION_REQUIRED');
    error.code = 'RBAC_PERMISSION_VERSION_TRANSACTION_REQUIRED';
    throw error;
  }
  const rows = await transactionClient.$queryRawUnsafe(
    `
      INSERT INTO "system_settings" ("id", "key", "value")
      VALUES ($1, $2, '1')
      ON CONFLICT ("key") DO UPDATE SET
        "value" = (
          CASE
            WHEN "system_settings"."value" ~ '^(0|[1-9][0-9]*)$'
              THEN "system_settings"."value"::numeric
            ELSE 0
          END + 1
        )::text
      RETURNING "value" AS "version"
    `,
    PERMISSION_VERSION_ROW_ID,
    PERMISSION_VERSION_KEY,
  );
  return normalizePermissionVersion(rows?.[0]?.version);
}

module.exports = {
  PERMISSION_VERSION_KEY,
  PERMISSION_VERSION_ROW_ID,
  normalizePermissionVersion,
  readRbacPermissionVersion,
  bumpRbacPermissionVersion,
};
