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
function buildApp(overrides = {}) {
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
    ...overrides,
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

  test('full health route threads the shared pool snapshot and advisory recommendation', async () => {
    const { app } = buildApp({
      poolMetrics: {
        snapshot: () => ({
          capacity: { observable: true, reason: 'direct_postgres_datasource' },
          pool: { min: 2, max: 10, idleTimeoutMs: 60_000 },
          estimated_connections_active: 6,
          estimated_connections_idle: 4,
          queries_in_flight: 6,
          estimated_saturation_ratio: 0.6,
          estimated_saturation: 'ok',
        }),
      },
      getPoolAutoscalerState: () => ({
        running: true,
        mode: 'advisory',
        currentLimit: 10,
        recommendedLimit: 12,
        lastRecommendation: 'scale_up',
        lastRecommendationAt: 1234,
        stats: { ticks: 1, recommendations: 1, applyErrors: 0 },
      }),
    });

    const res = await request(app).get('/health');

    assert.equal(res.status, 200);
    assert.equal(res.body.databasePool.snapshot.pool.max, 10);
    assert.equal(res.body.databasePool.recommendation.mode, 'advisory');
    assert.equal(res.body.databasePool.recommendation.currentLimit, 10);
    assert.equal(res.body.databasePool.recommendation.recommendedLimit, 12);
    assert.ok(res.body.checks.find((check) => check.name === 'database_pool'));
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

  test('auth-security health exposes safe runtime config on full health', async () => {
    const { app } = buildApp({
      authSecurity: {
        health: () => ({
          ok: true,
          oauthState: { mode: 'redis', distributed: true },
          impersonation: { mode: 'redis', distributed: true },
        }),
        config: () => ({
          oauthState: { commandTimeoutMs: 500, offlineQueue: false },
          impersonation: { commandTimeoutMs: 500, offlineQueue: false },
        }),
      },
    });

    const res = await request(app).get('/health');

    assert.equal(res.status, 200);
    assert.equal(res.body.authSecurity.ok, true);
    assert.equal(res.body.authSecurity.oauthState.mode, 'redis');
    assert.equal(res.body.authSecurity.config.oauthState.offlineQueue, false);
    assert.equal(res.body.authSecurity.config.impersonation.offlineQueue, false);
  });

  test('production readiness and full health fail when auth-security is unavailable', async () => {
    const { app } = buildApp({
      env: { NODE_ENV: 'production', OPENAI_API_KEY: 'sk-test' },
      authSecurity: {
        health: () => ({
          ok: false,
          oauthState: { mode: 'unavailable', distributed: false },
          impersonation: { mode: 'unavailable', distributed: false },
        }),
        config: () => ({
          oauthState: { redisConfigured: false },
          impersonation: { redisConfigured: false },
        }),
      },
    });

    const [full, ready] = await Promise.all([
      request(app).get('/health'),
      request(app).get('/health/ready'),
    ]);

    assert.equal(full.status, 503);
    assert.equal(full.body.status, 'unhealthy');
    assert.equal(ready.status, 503);
    assert.equal(ready.body.status, 'unhealthy');
    assert.equal(ready.body.authSecurity.ok, false);
  });

  test('readiness retries auth-security with bounded backoff and recovers without restart', async () => {
    let now = 10_000;
    let readyCalls = 0;
    let healthy = false;
    const { app } = buildApp({
      clock: () => now,
      env: {
        NODE_ENV: 'production',
        OPENAI_API_KEY: 'sk-test',
        AUTH_SECURITY_READY_RETRY_BASE_MS: '100',
        AUTH_SECURITY_READY_RETRY_MAX_MS: '200',
      },
      authSecurity: {
        async ready() {
          readyCalls += 1;
          if (readyCalls === 1) {
            const error = new Error('redis unavailable');
            error.code = 'OAUTH_STATE_STORE_UNAVAILABLE';
            throw error;
          }
          healthy = true;
          return [{ status: 'fulfilled' }];
        },
        health: () => ({
          ok: healthy,
          oauthState: {
            mode: healthy ? 'redis' : 'unavailable',
            distributed: healthy,
          },
          impersonation: {
            mode: healthy ? 'redis' : 'unavailable',
            distributed: healthy,
          },
        }),
        config: () => ({}),
      },
    });

    const failed = await request(app).get('/health/ready');
    assert.equal(failed.status, 503);
    assert.equal(readyCalls, 1);
    assert.equal(failed.body.authSecurity.readinessRetry.attempt, 1);
    assert.equal(failed.body.authSecurity.readinessRetry.delayMs, 100);

    const throttled = await request(app).get('/health/ready');
    assert.equal(throttled.status, 503);
    assert.equal(readyCalls, 1, 'readiness must not hammer Redis inside backoff');

    now += 100;
    const recovered = await request(app).get('/health/ready');
    assert.equal(recovered.status, 200);
    assert.equal(readyCalls, 2);
    assert.equal(recovered.body.authSecurity.ok, true);
    assert.equal(recovered.body.authSecurity.readinessRetry.attempt, 0);
    assert.equal(recovered.body.authSecurity.readinessRetry.delayMs, 0);
  });

  test.after(() => {
    if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAIKey;
  });
});
