'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const publishingRouter = require('../src/routes/publishing');
const { requireAdmin } = require('../src/middleware/auth');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/publishing', publishingRouter);
  return app;
}

test('publishing route returns production console state', async () => {
  const response = await request(createApp())
    .get('/api/publishing')
    .expect(200)
    .expect('Cache-Control', /no-store/);

  assert.equal(response.body.appName, 'siragpt');
  assert.equal(response.body.statusLabel, 'published');
  assert.equal(response.body.healthStatus, 'healthy');
  assert.ok(Array.isArray(response.body.domains));
  assert.ok(Array.isArray(response.body.logs));
});

test('publishing route executes safe console actions', async () => {
  const response = await request(createApp())
    .post('/api/publishing')
    .send({ action: 'security-scan' })
    .expect(200);

  assert.equal(response.body.ok, true);
  assert.match(response.body.message, /Security scan finished/);
  assert.equal(response.body.state.statusLabel, 'published');
});

test('publishing route validates missing actions', async () => {
  const response = await request(createApp())
    .post('/api/publishing')
    .send({})
    .expect(400);

  assert.equal(response.body.ok, false);
  assert.equal(response.body.message, 'Missing publishing action.');
});

// --- Access control: in index.js this router is mounted behind
// authenticateToken + requireAdmin. These tests pin the authorization contract
// of that guard against the real router so an unauthenticated or non-admin
// caller can never reach the deployment actions (republish, shutdown, etc.).
function createGuardedApp(user) {
  const app = express();
  app.use(express.json());
  if (user !== undefined) {
    app.use((req, _res, next) => { req.user = user; next(); });
  }
  app.use('/api/publishing', requireAdmin, publishingRouter);
  return app;
}

test('publishing route rejects unauthenticated callers (GET + POST)', async () => {
  await request(createGuardedApp(undefined)).get('/api/publishing').expect(403);
  await request(createGuardedApp(undefined))
    .post('/api/publishing')
    .send({ action: 'republish' })
    .expect(403);
});

test('publishing route rejects authenticated non-admin callers', async () => {
  const app = createGuardedApp({ id: 'u1', isAdmin: false, isSuperAdmin: false });
  await request(app).get('/api/publishing').expect(403);
  await request(app).post('/api/publishing').send({ action: 'republish' }).expect(403);
});

test('publishing route allows admin callers', async () => {
  const app = createGuardedApp({ id: 'u1', isAdmin: true, isSuperAdmin: false });
  const response = await request(app).get('/api/publishing').expect(200);
  assert.equal(response.body.appName, 'siragpt');
});
