'use strict';

// Regression: POST /api/webhooks/endpoints used to accept any http(s) URL,
// including loopback / private / cloud-metadata hosts — a stored SSRF that let
// the dispatcher POST attacker-chosen JSON to internal services. validateUrl
// now runs the shared assertSafeUrl guard.

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const authPath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const triggersPath = path.resolve(__dirname, '../src/services/trigger-registry.js');
const rlPath = path.resolve(__dirname, '../src/middleware/rate-limit-store.js');
const webhooksRoutePath = path.resolve(__dirname, '../src/routes/webhooks.js');

const authMock = {
  authenticateToken: (req, _res, next) => { req.user = { id: 'u-1', email: 'u@example.com', plan: 'FREE' }; next(); },
};
const prismaState = { rows: [] };
const prismaMock = {
  webhookEndpoint: {
    count: async () => prismaState.rows.length,
    create: async ({ data }) => { const row = { id: `ep-${prismaState.rows.length + 1}`, isActive: true, organizationId: null, events: [], createdAt: new Date(), ...data }; prismaState.rows.push(row); return row; },
  },
};
const realTriggers = require('../src/services/trigger-registry');
const triggersMock = { TRIGGERS: realTriggers.TRIGGERS, isKnownTrigger: realTriggers.isKnownTrigger };
// rate-limit-store: no-op limiter so the cap middleware never blocks these tests.
const rlMock = { check: async () => ({ allowed: true, remaining: 999 }), consume: async () => ({ allowed: true, remaining: 999 }), reset: async () => {} };

require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authMock };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };
require.cache[triggersPath] = { id: triggersPath, filename: triggersPath, loaded: true, exports: triggersMock };
try { require(rlPath); } catch { /* keep real if shape differs */ }

delete require.cache[webhooksRoutePath];
const webhooksRouter = require(webhooksRoutePath);

function post(body) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/webhooks', webhooksRouter);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.request({ hostname: '127.0.0.1', port, path: '/api/webhooks/endpoints', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => { server.close(); let json = null; try { json = buf ? JSON.parse(buf) : null; } catch { /* noop */ } resolve({ status: res.statusCode, body: json }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(JSON.stringify(body));
      req.end();
    });
  });
}

describe('webhook endpoint SSRF guard', () => {
  beforeEach(() => { prismaState.rows = []; });

  const blocked = [
    'http://127.0.0.1/hook',
    'http://localhost:8080/hook',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/internal',
    'http://192.168.1.10/admin',
    'http://[::1]/hook',
  ];
  for (const url of blocked) {
    test(`rejects private/loopback/metadata target: ${url}`, async () => {
      const res = await post({ url, events: ['*'] });
      assert.equal(res.status, 400, `expected 400 for ${url}, got ${res.status}`);
      assert.equal(prismaState.rows.length, 0, 'must not persist a blocked endpoint');
    });
  }

  test('still accepts a public https URL', async () => {
    const res = await post({ url: 'https://hooks.example.com/incoming', events: ['*'] });
    assert.equal(res.status, 201, `expected 201, got ${res.status} (${JSON.stringify(res.body)})`);
    assert.equal(prismaState.rows.length, 1);
  });
});
