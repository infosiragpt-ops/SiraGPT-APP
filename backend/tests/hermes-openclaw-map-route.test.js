'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const hermesRouter = require('../src/routes/hermes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/hermes', hermesRouter);
  return app;
}

test('GET /api/hermes/openclaw/map returns the OpenClaw integration map', async () => {
  const res = await request(makeApp()).get('/api/hermes/openclaw/map');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body, 'object');
  for (const key of ['source', 'counts', 'folders', 'skills']) {
    assert.ok(key in res.body, `map should contain "${key}"`);
  }
});

test('GET /api/hermes/openclaw/map/recommend echoes the query and returns an array', async () => {
  const res = await request(makeApp()).get('/api/hermes/openclaw/map/recommend?q=schedule%20a%20cron%20job');
  assert.equal(res.status, 200);
  assert.equal(res.body.query, 'schedule a cron job');
  assert.ok(Array.isArray(res.body.recommendations), 'recommendations must be an array');
});
