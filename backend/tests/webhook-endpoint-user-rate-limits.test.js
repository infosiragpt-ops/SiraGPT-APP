'use strict';

/**
 * Ratchet 44 — per-user WebhookEndpoint create/delete rate limits.
 *
 *   POST   /api/webhooks/endpoints       → 20 creates / user / 24h
 *   DELETE /api/webhooks/endpoints/:id   → 50 deletes / user / 24h
 *
 * Limit-exceeded returns 429 with a `Retry-After` header (seconds) and
 * `{ error, retryAfter }` JSON body. Counters are scoped per-user.
 *
 * The 402 plan-cap (FREE/PRO/PRO_MAX) is checked BEFORE the rate
 * limit, so a cap-reached response does not burn a rate-limit slot.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const authPath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const triggersPath = path.resolve(__dirname, '../src/services/trigger-registry.js');
const rateLimitStorePath = path.resolve(__dirname, '../src/middleware/rate-limit-store.js');
const webhooksRoutePath = path.resolve(__dirname, '../src/routes/webhooks.js');

const authMock = {
  _user: { id: 'u-1', email: 'u@example.com', plan: 'ENTERPRISE' },
  authenticateToken: (req, _res, next) => {
    req.user = authMock._user;
    next();
  },
};

const prismaState = { rows: [] };

const prismaMock = {
  webhookEndpoint: {
    count: async ({ where }) => {
      return prismaState.rows.filter((r) => {
        if (where.userId && r.userId !== where.userId) return false;
        if ('organizationId' in where) {
          if (where.organizationId === null && r.organizationId != null) return false;
          if (where.organizationId !== null && r.organizationId !== where.organizationId) return false;
        }
        return true;
      }).length;
    },
    create: async ({ data }) => {
      const row = {
        id: `ep-${prismaState.rows.length + 1}`,
        isActive: true,
        organizationId: null,
        events: [],
        createdAt: new Date(),
        lastDeliveryAt: null,
        ...data,
      };
      prismaState.rows.push(row);
      return row;
    },
    deleteMany: async ({ where }) => {
      const before = prismaState.rows.length;
      prismaState.rows = prismaState.rows.filter((r) => {
        if (where.id && r.id !== where.id) return true;
        if (where.userId && r.userId !== where.userId) return true;
        return false;
      });
      return { count: before - prismaState.rows.length };
    },
  },
};

const realTriggers = require('../src/services/trigger-registry');
const triggersMock = {
  TRIGGERS: realTriggers.TRIGGERS,
  isKnownTrigger: realTriggers.isKnownTrigger,
};

const rateLimitMock = {
  _counters: new Map(),
  _reset() { this._counters.clear(); },
  async consume(key, limit, windowMs) {
    const cur = this._counters.get(key) || 0;
    if (cur >= limit) {
      return { allowed: false, remaining: 0, resetAt: new Date(Date.now() + windowMs) };
    }
    this._counters.set(key, cur + 1);
    return { allowed: true, remaining: Math.max(0, limit - (cur + 1)), resetAt: new Date(Date.now() + windowMs) };
  },
  createRateLimitStore: () => ({ store: null, redis: null, mode: 'memory', reason: 'test' }),
  shouldUseRedis: () => false,
  setLogger: () => {},
  _resetForTests: () => {},
};

require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authMock };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };
require.cache[triggersPath] = { id: triggersPath, filename: triggersPath, loaded: true, exports: triggersMock };
require.cache[rateLimitStorePath] = { id: rateLimitStorePath, filename: rateLimitStorePath, loaded: true, exports: rateLimitMock };

delete require.cache[webhooksRoutePath];
const webhooksRouter = require(webhooksRoutePath);

function callRoute({ method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/webhooks', webhooksRouter);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method, headers: { 'content-type': 'application/json' } },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => {
            server.close();
            let json = null;
            try { json = buf ? JSON.parse(buf) : null; } catch { /* noop */ }
            resolve({ status: res.statusCode, body: json, headers: res.headers });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

