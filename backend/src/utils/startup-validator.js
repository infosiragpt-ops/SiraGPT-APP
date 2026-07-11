// ──────────────────────────────────────────────────────────────
// siraGPT — Startup Validator
// ──────────────────────────────────────────────────────────────
// Runs during boot to catch common misconfigurations before the
// server starts accepting traffic. Checks are non-blocking (warn)
// or blocking (fail) depending on severity.
//
// BLOCKING failures exit the process with a clear message so
// operators catch the issue during deploy, not from user reports.
//
// NON-BLOCKING warnings log during boot and are also available
// via /health/details after startup.
// ──────────────────────────────────────────────────────────────

const crypto = require('crypto');
const {
  DATABASE_RUNTIME_URL_CONFLICT_CODE,
  DATABASE_DIRECT_URL_CONFLICT_CODE,
  DIRECT_DATABASE_URL_INVALID_CODE,
  isDirectPostgresUrl,
  isRemotePrismaUrl,
  resolveDirectMigrationDatabaseUrl,
  resolveRuntimeDatabaseUrl,
} = require('../config/database-url');
const { resolveSensitiveRateLimitPolicy } = require('../middleware/rate-limit-policy');
const {
  hasWildcardOrigin,
  validateAllowedOrigins,
} = require('../middleware/cors-policy');
const {
  isInvalidEnvironmentAlias,
  isProductionLike,
} = require('./environment');

// Known placeholder patterns — matches both obvious examples and
// common copy-paste defaults that should never reach production.
const PLACEHOLDER_PATTERNS = [
  /^change.me$/i,
  /^your-.*-here$/i,
  /^your-.*-secret$/i,
  /^change-this/i,
  /^placeholder/i,
  /^changeme$/i,
  /^your-super-secret/i,
  /^your-session-secret$/i,
  /^ci-dummy/i,
  /^sk-ci-/i,
  /^sk-ant-/i,
  /^sk-pro-/i,      // Real OpenAI keys start with sk-proj- or sk-svc-
  /^replace[._-]?me$/i, // REPLACE_ME, replace-me, replace.me
  /-here$/i,            // google-client-id-here, anything ending in -here
  /^<.*>$/,             // <google_client_id> angle-bracket placeholders
  /^your[._-]google/i,  // your-google-client-id, your_google_client_secret
  /^google[._-]client/i, // google-client-id, google-client-secret
  /^example/i,          // example, example-value
];

// Severity levels
const Severity = {
  BLOCKING: 'BLOCKING',
  WARNING: 'WARNING',
  INFO: 'INFO',
};

const issues = [];

function checkRequired(key, value, label) {
  if (!value || value.trim() === '') {
    issues.push({
      key,
      label: label || key,
      severity: Severity.BLOCKING,
      message: `${label || key} is required but not set. Add it to your .env file.`,
    });
    return false;
  }
  return true;
}

