'use strict';

/**
 * Route test for POST /api/accounting/accounts/seed — the admin-only PCGE seed.
 *
 * Regression: the handler gated on `req.user.role` (a field the User model does
 * NOT have — it uses isAdmin/isSuperAdmin booleans), so the comparison was
 * always true and returned 403 to EVERYONE, including real admins, leaving the
 * seed endpoint permanently unreachable. It now delegates to the canonical
 * requireAdmin middleware (src/middleware/auth.js).
 *
 * Auth is stubbed via the require cache; seedPcge is stubbed so no DB is touched.
 * These tests fail against the pre-fix handler (admin → 403).
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

let testUser = null;

const authPath = require.resolve('../src/middleware/auth');
const restoreAuth = mockResolvedModule(authPath, {
  authenticateToken(req, _res, next) { req.user = testUser; next(); },
  // Mirrors src/middleware/auth.js requireAdmin (isAdmin OR isSuperAdmin).
  requireAdmin(req, res, next) {
    if (!req.user || (!req.user.isAdmin && !req.user.isSuperAdmin)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  },
});

let seedCalls = 0;
const pcgePath = require.resolve('../src/services/accounting/pcge');
const restorePcge = mockResolvedModule(pcgePath, {
  seedPcge: async () => { seedCalls += 1; return { created: 5, skipped: 0 }; },
});

const accountingRoutes = require('../src/routes/accounting');
after(() => { restoreAuth(); restorePcge(); });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounting', accountingRoutes);
  return app;
}

beforeEach(() => { testUser = null; seedCalls = 0; });

test('POST /accounts/seed lets an admin seed the catalog (was 403 for everyone)', async () => {
  testUser = { id: 'admin-1', isAdmin: true };
  const res = await request(buildApp()).post('/api/accounting/accounts/seed').send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.created, 5);
  assert.equal(seedCalls, 1, 'seedPcge ran for the admin');
});

test('POST /accounts/seed allows a super-admin too', async () => {
  testUser = { id: 'su-1', isSuperAdmin: true };
  const res = await request(buildApp()).post('/api/accounting/accounts/seed').send({});
  assert.equal(res.status, 200);
  assert.equal(seedCalls, 1);
});

test('POST /accounts/seed rejects a non-admin with 403 and never runs the seed', async () => {
  testUser = { id: 'user-1', isAdmin: false, isSuperAdmin: false };
  const res = await request(buildApp()).post('/api/accounting/accounts/seed').send({});
  assert.equal(res.status, 403);
  assert.equal(seedCalls, 0, 'seedPcge must NOT run for a non-admin');
});

test('POST /accounts/seed rejects an unauthenticated request', async () => {
  testUser = null;
  const res = await request(buildApp()).post('/api/accounting/accounts/seed').send({});
  assert.equal(res.status, 403);
  assert.equal(seedCalls, 0);
});