function resetState({ plan = 'ENTERPRISE' } = {}) {
  authMock._user = { id: 'u-1', email: 'u@example.com', plan };
  prismaState.rows = [];
  rateLimitMock._reset();
}

describe('per-user webhook rate limits (ratchet 44)', () => {
  beforeEach(() => resetState());

  test('POST /endpoints: 21st create within the window returns 429 + Retry-After', async () => {
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await callRoute({
        method: 'POST',
        urlPath: '/api/webhooks/endpoints',
        body: { url: `https://hook.example/${i}`, events: ['*'] },
      });
      assert.equal(ok.status, 201, `create #${i + 1} should succeed`);
    }
    const denied = await callRoute({
      method: 'POST',
      urlPath: '/api/webhooks/endpoints',
      body: { url: 'https://hook.example/over', events: ['*'] },
    });
    assert.equal(denied.status, 429);
    assert.match(denied.body.error, /rate limit exceeded/i);
    assert.match(denied.body.error, /create/);
    assert.ok(Number(denied.body.retryAfter) >= 1);
    assert.ok(denied.headers['retry-after']);
  });

  test('POST /endpoints: rate-limit counter is per-user (u-2 unaffected)', async () => {
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      await callRoute({
        method: 'POST',
        urlPath: '/api/webhooks/endpoints',
        body: { url: `https://hook.example/${i}`, events: ['*'] },
      });
    }
    const denied = await callRoute({
      method: 'POST',
      urlPath: '/api/webhooks/endpoints',
      body: { url: 'https://hook.example/over', events: ['*'] },
    });
    assert.equal(denied.status, 429);

    // Switch to a different user — fresh budget.
    authMock._user = { id: 'u-2', email: 'u2@example.com', plan: 'ENTERPRISE' };
    const otherOk = await callRoute({
      method: 'POST',
      urlPath: '/api/webhooks/endpoints',
      body: { url: 'https://hook.example/fresh', events: ['*'] },
    });
    assert.equal(otherOk.status, 201);
  });

  test('POST /endpoints: FREE 402 cap does NOT burn a rate-limit slot', async () => {
    resetState({ plan: 'FREE' });
    // FREE cap is 2 — seed 2 personal endpoints, the 3rd hits 402.
    prismaState.rows.push({ id: 'a', userId: 'u-1', organizationId: null, url: 'x', events: ['*'], isActive: true });
    prismaState.rows.push({ id: 'b', userId: 'u-1', organizationId: null, url: 'y', events: ['*'], isActive: true });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/webhooks/endpoints',
      body: { url: 'https://hook.example/cap', events: ['*'] },
    });
    assert.equal(res.status, 402);
    assert.equal(rateLimitMock._counters.get('user-webhook-create:u-1') || 0, 0);
  });

  test('POST /endpoints: validation 400 does NOT burn a rate-limit slot', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/webhooks/endpoints',
      body: { url: 'not-a-url', events: ['*'] },
    });
    assert.equal(res.status, 400);
    assert.equal(rateLimitMock._counters.get('user-webhook-create:u-1') || 0, 0);
  });

  test('DELETE /endpoints/:id: 51st delete within the window returns 429', async () => {
    for (let i = 0; i < 51; i++) {
      prismaState.rows.push({
        id: `ep-pre-${i}`, userId: 'u-1', organizationId: null,
        url: `https://hook.example/${i}`, events: ['*'], isActive: true,
      });
    }
    for (let i = 0; i < 50; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await callRoute({
        method: 'DELETE',
        urlPath: `/api/webhooks/endpoints/ep-pre-${i}`,
      });
      assert.equal(ok.status, 200, `delete #${i + 1} should succeed`);
    }
    const denied = await callRoute({
      method: 'DELETE',
      urlPath: '/api/webhooks/endpoints/ep-pre-50',
    });
    assert.equal(denied.status, 429);
    assert.match(denied.body.error, /rate limit exceeded/i);
    assert.match(denied.body.error, /delete/);
    assert.ok(denied.headers['retry-after']);
    // Target row must still exist — the denial happened before the DB mutation.
    assert.ok(prismaState.rows.some((r) => r.id === 'ep-pre-50'));
  });
});