function checkPlaceholder(key, value, label) {
  if (!value) return;
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(value.trim())) {
      issues.push({
        key,
        label: label || key,
        severity: Severity.BLOCKING,
        message: `${label || key} has a placeholder value and is insecure. Generate a strong random value.`,
        hint: `Run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      });
      return;
    }
  }
}

function checkLength(key, value, minLen, label) {
  if (!value) return;
  if (value.length < minLen) {
    issues.push({
      key,
      label: label || key,
      severity: Severity.WARNING,
      message: `${label || key} is too short (${value.length} chars, minimum ${minLen}).`,
    });
  }
}

function checkEntropy(key, value, label) {
  if (!value || value.length < 16) return;
  // Simple entropy check: if it's a common English word or very low entropy
  const chars = new Set(value);
  if (chars.size < 8 && /^[a-z]+$/i.test(value)) {
    issues.push({
      key,
      label: label || key,
      severity: Severity.WARNING,
      message: `${label || key} has low entropy (only ${chars.size} unique characters, all letters).`,
    });
  }
}

function checkApiKeyFormat(key, value, label) {
  if (!value) return;
  // OpenAI keys
  if (key.includes('OPENAI') && !key.startsWith('NEXT_PUBLIC_')) {
    if (!/^sk-(proj-|svc-|sana-)/.test(value) && value !== 'sk-ci-dummy-key-for-test') {
      issues.push({
        key,
        label: label || key,
        severity: Severity.WARNING,
        message: `${label || key} format looks unusual. Expected 'sk-proj-...' or 'sk-svc-...'.`,
      });
    }
  }
  // Stripe keys
  if ((key.includes('STRIPE') && key.endsWith('_KEY'))) {
    if (!/^(sk|rk)_(test|live)_/.test(value)) {
      issues.push({
        key,
        label: label || key,
        severity: Severity.WARNING,
        message: `${label || key} format looks unusual. Expected 'sk_test_...', 'sk_live_...', 'rk_test_...', or 'rk_live_...'.`,
      });
    } else if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(value)) {
      issues.push({
        key,
        label: label || key,
        severity: Severity.WARNING,
        message: `${label || key} looks masked or malformed. Paste the full Stripe secret/restricted key, not a redacted dashboard value.`,
      });
    }
  }
}

function checkGoogleClientIdFormat(key, value, label) {
  if (!value || value.trim() === '') return;
  const trimmed = value.trim();
  // Real Google OAuth Client IDs always end in this suffix. A value that
  // passes the placeholder check but lacks the suffix is very likely a fake
  // or hand-edited value that will fail at the authorization step.
  if (!trimmed.endsWith('.apps.googleusercontent.com')) {
    issues.push({
      key,
      label: label || key,
      severity: Severity.WARNING,
      message: `${label || key} doesn't look like a real Google Client ID. Real values end in ".apps.googleusercontent.com".`,
    });
  }
}

