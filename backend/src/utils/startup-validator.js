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
    }
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

  issues.length = 0; // Reset

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

  // ─── Database URL ──────────────────────────────────────
  if (env.PRISMA_DATABASE_URL) {
    if (!env.PRISMA_DATABASE_URL.startsWith('postgresql://') &&
        !env.PRISMA_DATABASE_URL.startsWith('prisma+postgres://') &&
        !env.PRISMA_DATABASE_URL.startsWith('postgres://')) {
      issues.push({
        key: 'PRISMA_DATABASE_URL',
        label: 'Database URL',
        severity: Severity.BLOCKING,
        message: 'Database URL must start with postgresql://, postgres://, or prisma+postgres://',
      });
    }
  } else {
    issues.push({
      key: 'PRISMA_DATABASE_URL',
      label: 'Database URL',
      severity: Severity.BLOCKING,
      message: 'PRISMA_DATABASE_URL is required but not set.',
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

  // ─── CORS origins (important for security) ─────────────
  if (env.NODE_ENV === 'production' && (!env.CORS_ORIGINS || env.CORS_ORIGINS === '*')) {
    issues.push({
      key: 'CORS_ORIGINS',
      label: 'CORS Origins',
      severity: Severity.WARNING,
      message: 'CORS_ORIGINS is "*" in production. Restrict to specific origins.',
    });
  }

  // ─── API key format checks ─────────────────────────────
  checkApiKeyFormat('OPENAI_API_KEY', env.OPENAI_API_KEY, 'OpenAI API Key');
  if (env.STRIPE_SECRET_KEY) {
    checkApiKeyFormat('STRIPE_SECRET_KEY', env.STRIPE_SECRET_KEY, 'Stripe Secret Key');
  }

  // ─── Numeric range checks ──────────────────────────────
  checkNumeric('PORT', env.PORT, 1024, 65535, 'Port');
  checkNumeric('MAX_FILE_SIZE', env.MAX_FILE_SIZE, 1, 500, 'Max File Size (MB)');

  // ─── Production-specific checks ────────────────────────
  if (env.NODE_ENV === 'production') {
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
