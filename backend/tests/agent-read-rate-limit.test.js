'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
const rateLimit = require('express-rate-limit');
const request = require('supertest');
const policy = require('../src/middleware/rate-limit-policy');

const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
const taskId = '63bf271e-7620-4635-9708-ffabc1a9fd17';
const artifactId = 'ab12cd34';
const reads = [
  `/api/agent/task/${taskId}/events?after=10`,
  `/api/agent/task/${taskId}`,
  '/api/agent/artifacts?limit=20',
  `/api/agent/artifact/${artifactId}?name=Prueba-PDF.pdf`,
];

function createApp({ expensive = 2, api = 3000 } = {}) {
  const app = express();
  // Exercise the production skip functions and mounts with real independent
  // express-rate-limit stores, without booting workers, Redis or a provider.
  const start = source.indexOf('const expensiveLimiter = rateLimit({');
  const end = source.indexOf('// CORS allowlist', start);
  assert.ok(start > 0 && end > start, 'production limiter definitions exist');
  const mounts = [
    /app\.use\('\/api\/agent', expensiveLimiter\);/,
    /app\.use\('\/api\/', apiLimiter\);/,
  ].map((pattern) => {
    const found = source.match(pattern);
    assert.ok(found, 'production limiter mount exists');
    return found[0];
  });
  vm.runInNewContext(source.slice(start, end) + mounts.join('\n'), {
    app,
    rateLimit,
    rateLimitCfg: { windowMs: 60_000, expensive, api },
    makeLimiterCommon: () => ({ standardHeaders: true, legacyHeaders: false }),
    skipForSuperAdmin: () => false,
    isAuthSessionMaintenancePath: policy.isAuthSessionMaintenancePath,
    isAgentTaskReadRequest: policy.isAgentTaskReadRequest,
  });
  app.use((_req, res) => res.json({ ok: true }));
  return request(app);
}

test('many task polls and artifact reads do not spend generation admission', async () => {
  const client = createApp();
  for (let n = 0; n < 200; n += 1) {
    const response = await client.get(reads[n % reads.length]);
    assert.equal(response.status, 200, `read ${n + 1} must remain available`);
    assert.equal(response.headers['ratelimit-limit'], '3000');
    assert.equal(response.headers['ratelimit-remaining'], String(2999 - n));
  }
  for (let n = 0; n < 2; n += 1) {
    const response = await client.post('/api/agent/task');
    assert.equal(response.status, 200);
    assert.equal(response.headers['ratelimit-limit'], '2');
    assert.equal(response.headers['ratelimit-remaining'], String(1 - n));
  }
  const blocked = await client.post('/api/agent/task');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.text, 'Too many expensive operations, please slow down.');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal((await client.get(reads[0])).status, 200, 'generation exhaustion does not block recovery');
});

test('known reads remain bounded by the general API quota including HEAD', async () => {
  const client = createApp({ api: 3 });
  assert.equal((await client.get(reads[0])).status, 200);
  assert.equal((await client.head(reads[3])).status, 200);
  assert.equal((await client.get(reads[2])).status, 200);
  const blocked = await client.get(reads[1]);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.text, 'Too many requests, please try again later.');
  assert.equal(blocked.headers['ratelimit-limit'], '3');
  assert.equal((await client.post('/api/agent/task')).status, 200);
});

test('preview conversion and unknown GET routes still spend the expensive quota', async () => {
  const client = createApp();
  const preview = await client.get(`/api/agent/artifact/${artifactId}/preview.pdf?name=test.pptx`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['ratelimit-limit'], '2');
  assert.equal(preview.headers['ratelimit-remaining'], '1');
  assert.equal((await client.get('/api/agent/unknown-operation')).status, 200);
  assert.equal((await client.post('/api/agent/task')).status, 429);
  assert.equal((await client.get(reads[3])).status, 200);
});

test('only exact known GET/HEAD routes can use the read quota', () => {
  for (const url of reads) {
    assert.equal(policy.isAgentTaskReadRequest({ method: 'GET', originalUrl: url }), true, url);
    assert.equal(policy.isAgentTaskReadRequest({ method: 'HEAD', originalUrl: url }), true, url);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.equal(policy.isAgentTaskReadRequest({ method, originalUrl: url }), false, `${method} ${url}`);
    }
  }
  for (const url of [
    '/api/agent/task',
    '/api/agent/tasks',
    '/api/agent/artifacts/create',
    `/api/agent/task/${taskId}/retry`,
    `/api/agent/task/${taskId}/events/extra`,
    `/api/agent/artifact/${artifactId}/preview.pdf`,
    `/api/agent/artifact/${artifactId}%2fpreview.pdf`,
    '/api/agent/artifact/invalid-id',
    `/api/agent-runs/task/${taskId}`,
    `/api/rag/task/${taskId}`,
  ]) {
    assert.equal(policy.isAgentTaskReadRequest({ method: 'GET', originalUrl: url }), false, url);
  }
  assert.equal(policy.isAgentTaskReadRequest({ method: 'GET', originalUrl: `${reads[1]}/` }), true);
  assert.equal(policy.isAgentTaskReadRequest({}), false);
  assert.equal(policy.isAgentTaskReadRequest(null), false);
});
