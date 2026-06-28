'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const request = require('supertest');

const { buildRouteTestApp, reloadModule } = require('./http-test-utils');

test('code runner proxy allows same-origin iframe even when auth rejects', async () => {
  const app = buildRouteTestApp('/api/code-runner', reloadModule('../src/routes/code-runner'));

  const res = await request(app).get('/api/code-runner/run-1/proxy/');

  assert.equal(res.status, 401);
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(res.headers['content-security-policy'], "frame-ancestors 'self'");
});
