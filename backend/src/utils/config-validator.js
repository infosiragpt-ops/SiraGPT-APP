// ──────────────────────────────────────────────────────────────
// siraGPT — Config Validator (cycle 34)
// ──────────────────────────────────────────────────────────────
// Boot-time validator that complements the existing
// `startup-validator.js`. Where startup-validator focuses on
// placeholder secrets & dangerous values, this module focuses on
// the *shape* of the configuration for a given environment:
//
//   - what env vars are REQUIRED per environment (dev/staging/prod)
//   - common cross-field misconfigurations
//     (e.g. NODE_ENV=production + PRISMA_DATABASE_URL points to localhost)
//   - missing-but-recommended observability / integration keys
//
// Designed to be wired BEFORE any service init in `backend/index.js`
// so a misconfigured prod boot fails fast with a clear error rather
// than silently running against the wrong database.
//
// Public API:
//   validateConfig(env = process.env, opts = {})
//     → { ok, env, errors, warnings }
//   validateConfigOrExit(env = process.env, opts = {})
//     → { ok, ... } (or calls process.exit(1) on errors when
//       `failOnError` is true — default in production)
// ──────────────────────────────────────────────────────────────

'use strict';

const {
  DATABASE_RUNTIME_URL_CONFLICT_CODE,
  DATABASE_DIRECT_URL_CONFLICT_CODE,
  DIRECT_DATABASE_URL_INVALID_CODE,
  isDirectPostgresUrl,
  isRemotePrismaUrl,
  resolveDirectMigrationDatabaseUrl,
  resolveRuntimeDatabaseUrl,
} = require('../config/database-url');
const {
  hasWildcardOrigin,
  validateAllowedOrigins,
} = require('../middleware/cors-policy');
const {
  isInvalidEnvironmentAlias,
  normalizeEnvironmentName,
} = require('./environment');

// Per-environment required vars. Kept small & realistic — anything
// the app cannot serve real traffic without. Optional integrations
// live in RECOMMENDED.
const REQUIRED_BY_ENV = {
  development: [
    'PRISMA_DATABASE_URL',
  ],
  test: [
    // tests typically inject their own fixtures
  ],
  staging: [
    'PRISMA_DATABASE_URL',
    'SESSION_SECRET',
    'JWT_SECRET',
  ],
  production: [
    'PRISMA_DATABASE_URL',
    'SESSION_SECRET',
    'JWT_SECRET',
    'NODE_ENV',
  ],
};

// Recommended but non-fatal. Logged as warnings only.
const RECOMMENDED_BY_ENV = {
  development: [],
  test: [],
  staging: ['REDIS_URL', 'SENTRY_DSN'],
  production: [
    'REDIS_URL',
    'SENTRY_DSN',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'SLACK_ENCRYPTION_KEY',
  ],
};

const LOCALHOST_PATTERNS = [
  /\blocalhost\b/i,
  /\b127\.0\.0\.1\b/,
  /\b0\.0\.0\.0\b/,
  /\b::1\b/,
];

function resolveEnvName(env) {
  return normalizeEnvironmentName(env);
}

function looksLikeLocalhost(value) {
  if (!value || typeof value !== 'string') return false;
  return LOCALHOST_PATTERNS.some((re) => re.test(value));
}

function isCiEnvironment(env) {
  return String(env.CI || '').toLowerCase() === 'true' || String(env.GITHUB_ACTIONS || '').toLowerCase() === 'true';
}

function shouldBlockLocalDatabaseUrl(env) {
  const policy = String(env.DATABASE_URL_LOCALHOST_POLICY || '').toLowerCase().trim();
  return policy === 'block' || String(env.REJECT_LOCAL_DATABASE_URL || '').toLowerCase() === 'true';
}

function checkRequired(env, envName, errors, databaseUrl, databaseUrlConflict) {
  const required = REQUIRED_BY_ENV[envName] || [];
  for (const key of required) {
    if (key === 'PRISMA_DATABASE_URL' && databaseUrlConflict) continue;
    const v = key === 'PRISMA_DATABASE_URL' ? databaseUrl : env[key];
    if (!v || String(v).trim() === '') {
      errors.push({
        key,
        envName,
        message: `[${envName}] Required env var ${key} is missing or empty.`,
      });
    }
  }
}

