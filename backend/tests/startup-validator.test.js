/**
 * Tests for startup-validator.js — pre-boot environment sanity checks.
 *
 * All tests pass `failOnBlocking: false` so the validator doesn't call
 * process.exit() under the test runner.
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  validateStartupEnvironment,
  getValidationIssues,
  Severity,
} = require('../src/utils/startup-validator');

// Mute the pino logger so the test output stays readable. The
// validator pulls the logger at call-time via require, so we can swap
// its methods after module load.
const { logger } = require('../src/middleware/logger');
const _origLogger = {
  info: logger.info.bind(logger),
  warn: logger.warn.bind(logger),
  error: logger.error.bind(logger),
};
function muteLogger() {
  logger.info = () => {};
  logger.warn = () => {};
  logger.error = () => {};
}
function restoreLogger() {
  logger.info = _origLogger.info;
  logger.warn = _origLogger.warn;
  logger.error = _origLogger.error;
}

// Also mute stderr direct writes that fire on blocking issues.
const _origConsoleError = console.error;

function strongSecret() {
  // 64-char hex string — long enough to clear both length and entropy
  // checks, no placeholder pattern matches.
  return 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
}

function happyEnv(overrides = {}) {
  return {
    JWT_SECRET: strongSecret(),
    SESSION_SECRET: strongSecret(),
    PRISMA_DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    NODE_ENV: 'development',
    CORS_ORIGINS: 'http://localhost:3000',
    SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
    ...overrides,
  };
}

function runValidator(env) {
  muteLogger();
  console.error = () => {};
  try {
    return validateStartupEnvironment(env, { failOnBlocking: false });
  } finally {
    restoreLogger();
    console.error = _origConsoleError;
  }
}

// ── Severity enum surface ─────────────────────────────────────────

describe('Severity', () => {
  it('exposes the three documented levels', () => {
    assert.deepEqual(Severity, {
      BLOCKING: 'BLOCKING',
      WARNING: 'WARNING',
      INFO: 'INFO',
    });
  });
});

// ── Happy path ────────────────────────────────────────────────────

describe('validateStartupEnvironment · happy path', () => {
  it('passes a fully-configured development env with no issues', () => {
    const issues = runValidator(happyEnv());
    assert.deepEqual(issues, [], `unexpected issues: ${JSON.stringify(issues, null, 2)}`);
  });

  it('defaults RBAC enforcement to shadow outside production', () => {
    const issues = runValidator(happyEnv({ RBAC_ENFORCEMENT_MODE: undefined }));
    assert.equal(
      issues.some((issue) => issue.key === 'RBAC_ENFORCEMENT_MODE'),
      false,
    );
  });

  it('accepts postgres:// (no -ql suffix) for database URL', () => {
    const issues = runValidator(happyEnv({
      PRISMA_DATABASE_URL: 'postgres://user@host/db',
    }));
    assert.equal(issues.filter(i => i.key === 'PRISMA_DATABASE_URL').length, 0);
  });

  it('accepts prisma+postgres:// for database URL', () => {
    const issues = runValidator(happyEnv({
      PRISMA_DATABASE_URL: 'prisma+postgres://accelerate.prisma-data.net/?api_key=xxx',
    }));
    assert.equal(issues.filter(i => i.key === 'PRISMA_DATABASE_URL').length, 0);
  });
});

describe('validateStartupEnvironment · NODE_ENV', () => {
  it('blocks the prod alias without reflecting the configured value', () => {
    const issues = runValidator(happyEnv({ NODE_ENV: 'prod' }));
    const issue = issues.find((entry) => entry.code === 'NODE_ENV_INVALID_ALIAS');
    assert.ok(issue);
    assert.equal(issue.key, 'NODE_ENV');
    assert.equal(issue.severity, Severity.BLOCKING);
    assert.equal(Object.hasOwn(issue, 'value'), false);
    assert.doesNotMatch(issue.message, /NODE_ENV\s*=\s*prod/i);
  });
});

describe('validateStartupEnvironment · RBAC enforcement mode', () => {
  it('accepts explicit shadow and enforce modes', () => {
    for (const mode of ['shadow', 'enforce']) {
      const issues = runValidator(happyEnv({ RBAC_ENFORCEMENT_MODE: mode }));
      assert.equal(
        issues.some((issue) => issue.key === 'RBAC_ENFORCEMENT_MODE'),
        false,
        `unexpected RBAC issue for ${mode}`,
      );
    }
  });

  it('treats an invalid production mode as a blocking boot failure', () => {
    const result = runValidator(happyEnv({
      NODE_ENV: 'production',
      RBAC_ENFORCEMENT_MODE: 'permissive',
    }));
    const issue = result.find((entry) => entry.key === 'RBAC_ENFORCEMENT_MODE');
    assert.ok(issue);
    assert.equal(issue.code, 'RBAC_ENFORCEMENT_MODE_INVALID');
    assert.equal(issue.severity, 'BLOCKING');
    assert.doesNotMatch(issue.message, /permissive/);
  });
});

// ── Required-secret missing → BLOCKING ────────────────────────────

describe('validateStartupEnvironment · missing required secrets', () => {
  it('flags missing JWT_SECRET as BLOCKING', () => {
    const issues = runValidator(happyEnv({ JWT_SECRET: '' }));
    const jwt = issues.find(i => i.key === 'JWT_SECRET');
    assert.ok(jwt, 'expected a JWT_SECRET issue');
    assert.equal(jwt.severity, 'BLOCKING');
  });

  it('flags missing SESSION_SECRET as BLOCKING', () => {
    const issues = runValidator(happyEnv({ SESSION_SECRET: undefined }));
    const ses = issues.find(i => i.key === 'SESSION_SECRET');
    assert.ok(ses);
    assert.equal(ses.severity, 'BLOCKING');
  });

  it('treats whitespace-only secrets as missing', () => {
    const issues = runValidator(happyEnv({ JWT_SECRET: '   \t  ' }));
    const jwt = issues.find(
      i => i.key === 'JWT_SECRET' && i.message.includes('required'),
    );
    assert.ok(jwt, 'whitespace-only should be flagged as required');
  });
});

// ── Placeholder detection ─────────────────────────────────────────

describe('validateStartupEnvironment · placeholder detection', () => {
  const placeholders = [
    'change.me',
    'your-secret-here',
    'your-jwt-secret',
    'change-this-secret-now',
    'placeholder',
    'changeme',
    'your-super-secret-jwt-key',
    'your-session-secret',
    'ci-dummy-secret',
    'sk-ci-dummy-key',
  ];

  for (const ph of placeholders) {
    it(`flags placeholder "${ph}" on JWT_SECRET as BLOCKING`, () => {
      const issues = runValidator(happyEnv({ JWT_SECRET: ph }));
      const flagged = issues.find(
        i => i.key === 'JWT_SECRET' && i.severity === 'BLOCKING' && i.message.includes('placeholder'),
      );
      assert.ok(flagged, `expected placeholder flag for "${ph}"`);
    });
  }

  it('placeholder check is case-insensitive', () => {
    const issues = runValidator(happyEnv({ JWT_SECRET: 'CHANGEME' }));
    const flagged = issues.find(
      i => i.key === 'JWT_SECRET' && i.message.includes('placeholder'),
    );
    assert.ok(flagged);
  });

  it('a placeholder value also includes a hint', () => {
    const issues = runValidator(happyEnv({ JWT_SECRET: 'changeme' }));
    const flagged = issues.find(
      i => i.key === 'JWT_SECRET' && i.message.includes('placeholder'),
    );
    assert.ok(flagged.hint, 'expected hint on placeholder issue');
    assert.match(flagged.hint, /randomBytes/);
  });
});

// ── Google OAuth credential placeholders ─────────────────────────

describe('validateStartupEnvironment · Google credential placeholders', () => {
  const googlePlaceholders = [
    'your-google-client-id',
    'your_google_client_secret',
    'google-client-id-here',
    'google-client-secret',
    '<google_client_id>',
    'REPLACE_ME',
    'replace-me',
    'example-value',
    'changeme',
  ];

  for (const ph of googlePlaceholders) {
    it(`flags placeholder "${ph}" on GOOGLE_CLIENT_ID as BLOCKING`, () => {
      const issues = runValidator(happyEnv({ GOOGLE_CLIENT_ID: ph }));
      const flagged = issues.find(
        i => i.key === 'GOOGLE_CLIENT_ID' && i.severity === 'BLOCKING' && i.message.includes('placeholder'),
      );
      assert.ok(flagged, `expected placeholder flag for "${ph}"`);
    });

    it(`flags placeholder "${ph}" on GOOGLE_CLIENT_SECRET as BLOCKING`, () => {
      const issues = runValidator(happyEnv({ GOOGLE_CLIENT_SECRET: ph }));
      const flagged = issues.find(
        i => i.key === 'GOOGLE_CLIENT_SECRET' && i.severity === 'BLOCKING' && i.message.includes('placeholder'),
      );
      assert.ok(flagged, `expected placeholder flag for "${ph}"`);
    });
  }

  it('does not flag a real-looking Google Client ID as a placeholder', () => {
    const issues = runValidator(happyEnv({
      GOOGLE_CLIENT_ID: '1234567890-abcdefghijklmnop.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'GOCSPX-AbCdEf0123456789GhIjKl',
    }));
    const flagged = issues.find(
      i => (i.key === 'GOOGLE_CLIENT_ID' || i.key === 'GOOGLE_CLIENT_SECRET'),
    );
    assert.equal(flagged, undefined);
  });

  it('warns when GOOGLE_CLIENT_ID lacks the .apps.googleusercontent.com suffix', () => {
    const issues = runValidator(happyEnv({
      GOOGLE_CLIENT_ID: '1234567890-abcdefghijklmnop',
      GOOGLE_CLIENT_SECRET: 'GOCSPX-AbCdEf0123456789GhIjKl',
    }));
    const flagged = issues.find(
      i => i.key === 'GOOGLE_CLIENT_ID' && i.message.includes('googleusercontent.com'),
    );
    assert.ok(flagged, 'expected a format warning');
    assert.equal(flagged.severity, 'WARNING');
  });

  it('does not warn on the suffix for a valid Google Client ID', () => {
    const issues = runValidator(happyEnv({
      GOOGLE_CLIENT_ID: '1234567890-abcdefghijklmnop.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'GOCSPX-AbCdEf0123456789GhIjKl',
    }));
    const flagged = issues.find(
      i => i.key === 'GOOGLE_CLIENT_ID' && i.message.includes('googleusercontent.com'),
    );
    assert.equal(flagged, undefined);
  });

  it('does not double-flag: placeholder Client ID gets one issue, not also a format warning', () => {
    const issues = runValidator(happyEnv({ GOOGLE_CLIENT_ID: 'your-google-client-id' }));
    const idIssues = issues.filter(i => i.key === 'GOOGLE_CLIENT_ID');
    assert.equal(idIssues.length, 1);
    assert.equal(idIssues[0].severity, 'BLOCKING');
  });
});

// ── Length checks ─────────────────────────────────────────────────

describe('validateStartupEnvironment · length checks', () => {
  it('warns on JWT_SECRET shorter than 32 chars', () => {
    const issues = runValidator(happyEnv({ JWT_SECRET: 'short-but-not-placeholder' }));
    const len = issues.find(
      i => i.key === 'JWT_SECRET' && i.message.includes('too short'),
    );
    assert.ok(len);
    assert.equal(len.severity, 'WARNING');
  });

  it('does not warn on JWT_SECRET of exactly 32 chars', () => {
    const issues = runValidator(happyEnv({ JWT_SECRET: 'a'.repeat(32) + 'b' }));
    // 33-char secret of repeats will fail entropy though.
    // Use a wider-character but exactly-32 string.
    const issues2 = runValidator(happyEnv({
      JWT_SECRET: 'aB3$cD4%eF5^gH6&iJ7*kL8(mN9)oP1',  // 31 chars (off-by-one check)
    }));
    const len = issues2.find(
      i => i.key === 'JWT_SECRET' && i.message.includes('too short'),
    );
    assert.ok(len, '31 chars should fail');
  });
});

// ── Entropy check ─────────────────────────────────────────────────

describe('validateStartupEnvironment · entropy check', () => {
  it('warns on low-entropy all-letter secret (< 8 unique chars)', () => {
    // 16+ chars, all from a small alphabet of letters.
    const issues = runValidator(happyEnv({
      JWT_SECRET: 'abcabcabcabcabcabcabc',  // 21 chars, 3 unique, all letters
    }));
    const entropy = issues.find(
      i => i.key === 'JWT_SECRET' && i.message.includes('low entropy'),
    );
    assert.ok(entropy);
    assert.equal(entropy.severity, 'WARNING');
  });

  it('does not warn on a hex-encoded secret', () => {
    const issues = runValidator(happyEnv({ JWT_SECRET: strongSecret() }));
    const entropy = issues.find(
      i => i.key === 'JWT_SECRET' && i.message.includes('low entropy'),
    );
    assert.equal(entropy, undefined);
  });
});

// ── Database URL checks ───────────────────────────────────────────

describe('validateStartupEnvironment · PRISMA_DATABASE_URL', () => {
  it('flags missing PRISMA_DATABASE_URL as BLOCKING', () => {
    const issues = runValidator(happyEnv({ PRISMA_DATABASE_URL: undefined }));
    const db = issues.find(i => i.key === 'PRISMA_DATABASE_URL');
    assert.ok(db);
    assert.equal(db.severity, 'BLOCKING');
    assert.match(db.message, /required/);
  });

  it('flags invalid scheme as BLOCKING', () => {
    const issues = runValidator(happyEnv({
      PRISMA_DATABASE_URL: 'mysql://user:pass@host/db',
    }));
    const db = issues.find(i => i.key === 'PRISMA_DATABASE_URL');
    assert.ok(db);
    assert.equal(db.severity, 'BLOCKING');
    assert.match(db.message, /postgresql:\/\/|postgres:\/\//);
  });

  it('accepts DATABASE_URL as a fallback when the canonical variable is absent', () => {
    const issues = runValidator(happyEnv({
      PRISMA_DATABASE_URL: undefined,
      DATABASE_URL: '  postgres://fallback.internal/app  ',
    }));
    assert.equal(issues.some(i => i.key === 'PRISMA_DATABASE_URL'), false);
  });

  it('accepts an Accelerate runtime URL with a separate direct migration URL', () => {
    const issues = runValidator(happyEnv({
      PRISMA_DATABASE_URL: 'prisma+postgres://accelerate.prisma-data.net/?api_key=runtime-secret',
      DIRECT_DATABASE_URL: 'postgresql://migration-user:migration-secret@db.internal/app',
      DATABASE_URL: undefined,
    }));

    assert.equal(issues.some(i => i.key === 'PRISMA_DATABASE_URL'), false);
    assert.equal(issues.some(i => i.key === 'DIRECT_DATABASE_URL'), false);
  });

  it('blocks same-role runtime aliases without logging either value', () => {
    const issues = runValidator(happyEnv({
      PRISMA_DATABASE_URL: 'prisma+postgres://runtime-a.invalid/?api_key=runtime-secret-a',
      DATABASE_URL: 'prisma+postgres://runtime-b.invalid/?api_key=runtime-secret-b',
      DIRECT_DATABASE_URL: 'postgresql://migration-user:migration-secret@db.internal/app',
    }));
    const db = issues.find(i => i.code === 'DATABASE_RUNTIME_URL_CONFLICT');

    assert.ok(db);
    assert.equal(db.severity, 'BLOCKING');
    assert.doesNotMatch(
      JSON.stringify(db),
      /runtime-a|runtime-b|runtime-secret|migration-user|migration-secret|db\.internal/,
    );
  });

  it('blocks an invalid direct migration scheme without logging its value', () => {
    const issues = runValidator(happyEnv({
      PRISMA_DATABASE_URL: 'prisma+postgres://accelerate.prisma-data.net/?api_key=runtime-secret',
      DIRECT_DATABASE_URL: 'mysql://migration-user:migration-secret@db.internal/app',
      DATABASE_URL: undefined,
    }));
    const db = issues.find(i => i.code === 'DIRECT_DATABASE_URL_INVALID');

    assert.ok(db);
    assert.equal(db.severity, 'BLOCKING');
    assert.doesNotMatch(
      JSON.stringify(db),
      /runtime-secret|migration-user|migration-secret|db\.internal/,
    );
  });

  it('blocks divergent aliases without logging either database URL', () => {
    const issues = runValidator(happyEnv({
      PRISMA_DATABASE_URL: 'postgres://canonical-user:canonical-secret@primary.internal/app',
      DATABASE_URL: 'postgres://legacy-user:legacy-secret@legacy.internal/app',
    }));
    const db = issues.find(i => i.code === 'DATABASE_RUNTIME_URL_CONFLICT');
    assert.ok(db);
    assert.equal(db.severity, 'BLOCKING');
    assert.doesNotMatch(
      JSON.stringify(db),
      /canonical-user|canonical-secret|primary\.internal|legacy-user|legacy-secret|legacy\.internal/,
    );
  });
});

// ── Redis check ───────────────────────────────────────────────────

describe('validateStartupEnvironment · REDIS_URL', () => {
  it('warns when REDIS_URL is not set', () => {
    const issues = runValidator(happyEnv({ REDIS_URL: undefined }));
    const redis = issues.find(i => i.key === 'REDIS_URL');
    assert.ok(redis);
    assert.equal(redis.severity, 'WARNING');
  });

  it('no warning when REDIS_URL is set', () => {
    const issues = runValidator(happyEnv({ REDIS_URL: 'redis://localhost' }));
    const redis = issues.find(i => i.key === 'REDIS_URL');
    assert.equal(redis, undefined);
  });

  it('blocks production when sensitive limiters have no distributed store', () => {
    const issues = runValidator(happyEnv({
      NODE_ENV: 'production',
      REDIS_URL: undefined,
      RATE_LIMIT_STORE: 'redis',
    }));
    const issue = issues.find(i => i.code === 'SENSITIVE_RATE_LIMIT_REDIS_REQUIRED');
    assert.ok(issue);
    assert.equal(issue.severity, Severity.BLOCKING);
    assert.doesNotMatch(JSON.stringify(issue), /redis:\/\//i);
  });

  it('blocks production process-memory rate limiting', () => {
    const issues = runValidator(happyEnv({
      NODE_ENV: 'production',
      RATE_LIMIT_STORE: 'memory',
    }));
    const issue = issues.find(i => i.code === 'SENSITIVE_RATE_LIMIT_STORE_UNSAFE');
    assert.ok(issue);
    assert.equal(issue.severity, Severity.BLOCKING);
  });

  it('blocks production fail-open or memory sensitive policies', () => {
    for (const policy of ['fail-open', 'memory']) {
      const issues = runValidator(happyEnv({
        NODE_ENV: 'production',
        RATE_LIMIT_STORE: 'redis',
        RATE_LIMIT_SENSITIVE_POLICY: policy,
      }));
      const issue = issues.find(i => i.code === 'SENSITIVE_RATE_LIMIT_POLICY_UNSAFE');
      assert.ok(issue, `expected unsafe policy issue for ${policy}`);
      assert.equal(issue.severity, Severity.BLOCKING);
      assert.doesNotMatch(JSON.stringify(issue), /fail-open/i);
    }
  });

  it('blocks an unknown production sensitive policy without reflecting its value', () => {
    const issues = runValidator(happyEnv({
      NODE_ENV: 'production',
      RATE_LIMIT_SENSITIVE_POLICY: 'redis://user:secret@internal',
    }));
    const issue = issues.find(i => i.code === 'SENSITIVE_RATE_LIMIT_POLICY_INVALID');
    assert.ok(issue);
    assert.equal(issue.severity, Severity.BLOCKING);
    assert.doesNotMatch(JSON.stringify(issue), /user|secret|internal/i);
  });

  it('allows explicit memory and fail-open policies in nonproduction', () => {
    for (const policy of ['memory', 'fail-open']) {
      const issues = runValidator(happyEnv({
        NODE_ENV: 'test',
        RATE_LIMIT_STORE: policy === 'memory' ? 'memory' : 'redis',
        RATE_LIMIT_SENSITIVE_POLICY: policy,
      }));
      assert.equal(
        issues.some(i => String(i.code || '').startsWith('SENSITIVE_RATE_LIMIT_')),
        false,
      );
    }
  });

  it('accepts explicit distributed production rate limiting', () => {
    const issues = runValidator(happyEnv({
      NODE_ENV: 'production',
      RATE_LIMIT_STORE: 'redis',
      RATE_LIMIT_SENSITIVE_POLICY: 'distributed',
    }));
    assert.equal(
      issues.some(i => String(i.code || '').startsWith('SENSITIVE_RATE_LIMIT_')),
      false,
    );
  });
});

// ── CORS in production ────────────────────────────────────────────

describe('validateStartupEnvironment · CORS in production', () => {
  it('blocks wildcard credentialed CORS in production', () => {
    for (const CORS_ORIGINS of ['*', 'https://app.example.com, *']) {
      const issues = runValidator(happyEnv({
        NODE_ENV: 'production',
        CORS_ORIGINS,
      }));
      const cors = issues.find(i => i.code === 'CORS_WILDCARD_CREDENTIALS_FORBIDDEN');
      assert.ok(cors);
      assert.equal(cors.severity, Severity.BLOCKING);
    }
  });

  it('blocks when NODE_ENV=production and CORS_ORIGINS is missing', () => {
    const issues = runValidator(happyEnv({
      NODE_ENV: 'production',
      CORS_ORIGINS: undefined,
    }));
    const cors = issues.find(i => i.code === 'CORS_ORIGINS_REQUIRED');
    assert.ok(cors);
    assert.equal(cors.severity, Severity.BLOCKING);
  });

  it('blocks malformed production CORS origins', () => {
    const issues = runValidator(happyEnv({
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://siragpt.com, not-an-origin',
    }));
    const cors = issues.find(i => i.code === 'CORS_ORIGINS_INVALID');
    assert.ok(cors);
    assert.equal(cors.severity, Severity.BLOCKING);
  });

  it('no CORS warning in development with "*"', () => {
    const issues = runValidator(happyEnv({
      NODE_ENV: 'development',
      CORS_ORIGINS: '*',
    }));
    const cors = issues.find(i => i.key === 'CORS_ORIGINS');
    assert.equal(cors, undefined);
  });

  it('blocks CSRF_DISABLED in production', () => {
    for (const CSRF_DISABLED of ['1', 'true', 'TRUE']) {
      const issues = runValidator(happyEnv({
        NODE_ENV: 'production',
        CSRF_DISABLED,
        CORS_ORIGINS: 'https://app.example.com',
      }));
      const csrf = issues.find(i => i.code === 'CSRF_DISABLED_IN_PRODUCTION');
      assert.ok(csrf);
      assert.equal(csrf.severity, Severity.BLOCKING);
    }
  });
});

// ── API key format ────────────────────────────────────────────────

describe('validateStartupEnvironment · API key format', () => {
  it('warns on OPENAI_API_KEY without sk-proj/sk-svc/sk-sana prefix', () => {
    const issues = runValidator(happyEnv({
      OPENAI_API_KEY: 'random-not-a-real-key',
    }));
    const k = issues.find(i => i.key === 'OPENAI_API_KEY');
    assert.ok(k);
    assert.equal(k.severity, 'WARNING');
  });

  it('does not warn on sk-proj-... OpenAI key', () => {
    const issues = runValidator(happyEnv({
      OPENAI_API_KEY: 'sk-proj-example-key',
    }));
    const k = issues.find(i => i.key === 'OPENAI_API_KEY');
    assert.equal(k, undefined);
  });

  it('does not warn on the CI dummy key', () => {
    const issues = runValidator(happyEnv({
      OPENAI_API_KEY: 'sk-ci-dummy-key-for-test',
    }));
    const k = issues.find(i => i.key === 'OPENAI_API_KEY');
    assert.equal(k, undefined);
  });

  it('warns on STRIPE_SECRET_KEY without sk_/rk_ test/live prefix', () => {
    const issues = runValidator(happyEnv({
      STRIPE_SECRET_KEY: 'wrong-format-stripe-key',
    }));
    const k = issues.find(i => i.key === 'STRIPE_SECRET_KEY');
    assert.ok(k);
    assert.equal(k.severity, 'WARNING');
  });

  it('does not warn on sk_test_... STRIPE_SECRET_KEY', () => {
    const issues = runValidator(happyEnv({
      STRIPE_SECRET_KEY: 'sk_test_XXXXXXXXXXXXXXX',
    }));
    const k = issues.find(i => i.key === 'STRIPE_SECRET_KEY');
    assert.equal(k, undefined);
  });

  it('does not warn on rk_live_... STRIPE_SECRET_KEY', () => {
    const issues = runValidator(happyEnv({
      STRIPE_SECRET_KEY: 'rk_live_XXXXXXXXXXXXXXX',
    }));
    const k = issues.find(i => i.key === 'STRIPE_SECRET_KEY');
    assert.equal(k, undefined);
  });

  it('warns when STRIPE_SECRET_KEY looks like a masked dashboard value', () => {
    const issues = runValidator(happyEnv({
      STRIPE_SECRET_KEY: 'sk_live_****************tlKU',
    }));
    const k = issues.find(i => i.key === 'STRIPE_SECRET_KEY');
    assert.ok(k);
    assert.equal(k.severity, 'WARNING');
    assert.match(k.message, /masked|malformed/i);
  });
});

// ── Numeric range ─────────────────────────────────────────────────

describe('validateStartupEnvironment · numeric ranges', () => {
  it('warns when PORT is below 1024', () => {
    const issues = runValidator(happyEnv({ PORT: '80' }));
    const p = issues.find(i => i.key === 'PORT');
    assert.ok(p);
    assert.match(p.message, /between 1024 and 65535/);
  });

  it('warns when PORT is non-numeric', () => {
    const issues = runValidator(happyEnv({ PORT: 'notanumber' }));
    const p = issues.find(i => i.key === 'PORT');
    assert.ok(p);
    assert.match(p.message, /should be a number/);
  });

  it('no warning on a valid PORT in range', () => {
    const issues = runValidator(happyEnv({ PORT: '3000' }));
    const p = issues.find(i => i.key === 'PORT');
    assert.equal(p, undefined);
  });

  it('warns when MAX_FILE_SIZE is outside [1..500]', () => {
    const issues = runValidator(happyEnv({ MAX_FILE_SIZE: '5000' }));
    const m = issues.find(i => i.key === 'MAX_FILE_SIZE');
    assert.ok(m);
  });
});

// ── getValidationIssues ───────────────────────────────────────────

describe('getValidationIssues', () => {
  it('returns a snapshot copy of the last-run issues', () => {
    runValidator(happyEnv({ JWT_SECRET: 'changeme' }));
    const snapshot = getValidationIssues();
    assert.ok(snapshot.find(i => i.key === 'JWT_SECRET'));
    // Mutating the returned array does NOT affect the validator's
    // internal state — pin this so callers can't accidentally corrupt
    // the global issue list.
    snapshot.length = 0;
    const snapshot2 = getValidationIssues();
    assert.ok(snapshot2.length > 0, 'snapshot mutation leaked into internal state');
  });
});

// ── Multiple issues, blocking precedence ──────────────────────────

describe('validateStartupEnvironment · multiple issues', () => {
  it('collects issues from independent checks in a single run', () => {
    const issues = runValidator({
      JWT_SECRET: '', // BLOCKING: missing
      SESSION_SECRET: 'changeme', // BLOCKING: placeholder
      PRISMA_DATABASE_URL: 'mysql://x', // BLOCKING: bad scheme
      REDIS_URL: undefined, // WARNING
      OPENAI_API_KEY: 'wrong-prefix', // WARNING
      PORT: '80', // WARNING
    });
    const blocking = issues.filter(i => i.severity === 'BLOCKING');
    const warnings = issues.filter(i => i.severity === 'WARNING');
    assert.ok(blocking.length >= 3, `expected ≥3 blocking, got ${blocking.length}`);
    assert.ok(warnings.length >= 3, `expected ≥3 warnings, got ${warnings.length}`);
  });

  it('resets between runs (no carry-over from prior issues)', () => {
    runValidator({ JWT_SECRET: '' });
    const second = runValidator(happyEnv());
    // happyEnv is fully valid, so second run should be empty.
    assert.deepEqual(second, []);
  });
});
