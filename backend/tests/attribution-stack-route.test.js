'use strict';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');

const router = require('../src/routes/attribution-stack');

function requestJson(server, { method = 'GET', path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path, method,
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
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/attribution-stack', router);
  const server = app.listen(0);
  try { await handler(server); }
  finally { await new Promise((r) => server.close(r)); }
}

test('GET /health returns module map', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, { method: 'GET', path: '/api/attribution-stack/health' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.modules.stackRunner);
  });
});

test('POST /run rejects empty prompt', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, { method: 'POST', path: '/api/attribution-stack/run', body: { prompt: '' } });
    assert.strictEqual(r.status, 400);
  });
});

test('POST /run returns bundle for real prompt', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST', path: '/api/attribution-stack/run',
      body: { userId: 'rt', chatId: 'c', prompt: 'Build me a chart of revenue.' },
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.ok);
    assert.ok(typeof r.body.durationMs === 'number');
  });
});

test('POST /run-light skips provenance stamp', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST', path: '/api/attribution-stack/run-light',
      body: { userId: 'rt', chatId: 'c', prompt: 'no stamp please' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.sections.provenance, undefined);
  });
});

test('POST /run-light rejects empty prompt', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, { method: 'POST', path: '/api/attribution-stack/run-light', body: {} });
    assert.strictEqual(r.status, 400);
  });
});

test('POST /run honors optional fields', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST', path: '/api/attribution-stack/run',
      body: { userId: 'rt', chatId: 'c', turnIndex: 5, prompt: 'help me deploy' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.turnIndex, 5);
  });
});

test('POST /run anonymous still works', async () => {
  await withServer(async (server) => {
    const r = await requestJson(server, {
      method: 'POST', path: '/api/attribution-stack/run',
      body: { prompt: 'hello world' },
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.ok);
  });
});
