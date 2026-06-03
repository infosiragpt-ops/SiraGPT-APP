/**
 * health-route-oauth-e2e — proves the *live* /health HTTP route threads the
 * boot-time Google OAuth result through to runFullHealthCheck.
 *
 * Why this exists (Task #38)
 * --------------------------
 * sira-health-and-metrics.test.js already proves runFullHealthCheck() surfaces
 * the OAuth result when called directly. But that never exercises the actual
 * HTTP route, so a refactor could stop passing `googleOAuth: oauthBootResult`
 * into runFullHealthCheck and every unit test would still pass while the real
 * endpoint silently drops the key.
 *
 * This test mounts the REAL route handlers (the same createHealthRoutes factory
 * that backend/index.js mounts) on a bare Express app and issues real HTTP
 * requests through supertest, with fake healthy prisma/redis so the result is
 * deterministic and offline. It asserts:
 *   - the JSON body has a top-level `googleOAuth` key and a `google_oauth`
 *     entry in `checks`
 *   - a clean boot result leaves google_oauth `skipped` (proving the route
 *     passes the *actual* snapshot through, not a hardcoded value)
 *   - a boot result with issues drives the google_oauth check + overall status
 *     to "degraded" while HTTP stays 200 (never page on a stale OAuth config)
 */

'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { createHealthRoutes } = require('../src/routes/health-routes');

// Fake healthy dependencies so the composite report is deterministic and the
// suite never touches a real Postgres/Redis. OPENAI_API_KEY is set so the
// model_providers check is healthy, isolating the overall status to the OAuth
// signal under test.
function buildApp() {
  const app = express();
  const healthRoutes = createHealthRoutes({
    prisma: { $queryRawUnsafe: async () => 1 },
    coworkHealth: null,
    // cacheTtlMs:0 so consecutive requests observe freshly-set boot snapshots
    // instead of a stale cached report.
    cacheTtlMs: 0,
    env: { OPENAI_API_KEY: 'sk-test' },
    getOpenTelemetryStatus: () => ({}),
    getSentryStatus: () => ({}),
    getLangfuseStatus: () => ({}),
    getPostHogStatus: () => ({}),
    startupEnv: { checked: true, issues: [] },
  });
  healthRoutes.register(app);
  return { app, healthRoutes };
}

describe('GET /health — live OAuth health exposure (e2e)', () => {
  let originalOpenAIKey;

  before(() => {
    // model_providers reads process.env directly (not the injected env), so
    // pin a provider key for the duration of this suite to keep that check
    // healthy and the overall status driven only by the OAuth signal.
    originalOpenAIKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  test('clean boot result → google_oauth check skipped, googleOAuth key present', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/health');

    // Degraded is allowed (informational checks like playwright may be
    // degraded in CI) but it must never be a 5xx for a clean boot.
    assert.ok(res.status === 200, `expected 200, got ${res.status}`);

    // Top-level mirror that monitoring probes read directly.
    assert.ok(res.body.googleOAuth, 'expected top-level googleOAuth key');
    assert.equal(res.body.googleOAuth.checked, false);

    // Entry inside the checks array.
    const check = res.body.checks.find((c) => c.name === 'google_oauth');
    assert.ok(check, 'expected a google_oauth check entry');
    // A clean (unset) boot result is "skipped" — proving the route passes the
    // ACTUAL snapshot through rather than a hardcoded healthy/degraded value.
    assert.equal(check.status, 'skipped');
  });

  test('boot result with issues → google_oauth + overall degraded, HTTP 200', async () => {
    const { app, healthRoutes } = buildApp();

    // Simulate what startServer does at boot when validateOAuthCallbackUrl
    // detects a problem that survives startup (e.g. a host mismatch in
    // non-production where the server is allowed to keep running).
    healthRoutes.setOAuthBootResult({
      checked: true,
      mismatch: true,
      issues: ['redirect host mismatch: expected siragpt.com'],
    });

    const res = await request(app).get('/health');

    // Never page on a stale OAuth config — degraded maps to 200.
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'degraded');

    // Top-level mirror reflects the live boot snapshot.
    assert.ok(res.body.googleOAuth, 'expected top-level googleOAuth key');
    assert.equal(res.body.googleOAuth.checked, true);
    assert.equal(res.body.googleOAuth.mismatch, true);
    assert.deepEqual(res.body.googleOAuth.issues, [
      'redirect host mismatch: expected siragpt.com',
    ]);

    // Entry inside the checks array is degraded and non-critical.
    const check = res.body.checks.find((c) => c.name === 'google_oauth');
    assert.ok(check, 'expected a google_oauth check entry');
    assert.equal(check.status, 'degraded');
    assert.equal(check.critical, false);
    assert.deepEqual(check.details.issues, [
      'redirect host mismatch: expected siragpt.com',
    ]);
  });

  test('the /api/health alias exposes the same OAuth wiring', async () => {
    const { app, healthRoutes } = buildApp();
    healthRoutes.setOAuthBootResult({
      checked: true,
      mismatch: false,
      issues: ['malformed callback URL'],
    });

    const res = await request(app).get('/api/health');

    assert.equal(res.status, 200);
    assert.ok(res.body.googleOAuth, 'expected top-level googleOAuth key');
    const check = res.body.checks.find((c) => c.name === 'google_oauth');
    assert.ok(check, 'expected a google_oauth check entry');
    assert.equal(check.status, 'degraded');
  });

  test.after(() => {
    if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAIKey;
  });
});
