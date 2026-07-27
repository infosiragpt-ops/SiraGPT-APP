'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const packageJson = require('../package.json');

const SECURITY_TESTS = Object.freeze([
  'tests/payments-verify-session-idempotency.test.js',
  'tests/payments-subscription-cancel.test.js',
  'tests/rate-limit-store-redis.test.js',
  'tests/middleware-rate-limit-auth.test.js',
  'tests/enforce-api-key-rate-limit.test.js',
  'tests/sensitive-rate-limit-policy.test.js',
  'tests/billing-rate-limit.test.js',
  'tests/billing-rate-limit-routes.test.js',
  'tests/csrf-middleware.test.js',
  'tests/csrf-issue-token.test.js',
  'tests/csrf-route-inventory.test.js',
  'tests/security-billing-config-contract.test.js',
  'tests/trust-proxy-policy.test.js',
  'tests/production-environment.test.js',
  'tests/cors-policy.test.js',
  'tests/saml-cors-ingress.test.js',
  'tests/saml-handler.test.js',
  'tests/saml-request-store.test.js',
  'tests/saml-sp-initiated.test.js',
  'tests/saml-browser-flow.test.js',
  'tests/saml-acs-rate-limit.test.js',
  'tests/auth-sessions-list-pagination.test.js',
  'tests/upload-static-access.test.js',
  'tests/oauth-state.test.js',
  'tests/provider-oauth-service.test.js',
  'tests/appshots-capture.test.js',
  'tests/appshots-auto-revoke-email.test.js',
  'tests/backfill-appshots-geo-hint.test.js',
  'tests/session-token-hashing.test.js',
  'tests/users-sessions-current.test.js',
  'tests/oauth-state-distributed.test.js',
  'tests/impersonation-rate-limiter.test.js',
  'tests/security-test-discovery.test.js',
]);

const BACKEND_ROOT = path.resolve(__dirname, '..');

// The sharder selects by discovering tests/**/*.test.js on disk and subtracting
// tests/.ci-quarantine.txt. Mirror that here by shelling out to the same
// `find | sort`, so this contract tracks the sharder's real ordering rather
// than a JS re-implementation that could drift from it (locale-dependent sort
// order being the obvious trap).
function canonicalTestFiles() {
  const found = spawnSync('bash', ['-c', "find tests -name '*.test.js' -type f | sort"], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
  });
  assert.equal(found.status, 0, found.stderr);
  const quarantined = new Set(
    fs
      .readFileSync(path.join(BACKEND_ROOT, 'tests/.ci-quarantine.txt'), 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean),
  );
  return found.stdout.split('\n').filter((f) => f && !quarantined.has(f));
}

test('all I15-I19 security contracts are eligible for CI selection', () => {
  const files = canonicalTestFiles();
  for (const file of SECURITY_TESTS) {
    // Eligible means: present on disk AND not quarantined. Under discovery-based
    // selection those are the only two ways a test can fail to run.
    assert.ok(files.includes(file), `${file} is not eligible for CI`);
  }

  const posttest = packageJson.scripts?.posttest || '';
  for (const file of SECURITY_TESTS) {
    assert.equal(
      posttest.includes(file),
      false,
      `${file} must not rely on posttest-only discovery`,
    );
  }
});

test('test sharder selects a canonical I15-I19 test from disk discovery', () => {
  const files = canonicalTestFiles();
  const target = 'tests/production-environment.test.js';
  const targetIndex = files.indexOf(target);
  assert.ok(targetIndex >= 0, 'target security contract is not canonical');

  // TOTAL exceeds the file count, so this shard receives exactly the target
  // at index targetIndex and proves the sharder's discovery order.
  const total = files.length + 17;
  const childEnv = { ...process.env, CI: '' };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(
    'bash',
    ['scripts/test-shard.sh', String(targetIndex + 1), String(total)],
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: childEnv,
      timeout: 30_000,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Running shard \d+\/\d+: 1 of \d+ test files/);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /prod is an unsupported production alias/,
  );
});
