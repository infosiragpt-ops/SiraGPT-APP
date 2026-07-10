'use strict';

const DATABASE_RUNTIME_URL_CONFLICT_CODE = 'DATABASE_RUNTIME_URL_CONFLICT';
const DATABASE_DIRECT_URL_CONFLICT_CODE = 'DATABASE_DIRECT_URL_CONFLICT';
const DATABASE_URL_CONFLICT_CODE = 'DATABASE_URL_CONFLICT';
const LEGACY_DATABASE_URL_CONFLICT_CODE = DATABASE_URL_CONFLICT_CODE;
const DIRECT_DATABASE_URL_INVALID_CODE = 'DIRECT_DATABASE_URL_INVALID';
const DIRECT_DATABASE_URL_REQUIRED_CODE = 'DIRECT_DATABASE_URL_REQUIRED';
const DIRECT_POSTGRES_PROTOCOLS = Object.freeze(new Set(['postgres:', 'postgresql:']));
const REMOTE_PRISMA_PROTOCOL = 'prisma+postgres:';
const DIRECT_POSTGRES_URL_PATTERN = /^postgres(?:ql)?:\/\//i;
const REMOTE_PRISMA_URL_PATTERN = /^prisma\+postgres:\/\//i;
const DATABASE_URL_ENV_KEYS = Object.freeze([
  'PRISMA_DATABASE_URL',
  'DIRECT_DATABASE_URL',
  'DATABASE_URL',
]);

class DatabaseUrlConflictError extends Error {
  constructor(role) {
    const direct = role === 'direct_migration';
    super(
      direct
        ? 'Conflicting direct migration database URL aliases are configured.'
        : 'Conflicting runtime database URL aliases are configured.',
    );
    this.name = 'DatabaseUrlConflictError';
    this.code = direct
      ? DATABASE_DIRECT_URL_CONFLICT_CODE
      : DATABASE_RUNTIME_URL_CONFLICT_CODE;
    this.legacyCode = LEGACY_DATABASE_URL_CONFLICT_CODE;
    this.codeAliases = Object.freeze([
      this.code,
      LEGACY_DATABASE_URL_CONFLICT_CODE,
    ]);
    this.role = direct ? 'direct_migration' : 'runtime';
  }
}

class DirectDatabaseUrlError extends Error {
  constructor(code) {
    const missing = code === DIRECT_DATABASE_URL_REQUIRED_CODE;
    super(
      missing
        ? 'A direct PostgreSQL URL is required for database migrations.'
        : 'DIRECT_DATABASE_URL must use the postgres: or postgresql: protocol.',
    );
    this.name = 'DirectDatabaseUrlError';
    this.code = code;
    this.role = 'direct_migration';
    if (missing) this.exitStatus = 78;
  }
}

function trimmedEnvironmentValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasExplicitDatabaseUrl(env = {}) {
  return DATABASE_URL_ENV_KEYS.some((key) => trimmedEnvironmentValue(env[key]));
}

/**
 * Build the local Compose datasource only for a genuinely POSTGRES-only
 * environment. Any explicit role URL suppresses this compatibility fallback,
 * including a remote runtime URL that intentionally requires a separate
 * direct migration URL.
 */
