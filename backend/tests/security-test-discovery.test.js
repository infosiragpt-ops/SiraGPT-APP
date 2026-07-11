'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
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
  'tests/security-test-discovery.test.js',
]);

function canonicalTestFiles() {
  const command = packageJson.scripts?.test || '';
  return command.match(/tests\/[A-Za-z0-9._\-/]+\.test\.js/g) || [];
}

test('all I15-I16 security contracts live in the canonical test script', () => {
  const files = canonicalTestFiles();
  for (const file of SECURITY_TESTS) {
    assert.ok(files.includes(file), `${file} is absent from scripts.test`);
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

test('test sharder discovers a canonical I15-I16 test from scripts.test', () => {
  const files = canonicalTestFiles();
  const target = 'tests/production-environment.test.js';
  const targetIndex = files.indexOf(target);
  assert.ok(targetIndex >= 0, 'target security contract is not canonical');

  // TOTAL exceeds the file count, so this shard receives exactly the target
  // at index targetIndex and proves the sharder parsed scripts.test.
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
