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
//     (e.g. NODE_ENV=production + DATABASE_URL points to localhost)
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

// Per-environment required vars. Kept small & realistic — anything
// the app cannot serve real traffic without. Optional integrations
// live in RECOMMENDED.
const REQUIRED_BY_ENV = {
  development: [
    'DATABASE_URL',
  ],
  test: [
    // tests typically inject their own fixtures
  ],
  staging: [
    'DATABASE_URL',
    'SESSION_SECRET',
    'JWT_SECRET',
  ],
  production: [
    'DATABASE_URL',
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
  const raw = String(env.NODE_ENV || '').toLowerCase().trim();
  if (raw === 'production' || raw === 'prod') return 'production';
  if (raw === 'staging' || raw === 'stage') return 'staging';
  if (raw === 'test') return 'test';
  return 'development';
}

function looksLikeLocalhost(value) {
  if (!value || typeof value !== 'string') return false;
  return LOCALHOST_PATTERNS.some((re) => re.test(value));
}

function checkRequired(env, envName, errors) {
  const required = REQUIRED_BY_ENV[envName] || [];
  for (const key of required) {
    const v = env[key];
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

function checkCrossFieldMisconfig(env, envName, warnings, errors) {
  // Prod DB pointing at localhost is almost certainly a mistake.
  if (envName === 'production' && looksLikeLocalhost(env.DATABASE_URL)) {
    errors.push({
      key: 'DATABASE_URL',
      envName,
      message:
        'NODE_ENV=production but DATABASE_URL points to localhost. ' +
        'This is almost certainly wrong — refusing to boot.',
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
  // CORS wide-open in prod
  if (envName === 'production' && String(env.CORS_ORIGIN || '').trim() === '*') {
    warnings.push({
      key: 'CORS_ORIGIN',
      envName,
      message: 'CORS_ORIGIN="*" in production is dangerous — pin to your domains.',
    });
  }
}

function validateConfig(env = process.env, opts = {}) {
  const envName = opts.envName || resolveEnvName(env);
  const errors = [];
  const warnings = [];

  checkRequired(env, envName, errors);
  checkRecommended(env, envName, warnings);
  checkCrossFieldMisconfig(env, envName, warnings, errors);

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
        : envName === 'production' || envName === 'staging';
    if (failOnError) {
      // eslint-disable-next-line n/no-process-exit
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
  _internal: { looksLikeLocalhost },
};
