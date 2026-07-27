'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

const { createHealthRoutes } = require('../src/routes/health-routes');
const backendPackage = require('../package.json');

function buildHealthApp(rbacStatus) {
  const app = express();
  createHealthRoutes({
    prisma: { $queryRawUnsafe: async () => [] },
    redis: null,
    queue: null,
    cacheTtlMs: 0,
    env: { NODE_ENV: 'test', OPENAI_API_KEY: 'test-only' },
    getRbacBootstrapStatus: () => rbacStatus,
  }).register(app);
  return app;
}

test('readiness exposes successful RBAC startup status', async () => {
  const response = await request(buildHealthApp({
    state: 'ready',
    ready: true,
    mode: 'enforce',
    errorCode: null,
  })).get('/health/ready');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.rbac, {
    state: 'ready',
    ready: true,
    mode: 'enforce',
    errorCode: null,
  });
  const check = response.body.checks.find((item) => item.name === 'rbac_bootstrap');
  assert.ok(check);
  assert.equal(check.status, 'healthy');
  assert.equal(check.critical, true);
});

test('enforce readiness fails closed when RBAC startup is not ready', async () => {
  const response = await request(buildHealthApp({
    state: 'failed',
    ready: false,
    mode: 'enforce',
    errorCode: 'RBAC_READINESS_FAILED',
  })).get('/health/ready');

  assert.equal(response.status, 503);
  const check = response.body.checks.find((item) => item.name === 'rbac_bootstrap');
  assert.equal(check.status, 'unhealthy');
  assert.equal(check.critical, true);
  assert.equal(check.error, 'RBAC_READINESS_FAILED');
});

test('shadow readiness reports a noncritical degraded RBAC rollout', async () => {
  const response = await request(buildHealthApp({
    state: 'degraded',
    ready: false,
    mode: 'shadow',
    errorCode: 'RBAC_READINESS_FAILED',
  })).get('/health');

  assert.equal(response.status, 200);
  const check = response.body.checks.find((item) => item.name === 'rbac_bootstrap');
  assert.equal(check.status, 'degraded');
  assert.equal(check.critical, false);
});

test('startServer awaits RBAC bootstrap before binding the HTTP port', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
  const start = source.indexOf('async function startServer()');
  const bootstrap = source.indexOf('await rbacBootstrap.bootstrap()', start);
  const listen = source.indexOf('const server = app.listen(', start);
  assert.ok(start >= 0);
  assert.ok(bootstrap > start, 'startServer must await RBAC bootstrap');
  assert.ok(listen > bootstrap, 'RBAC bootstrap must finish before app.listen');
});

test('canonical backend suite registers every U2 RBAC security contract', () => {
  for (const file of [
    'tests/dev-admin-bypass-absent.test.js',
    'tests/rbac-bootstrap.test.js',
    'tests/rbac-assignment-sync.test.js',
    'tests/rbac-control-plane.test.js',
    'tests/rbac-permission-cache.test.js',
    'tests/rbac-permission-version.test.js',
    'tests/rbac-strict-audit.test.js',
    'tests/rbac-user-lifecycle.test.js',
    'tests/admin-route-permissions.test.js',
    'tests/rbac-startup-health.test.js',
  ]) {
    assert.match(backendPackage.scripts.test, new RegExp(file.replace(/\./g, '\\.')));
  }
});
