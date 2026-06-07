'use strict';

/**
 * health-route-aliases — proves the k8s/orchestrator-conventional liveness and
 * readiness aliases (`/healthz`, `/livez`, `/readyz`, and their `/api/*` forms)
 * are mounted on the SAME handlers as the canonical `/health/live` and
 * `/health/ready` routes, so an external probe configured with the standard
 * path names works without bespoke config.
 *
 * Mounts the real createHealthRoutes factory on a bare Express app with fake
 * healthy prisma/redis (offline, deterministic).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { createHealthRoutes } = require('../src/routes/health-routes');

function buildApp() {
  const app = express();
  const healthRoutes = createHealthRoutes({
    prisma: { $queryRawUnsafe: async () => [] }, // healthy DB + no failed migrations
    redis: null,
    cacheTtlMs: 0,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  healthRoutes.register(app);
  return app;
}

test('liveness aliases /healthz and /livez return 200 with a liveness report', async () => {
  const app = buildApp();
  for (const path of ['/healthz', '/livez', '/api/healthz', '/api/livez', '/health/live']) {
    const res = await request(app).get(path);
    assert.equal(res.status, 200, `${path} should be 200`);
    assert.equal(res.body.status, 'healthy', `${path} liveness should be healthy`);
    assert.ok(
      Array.isArray(res.body.checks) && res.body.checks.some((c) => c.name === 'process'),
      `${path} should report the process check`,
    );
    // Liveness must be cheap: it never runs the DB/migrations probes.
    assert.ok(
      !res.body.checks.some((c) => c.name === 'database' || c.name === 'migrations'),
      `${path} liveness must not run DB probes`,
    );
  }
});

test('readiness alias /readyz returns the readiness report (incl. migrations probe)', async () => {
  const app = buildApp();
  for (const path of ['/readyz', '/api/readyz', '/health/ready']) {
    const res = await request(app).get(path);
    assert.equal(res.status, 200, `${path} should be 200 when healthy`);
    assert.equal(res.body.status, 'healthy');
    const names = res.body.checks.map((c) => c.name);
    assert.ok(names.includes('database'), `${path} should run the database probe`);
    assert.ok(names.includes('migrations'), `${path} should run the migrations probe`);
  }
});

test('/readyz returns 503 when a failed migration is present', async () => {
  const app = express();
  const routes = createHealthRoutes({
    prisma: { $queryRawUnsafe: async (sql) => (/_prisma_migrations/.test(sql) ? [{ migration_name: 'x' }] : 1) },
    redis: null,
    cacheTtlMs: 0,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  routes.register(app);
  const res = await request(app).get('/readyz');
  assert.equal(res.status, 503, 'a failed migration must drain the instance');
  assert.equal(res.body.status, 'unhealthy');
  assert.ok(res.body.checks.find((c) => c.name === 'migrations' && c.status === 'unhealthy'));
});
