'use strict';

/**
 * Public allowlist for Codex project-database metadata.
 *
 * Infrastructure identifiers, role names, operation leases, errors, secret
 * envelopes and credential-generation details are intentionally omitted.
 */

const PUBLIC_DATABASE_FIELDS = Object.freeze([
  'id',
  'provider',
  'status',
  'desiredState',
  'quotaMb',
  'maxConnections',
  'lastBackupAt',
  'lastRestoreTestAt',
  'provisionedAt',
  'rotationDueAt',
  'deleteRequestedAt',
  'deletedAt',
  'createdAt',
  'updatedAt',
]);

function publicProjectDatabase(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const output = {};
  for (const field of PUBLIC_DATABASE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) output[field] = row[field];
  }
  return output;
}

module.exports = {
  PUBLIC_DATABASE_FIELDS,
  publicProjectDatabase,
};
