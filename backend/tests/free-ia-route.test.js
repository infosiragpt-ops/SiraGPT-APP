'use strict';

// Unit tests for the /api/free-ia/* status endpoint. Uses a minimal
// in-process Express harness — no network, no DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const freeIaRoutes = require('../src/routes/free-ia');

function startServer() {
  const app = express();
  app.use('/api/free-ia', freeIaRoutes);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseURL: `http://127.0.0.1:${port}` });
    });
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ status: res.statusCode, body });
        } catch (err) { reject(err); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

test('GET /api/free-ia/status reports disabled when CEREBRAS_API_KEY is unset', async () => {
  const prevKey = process.env.CEREBRAS_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await fetchJSON(`${baseURL}/api/free-ia/status`);
    assert.equal(status, 200);
    assert.equal(body.enabled, false);
    assert.equal(body.reason, 'no_api_key');
    assert.equal(body.provider, 'Cerebras');
    assert.equal(body.model, 'llama-3.1-8b');
    assert.equal(body.displayName, 'Free IA');
    // baseURL is internal-only — must not leak in the response.
    assert.equal(body.baseURL, undefined);
    assert.equal(body.apiKey, undefined);
  } finally {
    server.close();
    if (prevKey !== undefined) process.env.CEREBRAS_API_KEY = prevKey;
  }
});

test('GET /api/free-ia/status reports enabled when CEREBRAS_API_KEY is set', async () => {
  const prevKey = process.env.CEREBRAS_API_KEY;
  process.env.CEREBRAS_API_KEY = 'csk-test-status-endpoint';
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await fetchJSON(`${baseURL}/api/free-ia/status`);
    assert.equal(status, 200);
    assert.equal(body.enabled, true);
    assert.equal(body.reason, 'ok');
    assert.equal(body.provider, 'Cerebras');
    assert.equal(body.model, 'llama-3.1-8b');
    assert.equal(body.displayName, 'Free IA');
    assert.equal(body.apiKey, undefined, 'API key must never be returned');
  } finally {
    server.close();
    if (prevKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = prevKey;
  }
});

test('GET /api/free-ia/configured returns boolean only', async () => {
  const prevKey = process.env.CEREBRAS_API_KEY;
  process.env.CEREBRAS_API_KEY = 'csk-test-configured';
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await fetchJSON(`${baseURL}/api/free-ia/configured`);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['configured']);
    assert.equal(body.configured, true);
  } finally {
    server.close();
    if (prevKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = prevKey;
  }
});

test('GET /api/free-ia/metrics returns a JSON snapshot of the fallback counter', async () => {
  const metrics = require('../src/services/free-ia-metrics');
  metrics.reset();
  metrics.recordFallback({ feature: 'paraphrase', amount: 5 });
  metrics.recordFallback({ feature: 'generate', amount: 3 });
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await fetchJSON(`${baseURL}/api/free-ia/metrics`);
    assert.equal(status, 200);
    assert.equal(body.totalFallbacks, 2);
    assert.equal(body.totalCostBlocked, '8');
    assert.equal(body.perFeature.paraphrase.count, 1);
    assert.equal(body.perFeature.generate.count, 1);
    assert.ok(body.lastEventAt);
  } finally {
    server.close();
    metrics.reset();
  }
});

test('GET /api/free-ia/health returns 503 when Cerebras key is missing', async () => {
  const prevKey = process.env.CEREBRAS_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await fetchJSON(`${baseURL}/api/free-ia/health`);
    assert.equal(status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.enabled, false);
    assert.equal(body.reason, 'not_configured');
  } finally {
    server.close();
    if (prevKey !== undefined) process.env.CEREBRAS_API_KEY = prevKey;
  }
});

test('GET /api/free-ia/health returns 200 when configured + clean counters', async () => {
  const metrics = require('../src/services/free-ia-metrics');
  metrics.reset();
  const prevKey = process.env.CEREBRAS_API_KEY;
  process.env.CEREBRAS_API_KEY = 'csk-health-ok';
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await fetchJSON(`${baseURL}/api/free-ia/health`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.enabled, true);
    assert.equal(body.degraded, false);
    assert.equal(body.fallbacks, 0);
  } finally {
    server.close();
    metrics.reset();
    if (prevKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = prevKey;
  }
});