function checkRecommended(env, envName, warnings) {
  const rec = RECOMMENDED_BY_ENV[envName] || [];
  for (const key of rec) {
    const v = env[key];
    if (!v || String(v).trim() === '') {
      warnings.push({
        key,
        envName,
        message: `[${envName}] Recommended env var ${key} is not set — feature may be disabled.`,
      });
    }
  }
}

function checkCrossFieldMisconfig(env, envName, warnings, errors, databaseUrl) {
  // Prod DB pointing at localhost is almost certainly a mistake.
  const databaseKey = String(env.PRISMA_DATABASE_URL || '').trim()
    ? 'PRISMA_DATABASE_URL'
    : 'DATABASE_URL';

  if (envName === 'production' && looksLikeLocalhost(databaseUrl) && shouldBlockLocalDatabaseUrl(env)) {
    errors.push({
      key: databaseKey,
      envName,
      message:
        'NODE_ENV=production but database URL points to localhost. ' +
        'DATABASE_URL_LOCALHOST_POLICY=block is set — refusing to boot.',
    });
  } else if (envName === 'production' && looksLikeLocalhost(databaseUrl)) {
    warnings.push({
      key: databaseKey,
      envName,
      message:
        'NODE_ENV=production but database URL points to localhost. ' +
        (isCiEnvironment(env)
          ? 'Allowed for CI/GitHub Actions smoke tests.'
          : 'Verify this is intentional (e.g. same-host Postgres or sidecar). Set DATABASE_URL_LOCALHOST_POLICY=block to fail closed.'),
    });
  }
  if (envName === 'production' && looksLikeLocalhost(env.REDIS_URL)) {
    warnings.push({
      key: 'REDIS_URL',
      envName,
      message:
        'NODE_ENV=production but REDIS_URL points to localhost. ' +
        'Verify this is intentional (e.g. sidecar) before serving traffic.',
    });
  }
  // Prod with debug logging is a noisy footgun.
  if (envName === 'production' && /^debug$/i.test(String(env.LOG_LEVEL || ''))) {
    warnings.push({
      key: 'LOG_LEVEL',
      envName,
      message: 'LOG_LEVEL=debug in production will flood logs and may leak PII.',
    });
  }
  // Short secrets in prod
  for (const k of ['SESSION_SECRET', 'JWT_SECRET']) {
    const v = env[k];
    if (envName === 'production' && v && String(v).length < 32) {
      warnings.push({
        key: k,
        envName,
        message: `${k} is shorter than 32 chars in production — strengthen it.`,
      });
    }
  }
  // Credentialed CORS reflects the requesting origin. A wildcard in
  // production would therefore let an arbitrary site submit authenticated
  // browser requests and defeats the Origin half of the CSRF policy.
  if (envName === 'production') {
    const corsOrigins = String(env.CORS_ORIGINS || '').trim();
    if (!corsOrigins) {
      errors.push({
        key: 'CORS_ORIGINS',
        code: 'CORS_ORIGINS_REQUIRED',
        envName,
        message: 'Production requires an explicit CORS_ORIGINS allowlist.',
      });
    } else if (hasWildcardOrigin(corsOrigins)) {
      errors.push({
        key: 'CORS_ORIGINS',
        code: 'CORS_WILDCARD_CREDENTIALS_FORBIDDEN',
        envName,
        message: 'Credentialed CORS cannot use a wildcard origin in production.',
      });
    } else {
      try {
        validateAllowedOrigins(
          corsOrigins.split(',').map((origin) => origin.trim()).filter(Boolean),
        );
      } catch (_error) {
        errors.push({
          key: 'CORS_ORIGINS',
          code: 'CORS_ORIGINS_INVALID',
          envName,
          message: 'Production CORS_ORIGINS contains an invalid origin.',
        });
      }
    }
  }
  if (
    envName === 'production'
    && ['1', 'true'].includes(String(env.CSRF_DISABLED || '').trim().toLowerCase())
  ) {
    errors.push({
      key: 'CSRF_DISABLED',
      code: 'CSRF_DISABLED_IN_PRODUCTION',
      envName,
      message: 'CSRF protection cannot be disabled in production.',
    });
  }
}