function synthesizePostgresEnvironmentUrl(env = {}) {
  if (hasExplicitDatabaseUrl(env)) return null;

  const host = trimmedEnvironmentValue(env.POSTGRES_HOST);
  const user = trimmedEnvironmentValue(env.POSTGRES_USER);
  const password = trimmedEnvironmentValue(env.POSTGRES_PASSWORD);
  const database = trimmedEnvironmentValue(env.POSTGRES_DB);
  const portText = trimmedEnvironmentValue(env.POSTGRES_PORT) || '5432';
  const port = Number(portText);
  if (
    !host
    || !user
    || !password
    || !database
    || !/^\d+$/.test(portText)
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
  ) {
    return null;
  }

  try {
    const url = new URL('postgresql://localhost');
    url.username = user;
    url.password = password;
    url.hostname = host;
    url.port = String(port);
    url.pathname = `/${database}`;
    if (url.hostname.toLowerCase() !== host.toLowerCase()) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function databaseUrlProtocol(value) {
  const trimmed = trimmedEnvironmentValue(value);
  if (!trimmed) return null;
  try {
    return new URL(trimmed).protocol;
  } catch {
    return null;
  }
}

function isDirectPostgresUrl(value) {
  const trimmed = trimmedEnvironmentValue(value);
  return (
    DIRECT_POSTGRES_URL_PATTERN.test(trimmed)
    && DIRECT_POSTGRES_PROTOCOLS.has(databaseUrlProtocol(trimmed))
  );
}

function isRemotePrismaUrl(value) {
  const trimmed = trimmedEnvironmentValue(value);
  return (
    REMOTE_PRISMA_URL_PATTERN.test(trimmed)
    && databaseUrlProtocol(trimmed) === REMOTE_PRISMA_PROTOCOL
  );
}

/**
 * Resolve the runtime datasource without reading global state.
 *
 * PRISMA_DATABASE_URL is canonical and DATABASE_URL is its legacy fallback.
 * The one intentional split is an Accelerate runtime URL paired with a direct
 * DATABASE_URL for migrations. Other divergent runtime aliases fail closed.
 */
function resolveRuntimeDatabaseUrl(env = {}) {
  const canonical = trimmedEnvironmentValue(env.PRISMA_DATABASE_URL);
  const fallback = trimmedEnvironmentValue(env.DATABASE_URL);
  if (canonical && fallback && canonical !== fallback) {
    if (isRemotePrismaUrl(canonical) && isDirectPostgresUrl(fallback)) {
      return canonical;
    }
    throw new DatabaseUrlConflictError('runtime');
  }
  return canonical || fallback || synthesizePostgresEnvironmentUrl(env) || null;
}

/**
 * Resolve the direct datasource used by Prisma CLI and `pg`.
 *
 * DIRECT_DATABASE_URL is explicit and authoritative. Without it, DATABASE_URL
 * then PRISMA_DATABASE_URL may serve as compatibility fallbacks only when they
 * are direct PostgreSQL URLs.
 */
function resolveDirectMigrationDatabaseUrl(env = {}) {
  const explicit = trimmedEnvironmentValue(env.DIRECT_DATABASE_URL);
  if (explicit) {
    if (!isDirectPostgresUrl(explicit)) {
      throw new DirectDatabaseUrlError(DIRECT_DATABASE_URL_INVALID_CODE);
    }
    return explicit;
  }

  const legacy = trimmedEnvironmentValue(env.DATABASE_URL);
  const prisma = trimmedEnvironmentValue(env.PRISMA_DATABASE_URL);
  const legacyDirect = isDirectPostgresUrl(legacy) ? legacy : '';
  const prismaDirect = isDirectPostgresUrl(prisma) ? prisma : '';
  if (legacyDirect && prismaDirect && legacyDirect !== prismaDirect) {
    throw new DatabaseUrlConflictError('direct_migration');
  }
  return legacyDirect || prismaDirect || synthesizePostgresEnvironmentUrl(env) || null;
}

function resolveDatabaseUrls(env = {}) {
  return Object.freeze({
    runtimeUrl: resolveRuntimeDatabaseUrl(env),
    directMigrationUrl: resolveDirectMigrationDatabaseUrl(env),
  });
}

function requireDirectMigrationDatabaseUrl(env = {}) {
  const { directMigrationUrl } = resolveDatabaseUrls(env);
  if (!directMigrationUrl) {
    throw new DirectDatabaseUrlError(DIRECT_DATABASE_URL_REQUIRED_CODE);
  }
  return directMigrationUrl;
}

// Backward-compatible runtime resolver name for callers outside the boot path.
const resolveCanonicalDatabaseUrl = resolveRuntimeDatabaseUrl;

function redactDatabaseUrls(value, env = {}) {
  let output = String(value ?? '');
  for (const key of ['PRISMA_DATABASE_URL', 'DIRECT_DATABASE_URL', 'DATABASE_URL']) {
    const configured = trimmedEnvironmentValue(env[key]);
    if (configured) output = output.split(configured).join('[REDACTED_DATABASE_URL]');
  }
  return output.replace(
    /\b(?:postgres(?:ql)?|prisma\+postgres):\/\/\S+/gi,
    '[REDACTED_DATABASE_URL]',
  );
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
  LEGACY_DATABASE_URL_CONFLICT_CODE,
  DATABASE_RUNTIME_URL_CONFLICT_CODE,
  DATABASE_DIRECT_URL_CONFLICT_CODE,
  DIRECT_DATABASE_URL_INVALID_CODE,
  DIRECT_DATABASE_URL_REQUIRED_CODE,
  DIRECT_POSTGRES_PROTOCOLS,
  REMOTE_PRISMA_PROTOCOL,
  DatabaseUrlConflictError,
  DirectDatabaseUrlError,
  hasExplicitDatabaseUrl,
  synthesizePostgresEnvironmentUrl,
  databaseUrlProtocol,
  isDirectPostgresUrl,
  isRemotePrismaUrl,
  redactDatabaseUrls,
  resolveDatabaseUrls,
  resolveRuntimeDatabaseUrl,
  resolveDirectMigrationDatabaseUrl,
  requireDirectMigrationDatabaseUrl,
  resolveCanonicalDatabaseUrl,
  classifyDatabasePoolCapacity,
};
