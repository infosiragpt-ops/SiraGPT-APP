'use strict';

const test = require('node:test');
const assert = require('node:assert');

const express = require('express');
const http = require('node:http');

const router = require('../src/routes/attribution-explainer');

function requestJson(server, { method = 'GET', path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload ? Buffer.byteLength(payload) : 0 },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(handler) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/attribution-explainer', router);
  const server = app.listen(0);
  try { await handler(server); }
  finally { await new Promise((r) => server.close(r)); }
}

test('GET /health returns module load status', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, { method: 'GET', path: '/api/attribution-explainer/health' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.modules);
    assert.strictEqual(r.body.modules.supernodeMerger, true);
    assert.strictEqual(r.body.modules.budgetAllocator, true);
    assert.strictEqual(r.body.modules.cache, true);
  });
});

test('GET /cache-stats returns telemetry', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, { method: 'GET', path: '/api/attribution-explainer/cache-stats' });
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.body.size === 'number');
    assert.ok(typeof r.body.hitRate === 'number');
  });
});

test('POST /explain returns intent + supernodes for a real prompt', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-explainer/explain',
      body: { prompt: 'Crea una gráfica de barras con las ventas del backend por mes.' },
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body);
    assert.ok(Array.isArray(r.body.supernodes));
    assert.ok(typeof r.body.multiHopDepth === 'number');
    assert.ok(r.body.stats);
  });
});

test('POST /explain rejects empty prompt', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-explainer/explain',
      body: { prompt: '' },
    });
    assert.strictEqual(r.status, 400);
  });
});

test('POST /supernodes clusters caller-supplied features', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-explainer/supernodes',
      body: {
        features: [
          { kind: 'topic', label: 'backend deployment', weight: 0.9 },
          { kind: 'topic', label: 'backend deploy', weight: 0.7 },
          { kind: 'topic', label: 'unrelated', weight: 0.4 },
        ],
      },
    });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.supernodes));
    assert.ok(typeof r.body.block === 'string');
  });
});

test('POST /supernodes rejects missing features array', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-explainer/supernodes',
      body: {},
    });
    assert.strictEqual(r.status, 400);
  });
});

test('POST /budget previews allocator output', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST',
      path: '/api/attribution-explainer/budget',
      body: {
        blocks: [
          { kind: 'master-prompt', text: 'x'.repeat(400) },
          { kind: 'evidence', text: 'x'.repeat(8000) },
        ],
        budgetTokens: 500,
      },
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.allocation);
    assert.ok(Array.isArray(r.body.trimmedBlocks));
    assert.ok(typeof r.body.summary === 'string');
  });
});

test('GET /saliency/:chatId requires userId', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'GET',
      path: '/api/attribution-explainer/saliency/abc',
    });
    assert.ok(r.status === 400 || r.status === 503);
  });
});