function validateConfig(env = process.env, opts = {}) {
  const envName = opts.envName || resolveEnvName(env);
  const errors = [];
  const warnings = [];
  let databaseUrl = null;
  let runtimeDatabaseUrlConflict = false;

  if (isInvalidEnvironmentAlias(env)) {
    errors.push({
      key: 'NODE_ENV',
      code: 'NODE_ENV_INVALID_ALIAS',
      envName,
      message: 'NODE_ENV uses an unsupported alias; use the literal production environment name.',
    });
  }

  try {
    databaseUrl = resolveRuntimeDatabaseUrl(env);
  } catch (error) {
    runtimeDatabaseUrlConflict = error?.code === DATABASE_RUNTIME_URL_CONFLICT_CODE;
    errors.push({
      key: 'PRISMA_DATABASE_URL',
      code: DATABASE_RUNTIME_URL_CONFLICT_CODE,
      envName,
      message: 'Conflicting runtime database URL aliases are configured. Refusing to choose between them.',
    });
  }

  try {
    resolveDirectMigrationDatabaseUrl(env);
  } catch (error) {
    const code = error?.code === DATABASE_DIRECT_URL_CONFLICT_CODE
      ? DATABASE_DIRECT_URL_CONFLICT_CODE
      : DIRECT_DATABASE_URL_INVALID_CODE;
    errors.push({
      key: 'DIRECT_DATABASE_URL',
      code,
      envName,
      message: code === DATABASE_DIRECT_URL_CONFLICT_CODE
        ? 'Conflicting direct migration database URL aliases are configured.'
        : 'DIRECT_DATABASE_URL must use the postgres: or postgresql: protocol.',
    });
  }

  if (
    databaseUrl
    && !isDirectPostgresUrl(databaseUrl)
    && !isRemotePrismaUrl(databaseUrl)
  ) {
    errors.push({
      key: String(env.PRISMA_DATABASE_URL || '').trim()
        ? 'PRISMA_DATABASE_URL'
        : 'DATABASE_URL',
      code: 'RUNTIME_DATABASE_URL_INVALID',
      envName,
      message: 'Runtime database URL must use postgres:, postgresql:, or prisma+postgres:.',
    });
  }

  checkRequired(env, envName, errors, databaseUrl, runtimeDatabaseUrlConflict);
  checkRecommended(env, envName, warnings);
  if (!runtimeDatabaseUrlConflict) {
    checkCrossFieldMisconfig(env, envName, warnings, errors, databaseUrl);
  }

  return {
    ok: errors.length === 0,
    env: envName,
    errors,
    warnings,
  };
}

function formatIssues(label, issues) {
  if (!issues.length) return '';
  const lines = issues.map((i) => `  - ${i.message}`).join('\n');
  return `${label}:\n${lines}\n`;
}

function validateConfigOrExit(env = process.env, opts = {}) {
  const result = validateConfig(env, opts);
  const logger = opts.logger || console;
  const envName = result.env;

  if (result.warnings.length) {
    logger.warn(
      `[config-validator] ${result.warnings.length} warning(s) for env=${envName}\n` +
        formatIssues('WARN', result.warnings),
    );
  }

  if (!result.ok) {
    logger.error(
      `[config-validator] ${result.errors.length} blocking error(s) for env=${envName}\n` +
        formatIssues('ERROR', result.errors) +
        '\nRefusing to boot. Fix the env vars above and retry.',
    );
    const failOnError =
      opts.failOnError !== undefined
        ? opts.failOnError
        : envName === 'production'
          || envName === 'staging'
          || result.errors.some((issue) => issue.code === 'NODE_ENV_INVALID_ALIAS');
    if (failOnError) {
      process.exit(1);
    }
  } else {
    logger.log(
      `[config-validator] ok env=${envName} required-ok=${
        (REQUIRED_BY_ENV[envName] || []).length
      } warnings=${result.warnings.length}`,
    );
  }
  return result;
}

module.exports = {
  validateConfig,
  validateConfigOrExit,
  resolveEnvName,
  REQUIRED_BY_ENV,
  RECOMMENDED_BY_ENV,
  // exported for tests
  _internal: { looksLikeLocalhost, resolveDatabaseUrl: resolveRuntimeDatabaseUrl },
};