function checkNumeric(key, value, min, max, label) {
  if (!value) return;
  const num = parseInt(value, 10);
  if (isNaN(num)) {
    issues.push({
      key,
      label: label || key,
      severity: Severity.WARNING,
      message: `${label || key} should be a number, got "${value}".`,
    });
  } else if (num < min || num > max) {
    issues.push({
      key,
      label: label || key,
      severity: Severity.WARNING,
      message: `${label || key} is ${num}, expected between ${min} and ${max}.`,
    });
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Run all startup validations against process.env.
 * Logs warnings and returns the issue list.
 *
 * @param {object} env - process.env or a mock for testing
 * @param {object} [options]
 * @param {boolean} [options.failOnBlocking=true] - process.exit(1) on blocking issues
 * @returns {Array<{key, label, severity, message, hint?}>}
 */
function validateStartupEnvironment(env = process.env, options = {}) {
  const { failOnBlocking = true } = options;
  const production = isProductionLike(env);

  issues.length = 0; // Reset

  if (isInvalidEnvironmentAlias(env)) {
    issues.push({
      key: 'NODE_ENV',
      code: 'NODE_ENV_INVALID_ALIAS',
      label: 'Runtime environment',
      severity: Severity.BLOCKING,
      message: 'NODE_ENV uses an unsupported alias; use the literal production environment name.',
    });
  }

  // ─── Required secrets (blocking if missing) ─────────────
  checkRequired('JWT_SECRET', env.JWT_SECRET, 'JWT Secret');
  checkRequired('SESSION_SECRET', env.SESSION_SECRET, 'Session Secret');

  // ─── Placeholder detection (blocking) ───────────────────
  checkPlaceholder('JWT_SECRET', env.JWT_SECRET, 'JWT Secret');
  checkPlaceholder('SESSION_SECRET', env.SESSION_SECRET, 'Session Secret');

  // ─── Length checks ─────────────────────────────────────
  checkLength('JWT_SECRET', env.JWT_SECRET, 32, 'JWT Secret');
  checkLength('SESSION_SECRET', env.SESSION_SECRET, 32, 'Session Secret');

  // ─── Entropy checks ────────────────────────────────────
  checkEntropy('JWT_SECRET', env.JWT_SECRET, 'JWT Secret');
  checkEntropy('SESSION_SECRET', env.SESSION_SECRET, 'Session Secret');

  // ─── RBAC rollout mode ─────────────────────────────────
  // Production defaults to enforce when omitted. An explicit value must use
  // the two-state contract; never echo the supplied value into diagnostics.
  if (
    env.RBAC_ENFORCEMENT_MODE != null
    && !['shadow', 'enforce'].includes(String(env.RBAC_ENFORCEMENT_MODE).trim().toLowerCase())
  ) {
    issues.push({
      key: 'RBAC_ENFORCEMENT_MODE',
      code: 'RBAC_ENFORCEMENT_MODE_INVALID',
      label: 'RBAC enforcement mode',
      severity: production ? Severity.BLOCKING : Severity.WARNING,
      message: 'RBAC_ENFORCEMENT_MODE must be either shadow or enforce.',
    });
  }

  // ─── Database URL ──────────────────────────────────────
  let databaseUrl = null;
  let databaseUrlConflict = false;
  try {
    databaseUrl = resolveRuntimeDatabaseUrl(env);
  } catch (error) {
    databaseUrlConflict = true;
    issues.push({
      key: 'PRISMA_DATABASE_URL',
      code: DATABASE_RUNTIME_URL_CONFLICT_CODE,
      label: 'Database URL',
      severity: Severity.BLOCKING,
      message: 'Conflicting runtime database URL aliases are configured. Refusing to choose between them.',
    });
  }
  try {
    resolveDirectMigrationDatabaseUrl(env);
  } catch (error) {
    const code = error?.code === DATABASE_DIRECT_URL_CONFLICT_CODE
      ? DATABASE_DIRECT_URL_CONFLICT_CODE
      : DIRECT_DATABASE_URL_INVALID_CODE;
    issues.push({
      key: 'DIRECT_DATABASE_URL',
      code,
      label: 'Direct migration database URL',
      severity: Severity.BLOCKING,
      message: code === DATABASE_DIRECT_URL_CONFLICT_CODE
        ? 'Conflicting direct migration database URL aliases are configured.'
        : 'DIRECT_DATABASE_URL must use the postgres: or postgresql: protocol.',
    });
  }
  if (databaseUrl) {
    if (!isDirectPostgresUrl(databaseUrl) && !isRemotePrismaUrl(databaseUrl)) {
      issues.push({
        key: 'PRISMA_DATABASE_URL',
        code: 'RUNTIME_DATABASE_URL_INVALID',
        label: 'Database URL',
        severity: Severity.BLOCKING,
        message: 'Runtime database URL must start with postgresql://, postgres://, or prisma+postgres://',
      });
    }
  } else if (!databaseUrlConflict) {
    issues.push({
      key: 'PRISMA_DATABASE_URL',
      label: 'Database URL',
      severity: Severity.BLOCKING,
      message: 'PRISMA_DATABASE_URL (or DATABASE_URL fallback) is required but not set.',
    });
  }

  // ─── Redis check (warning only) ────────────────────────
  if (!env.REDIS_URL) {
    issues.push({
      key: 'REDIS_URL',
      label: 'Redis URL',
      severity: Severity.WARNING,
      message: 'Redis URL not set. Agent tasks, rate limiting, and queue operations will not work.',
    });
  }

  const sensitiveRateLimitPolicy = resolveSensitiveRateLimitPolicy(env);
  if (!sensitiveRateLimitPolicy.valid) {
    issues.push({
      key: 'RATE_LIMIT_SENSITIVE_POLICY',
      code: 'SENSITIVE_RATE_LIMIT_POLICY_INVALID',
      label: 'Sensitive rate-limit policy',
      severity: production ? Severity.BLOCKING : Severity.WARNING,
      message: 'Sensitive rate-limit policy is invalid.',
      hint: 'Use distributed in production; memory and fail-open are restricted to local/test environments.',
    });
  }
  if (production) {
    if (!env.REDIS_URL) {
      issues.push({
        key: 'REDIS_URL',
        code: 'SENSITIVE_RATE_LIMIT_REDIS_REQUIRED',
        label: 'Sensitive rate-limit distributed store',
        severity: Severity.BLOCKING,
        message: 'Production sensitive rate limits require a configured distributed store.',
      });
    }
    if (String(env.RATE_LIMIT_STORE || '').trim().toLowerCase() === 'memory') {
      issues.push({
        key: 'RATE_LIMIT_STORE',
        code: 'SENSITIVE_RATE_LIMIT_STORE_UNSAFE',
        label: 'Rate-limit store',
        severity: Severity.BLOCKING,
        message: 'Production sensitive rate limits cannot use process-local storage.',
      });
    }
    if (
      sensitiveRateLimitPolicy.valid
      && sensitiveRateLimitPolicy.configuredMode !== 'distributed'
    ) {
      issues.push({
        key: 'RATE_LIMIT_SENSITIVE_POLICY',
        code: 'SENSITIVE_RATE_LIMIT_POLICY_UNSAFE',
        label: 'Sensitive rate-limit policy',
        severity: Severity.BLOCKING,
        message: 'Production sensitive rate limits must fail closed on distributed-store errors.',
      });
    }
  }

  // ─── CORS origins (important for security) ─────────────
  const corsOrigins = String(env.CORS_ORIGINS || '').trim();
  if (production && !corsOrigins) {
    issues.push({
      key: 'CORS_ORIGINS',
      code: 'CORS_ORIGINS_REQUIRED',
      label: 'CORS Origins',
      severity: Severity.BLOCKING,
      message: 'Production requires an explicit CORS_ORIGINS allowlist.',
    });
  }
  if (production && hasWildcardOrigin(corsOrigins)) {
    issues.push({
      key: 'CORS_ORIGINS',
      code: 'CORS_WILDCARD_CREDENTIALS_FORBIDDEN',
      label: 'CORS Origins',
      severity: Severity.BLOCKING,
      message: 'Credentialed CORS cannot use a wildcard origin in production.',
    });
  } else if (production && corsOrigins) {
    try {
      validateAllowedOrigins(
        corsOrigins.split(',').map((origin) => origin.trim()).filter(Boolean),
      );
    } catch (_error) {
      issues.push({
        key: 'CORS_ORIGINS',
        code: 'CORS_ORIGINS_INVALID',
        label: 'CORS Origins',
        severity: Severity.BLOCKING,
        message: 'Production CORS_ORIGINS contains an invalid origin.',
      });
    }
  }
  if (
    production
    && ['1', 'true'].includes(String(env.CSRF_DISABLED || '').trim().toLowerCase())
  ) {
    issues.push({
      key: 'CSRF_DISABLED',
      code: 'CSRF_DISABLED_IN_PRODUCTION',
      label: 'CSRF protection',
      severity: Severity.BLOCKING,
      message: 'CSRF protection cannot be disabled in production.',
    });
  }

  // ─── Google OAuth credentials ──────────────────────────
  // Warn when only one of the paired credentials is present — OAuth
  // will fail at either the authorization or token-exchange step.
  const hasGoogleClientId = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_ID.trim());
  const hasGoogleClientSecret = !!(env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CLIENT_SECRET.trim());

  if (hasGoogleClientId && !hasGoogleClientSecret) {
    issues.push({
      key: 'GOOGLE_CLIENT_SECRET',
      label: 'Google Client Secret',
      severity: Severity.WARNING,
      message: 'GOOGLE_CLIENT_ID is set but GOOGLE_CLIENT_SECRET is missing. Google OAuth logins will fail at the token exchange step.',
    });
  }
  if (!hasGoogleClientId && hasGoogleClientSecret) {
    issues.push({
      key: 'GOOGLE_CLIENT_ID',
      label: 'Google Client ID',
      severity: Severity.WARNING,
      message: 'GOOGLE_CLIENT_SECRET is set but GOOGLE_CLIENT_ID is missing. Google OAuth logins will fail at the authorization step.',
    });
  }

  checkPlaceholder('GOOGLE_CLIENT_ID', env.GOOGLE_CLIENT_ID, 'Google Client ID');
  checkPlaceholder('GOOGLE_CLIENT_SECRET', env.GOOGLE_CLIENT_SECRET, 'Google Client Secret');

  // Format hint: real Google Client IDs end in .apps.googleusercontent.com.
  // Skip when the value already matched a placeholder pattern above to avoid
  // a redundant double-warning on the same key.
  if (hasGoogleClientId && !issues.some(i => i.key === 'GOOGLE_CLIENT_ID')) {
    checkGoogleClientIdFormat('GOOGLE_CLIENT_ID', env.GOOGLE_CLIENT_ID, 'Google Client ID');
  }

  // ─── API key format checks ─────────────────────────────
  checkApiKeyFormat('OPENAI_API_KEY', env.OPENAI_API_KEY, 'OpenAI API Key');
  if (env.STRIPE_SECRET_KEY) {
    checkApiKeyFormat('STRIPE_SECRET_KEY', env.STRIPE_SECRET_KEY, 'Stripe Secret Key');
  }

  // ─── Numeric range checks ──────────────────────────────
  checkNumeric('PORT', env.PORT, 1024, 65535, 'Port');
  checkNumeric('MAX_FILE_SIZE', env.MAX_FILE_SIZE, 1, 500, 'Max File Size (MB)');

  // ─── Observability checks (warning only) ───────────────
  if (!env.SENTRY_DSN) {
    issues.push({
      key: 'SENTRY_DSN',
      label: 'Sentry DSN',
      severity: Severity.WARNING,
      message: 'SENTRY_DSN is not set. Runtime errors in production will be invisible. Add a Sentry DSN to enable automatic error alerts.',
      hint: 'Sign up at https://sentry.io, create a Node.js project, and copy the DSN into your Replit Secrets as SENTRY_DSN.',
    });
  }

  // ─── Production-specific checks ────────────────────────
  if (production) {
    if (!env.CORS_ORIGINS || env.CORS_ORIGINS === '*') {
      // Already warned above — this is an extra nudge
    }
    if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) {
      // Already warned above
    }
  }

  // ─── Log results ───────────────────────────────────────
  const { logger } = require('../middleware/logger');
  const blocking = issues.filter(i => i.severity === Severity.BLOCKING);
  const warnings = issues.filter(i => i.severity === Severity.WARNING);

  if (issues.length === 0) {
    logger.info('[startup-validator] All environment checks passed');
    return issues;
  }

  for (const issue of issues) {
    const fn = issue.severity === Severity.BLOCKING ? logger.error : issue.severity === Severity.WARNING ? logger.warn : logger.info;
    fn.call(logger, `[startup-validator] [${issue.severity}] ${issue.message}${issue.hint ? `\n  Hint: ${issue.hint}` : ''}`);
  }

  if (blocking.length > 0) {
    logger.error(`[startup-validator] ${blocking.length} blocking issue(s) found — aborting startup`);

    // Also write to stderr directly so it shows even if logger is broken
    for (const issue of blocking) {
      console.error(`[FATAL] ${issue.message}`);
      if (issue.hint) console.error(`  → ${issue.hint}`);
    }

    if (failOnBlocking) {
      process.exitCode = 1;
      // Small delay so logs flush before exit
      setTimeout(() => process.exit(1), 100).unref();
    }
  } else {
    logger.warn(`[startup-validator] ${warnings.length} warning(s) — review before production deploy`);
  }

  return issues;
}

/**
 * Returns the list of issues found during validation (post-run).
 */
function getValidationIssues() {
  return [...issues];
}

module.exports = {
  validateStartupEnvironment,
  getValidationIssues,
  Severity,
};
