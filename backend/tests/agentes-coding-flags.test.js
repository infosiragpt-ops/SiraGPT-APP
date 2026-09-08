'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
  isAgentesCodingV2Enabled,
  FLAG,
} = require('../src/services/agentes-coding/flags');
const agentesCodingRoutes = require('../src/routes/agentes-coding');

test('flag name is AGENTES_CODING_V2', () => {
  assert.equal(FLAG, 'AGENTES_CODING_V2');
});

test('disabled by default (empty env) including production', () => {
  assert.equal(isAgentesCodingV2Enabled({}), false);
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: '' }), false);
  assert.equal(isAgentesCodingV2Enabled({ NODE_ENV: 'production' }), false);
  assert.equal(isAgentesCodingV2Enabled({ NODE_ENV: 'production', AGENTES_CODING_V2: '' }), false);
});

test('enabled with 1 / true / on (case-insensitive, trimmed)', () => {
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: '1' }), true);
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: 'true' }), true);
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: ' ON ' }), true);
});

test('disabled with 0 / false / off / garbage', () => {
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: '0' }), false);
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: 'false' }), false);
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: 'off' }), false);
  assert.equal(isAgentesCodingV2Enabled({ AGENTES_CODING_V2: 'yes please' }), false);
});

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, path) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /health is queryable and reports the injected env flag', async () => {
  const prev = process.env.AGENTES_CODING_V2;
  delete process.env.AGENTES_CODING_V2;
  const app = express();
  app.use('/api/agentes-coding', agentesCodingRoutes);
  const server = await startServer(app);
  try {
    const off = await request(server, '/api/agentes-coding/health');
    assert.equal(off.status, 200);
    assert.equal(off.json.ok, true);
    assert.equal(off.json.enabled, false);

    process.env.AGENTES_CODING_V2 = '1';
    const on = await request(server, '/api/agentes-coding/health');
    assert.equal(on.status, 200);
    assert.equal(on.json.enabled, true);
  } finally {
    if (prev === undefined) delete process.env.AGENTES_CODING_V2;
    else process.env.AGENTES_CODING_V2 = prev;
    server.close();
  }
});

test('non-health paths 404 while the Phase 1 stub has no other routes', async () => {
  const prev = process.env.AGENTES_CODING_V2;
  process.env.AGENTES_CODING_V2 = '1';
  const app = express();
  app.use('/api/agentes-coding', agentesCodingRoutes);
  const server = await startServer(app);
  try {
    const res = await request(server, '/api/agentes-coding/sandbox');
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'not_found');
  } finally {
    if (prev === undefined) delete process.env.AGENTES_CODING_V2;
    else process.env.AGENTES_CODING_V2 = prev;
    server.close();
  }
});
