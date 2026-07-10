'use strict';

const DATABASE_URL_CONFLICT_CODE = 'DATABASE_URL_CONFLICT';
const DIRECT_POSTGRES_PROTOCOLS = Object.freeze(new Set(['postgres:', 'postgresql:']));
const REMOTE_PRISMA_PROTOCOL = 'prisma+postgres:';

class DatabaseUrlConflictError extends Error {
  constructor() {
    super('Conflicting database URL environment variables are configured.');
    this.name = 'DatabaseUrlConflictError';
    this.code = DATABASE_URL_CONFLICT_CODE;
  }
}

function trimmedEnvironmentValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolve the process database URL without reading global state.
 *
 * PRISMA_DATABASE_URL is canonical. DATABASE_URL remains a compatibility
 * fallback for deployments that have not migrated yet. Defining both aliases
 * is permitted only when their trimmed values are identical; otherwise boot
 * fails closed with a value-free error.
 */
function resolveCanonicalDatabaseUrl(env = {}) {
  const canonical = trimmedEnvironmentValue(env.PRISMA_DATABASE_URL);
  const fallback = trimmedEnvironmentValue(env.DATABASE_URL);
  if (canonical && fallback && canonical !== fallback) {
    throw new DatabaseUrlConflictError();
  }
  return canonical || fallback || null;
}

function classifyDatabasePoolCapacity(databaseUrl) {
  const value = trimmedEnvironmentValue(databaseUrl);
  if (!value) {
    return Object.freeze({
      observable: false,
      reason: 'database_url_unconfigured',
      protocol: null,
    });
  }

  let protocol = null;
  try {
    protocol = new URL(value).protocol;
  } catch {
    return Object.freeze({
      observable: false,
      reason: 'invalid_database_url',
      protocol: null,
    });
  }

  if (DIRECT_POSTGRES_PROTOCOLS.has(protocol)) {
    return Object.freeze({
      observable: true,
      reason: 'direct_postgres_datasource',
      protocol,
    });
  }
  if (protocol === REMOTE_PRISMA_PROTOCOL) {
    return Object.freeze({
      observable: false,
      reason: 'remote_prisma_datasource',
      protocol,
    });
  }
  return Object.freeze({
    observable: false,
    reason: 'unsupported_database_protocol',
    protocol,
  });
}

module.exports = {
  DATABASE_URL_CONFLICT_CODE,
  DIRECT_POSTGRES_PROTOCOLS,
  REMOTE_PRISMA_PROTOCOL,
  DatabaseUrlConflictError,
  resolveCanonicalDatabaseUrl,
  classifyDatabasePoolCapacity,
};