test('GET /api/free-ia/health returns 503 when success rate < 0.5 with >=10 samples', async () => {
  const metrics = require('../src/services/free-ia-metrics');
  metrics.reset();
  // Burn through 10 upstream calls with 80% failure → degraded.
  for (let i = 0; i < 8; i += 1) metrics.recordUpstreamError({ code: '503' });
  for (let i = 0; i < 2; i += 1) metrics.recordUpstreamSuccess();
  const prevKey = process.env.CEREBRAS_API_KEY;
  process.env.CEREBRAS_API_KEY = 'csk-health-degraded';
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await fetchJSON(`${baseURL}/api/free-ia/health`);
    assert.equal(status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.enabled, true);
    assert.equal(body.degraded, true);
    assert.equal(body.successRate, 0.2);
  } finally {
    server.close();
    metrics.reset();
    if (prevKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = prevKey;
  }
});

test('GET /api/free-ia/health stays 200 with <10 samples even if rate is poor', async () => {
  const metrics = require('../src/services/free-ia-metrics');
  metrics.reset();
  metrics.recordUpstreamError({ code: '503' });
  metrics.recordUpstreamError({ code: '503' });
  metrics.recordUpstreamSuccess();
  const prevKey = process.env.CEREBRAS_API_KEY;
  process.env.CEREBRAS_API_KEY = 'csk-health-low-samples';
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await fetchJSON(`${baseURL}/api/free-ia/health`);
    assert.equal(status, 200, `expected 200 (low samples), got ${status}`);
    assert.equal(body.degraded, false);
  } finally {
    server.close();
    metrics.reset();
    if (prevKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = prevKey;
  }
});

test('GET /api/free-ia/metrics/summary returns the one-line digest', async () => {
  const metrics = require('../src/services/free-ia-metrics');
  metrics.reset();
  metrics.recordFallback({ feature: 'paraphrase', amount: 5 });
  metrics.recordUpstreamSuccess();
  metrics.recordUpstreamSuccess();
  metrics.recordUpstreamError({ code: '503' });
  const { server, baseURL } = await startServer();
  try {
    const { status, body } = await fetchJSON(`${baseURL}/api/free-ia/metrics/summary`);
    assert.equal(status, 200);
    assert.equal(body.fallbacks, 1);
    assert.equal(body.upstreamSuccess, 2);
    assert.equal(body.upstreamTotal, 3);
    assert.match(body.line, /Free IA: 1 fallbacks/);
    assert.match(body.line, /2\/3 upstream OK/);
  } finally {
    server.close();
    metrics.reset();
  }
});

test('POST /api/free-ia/metrics/reset requires admin auth (401 anonymous)', async () => {
  const metrics = require('../src/services/free-ia-metrics');
  metrics.reset();
  metrics.recordFallback({ feature: 'paraphrase', amount: 9 });
  const { server, baseURL } = await startServer();
  try {
    const resp = await new Promise((resolve, reject) => {
      const req = http.request(new URL(`${baseURL}/api/free-ia/metrics/reset`), { method: 'POST' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    // 401 from authenticateToken — counter must not be reset.
    assert.ok([401, 403].includes(resp.status), `expected 401/403, got ${resp.status}`);
    const after = metrics.snapshot();
    assert.equal(after.totalFallbacks, 1, 'counter should be untouched without auth');
  } finally {
    server.close();
    metrics.reset();
  }
});

test('GET /api/free-ia/metrics.prom returns Prometheus text format', async () => {
  const metrics = require('../src/services/free-ia-metrics');
  metrics.reset();
  metrics.recordFallback({ feature: 'paraphrase', amount: 7 });
  const { server, baseURL } = await startServer();
  try {
    // Use http.get to inspect Content-Type without forcing JSON parse.
    const url = `${baseURL}/api/free-ia/metrics.prom`;
    const promResp = await new Promise((resolve, reject) => {
      http.get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf8'),
        }));
        res.on('error', reject);
      }).on('error', reject);
    });
    assert.equal(promResp.status, 200);
    assert.match(promResp.contentType, /^text\/plain/);
    assert.match(promResp.body, /^sira_free_ia_fallback_total 1$/m);
    assert.match(promResp.body, /sira_free_ia_fallback_total\{feature="paraphrase"\} 1/);
  } finally {
    server.close();
    metrics.reset();
  }
});
