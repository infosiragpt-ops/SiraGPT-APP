'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const publishingRouter = require('../src/routes/publishing');

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
