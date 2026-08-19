'use strict';

/**
 * Ratchet 44 — per-org WebhookEndpoint create/delete rate limits.
 *
 *   POST   /api/orgs/:id/webhooks               → 20 creates / org / 24h
 *   DELETE /api/orgs/:id/webhooks/:endpointId   → 50 deletes / org / 24h
 *
 * Limit-exceeded returns 429 with a `Retry-After` header (seconds) and
 * `{ error, retryAfter }` JSON body. Counters are scoped per-org and
 * burned only AFTER membership/role enforcement so unauthorised probes
 * can't exhaust the daily budget.
 *
 * Mirrors the api-key rate-limit suite in orgs-api-keys.test.js.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const authPath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const auditPath = path.resolve(__dirname, '../src/utils/audit-log.js');
const triggersPath = path.resolve(__dirname, '../src/services/trigger-registry.js');
const rateLimitStorePath = path.resolve(__dirname, '../src/middleware/rate-limit-store.js');
const orgsRoutePath = path.resolve(__dirname, '../src/routes/orgs.js');

const authMock = {
  _user: { id: 'u-admin', email: 'admin@example.com', emailVerifiedAt: new Date() },
  authenticateToken: (req, _res, next) => {
    req.user = authMock._user;
    next();
  },
};

const prismaState = {
  membership: { id: 'm1', orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' },
  endpoints: [],
};

let nextEpId = 0;

const prismaMock = {
  orgMembership: {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      if (orgId !== prismaState.membership.orgId) return null;
      if (userId !== prismaState.membership.userId) return null;
      return { ...prismaState.membership, organization: { id: orgId, billingPlan: 'PRO' } };
    },
  },
  webhookEndpoint: {
    create: async ({ data }) => {
      const row = {
        id: `ep-${++nextEpId}`,
        userId: data.userId,
        organizationId: data.organizationId || null,
        url: data.url,
        events: Array.isArray(data.events) ? [...data.events] : [],
        secret: data.secret,
        isActive: data.isActive !== false,
        createdAt: new Date(),
        lastDeliveryAt: null,
      };
      prismaState.endpoints.push(row);
      return row;
    },
    deleteMany: async ({ where }) => {
      const before = prismaState.endpoints.length;
      prismaState.endpoints = prismaState.endpoints.filter((e) => {
        if (where.id && e.id !== where.id) return true;
        if (where.organizationId && e.organizationId !== where.organizationId) return true;
        return false;
      });
      return { count: before - prismaState.endpoints.length };
    },
  },
};

const auditMock = {
  _calls: [],
  writeAuditLog: (_db, payload) => { auditMock._calls.push(payload); },
};

const triggersMock = {
  TRIGGERS: [],
  isKnownTrigger: () => true,
  publish: async () => ({ dispatched: 0, deduped: false, errors: [] }),
  publishDebounced: async () => {},
  resetForTests: () => {},
};

const rateLimitMock = {
  _counters: new Map(),
  _reset() { this._counters.clear(); },
  async consume(key, limit, windowMs) {
    const cur = this._counters.get(key) || 0;
    if (cur >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + windowMs),
      };
    }
    this._counters.set(key, cur + 1);
    return {
      allowed: true,
      remaining: Math.max(0, limit - (cur + 1)),
      resetAt: new Date(Date.now() + windowMs),
    };
  },
  createRateLimitStore: () => ({ store: null, redis: null, mode: 'memory', reason: 'test' }),
  shouldUseRedis: () => false,
  setLogger: () => {},
  _resetForTests: () => {},
};

require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authMock };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: auditMock };
require.cache[triggersPath] = { id: triggersPath, filename: triggersPath, loaded: true, exports: triggersMock };
require.cache[rateLimitStorePath] = { id: rateLimitStorePath, filename: rateLimitStorePath, loaded: true, exports: rateLimitMock };

delete require.cache[orgsRoutePath];
const orgsRouter = require(orgsRoutePath);

function callRoute({ method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/orgs', orgsRouter);
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

function resetState({ role = 'ADMIN' } = {}) {
  prismaState.membership = { id: 'm1', orgId: 'org-1', userId: 'u-admin', role };
  prismaState.endpoints = [];
  auditMock._calls.length = 0;
  authMock._user = { id: 'u-admin', email: 'admin@example.com', emailVerifiedAt: new Date() };
  nextEpId = 0;
  rateLimitMock._reset();
}

describe('per-org webhook rate limits (ratchet 44)', () => {
  beforeEach(() => resetState());

  test('POST webhooks: 21st create within the window returns 429 + Retry-After', async () => {
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/webhooks',
        body: { url: `https://hook.example/${i}`, events: ['*'] },
      });
      assert.equal(ok.status, 201, `create #${i + 1} should succeed`);
    }
    const denied = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/webhooks',
      body: { url: 'https://hook.example/over', events: ['*'] },
    });
    assert.equal(denied.status, 429);
    assert.match(denied.body.error, /rate limit exceeded/i);
    assert.match(denied.body.error, /create/);
    assert.ok(Number(denied.body.retryAfter) >= 1);
    assert.ok(denied.headers['retry-after']);
    assert.ok(Number(denied.headers['retry-after']) >= 1);
  });

  test('POST webhooks: rate-limit counter is per-org (org-2 unaffected)', async () => {
    const originalFindUnique = prismaMock.orgMembership.findUnique;
    prismaMock.orgMembership.findUnique = async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      if (userId !== 'u-admin') return null;
      if (orgId === 'org-1' || orgId === 'org-2') {
        return { id: 'm', orgId, userId, role: 'ADMIN', organization: { id: orgId, billingPlan: 'PRO' } };
      }
      return null;
    };
    try {
      for (let i = 0; i < 20; i++) {
        // eslint-disable-next-line no-await-in-loop
        await callRoute({
          method: 'POST',
          urlPath: '/api/orgs/org-1/webhooks',
          body: { url: `https://hook.example/${i}`, events: ['*'] },
        });
      }
      const denied = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/webhooks',
        body: { url: 'https://hook.example/over', events: ['*'] },
      });
      assert.equal(denied.status, 429);

      const otherOk = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-2/webhooks',
        body: { url: 'https://hook.example/fresh', events: ['*'] },
      });
      assert.equal(otherOk.status, 201);
    } finally {
      prismaMock.orgMembership.findUnique = originalFindUnique;
    }
  });

  test('POST webhooks: non-member 404 does NOT burn a rate-limit slot', async () => {
    // u-admin is a member of org-1, not org-99.
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-99/webhooks',
      body: { url: 'https://hook.example/x', events: ['*'] },
    });
    assert.notEqual(res.status, 201);
    assert.equal(rateLimitMock._counters.get('org-webhook-create:org-99') || 0, 0);
  });

  test('DELETE webhooks: 51st delete within the window returns 429 + Retry-After', async () => {
    // Pre-populate enough endpoints so each delete actually hits the DB.
    for (let i = 0; i < 51; i++) {
      prismaState.endpoints.push({
        id: `ep-pre-${i}`,
        organizationId: 'org-1',
        userId: 'u-admin',
        url: `https://hook.example/${i}`,
        events: ['*'],
        secret: 'whk_' + 'a'.repeat(48),
        isActive: true,
        createdAt: new Date(),
      });
    }
    for (let i = 0; i < 50; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await callRoute({
        method: 'DELETE',
        urlPath: `/api/orgs/org-1/webhooks/ep-pre-${i}`,
      });
      assert.equal(ok.status, 200, `delete #${i + 1} should succeed`);
    }
    const denied = await callRoute({
      method: 'DELETE',
      urlPath: '/api/orgs/org-1/webhooks/ep-pre-50',
    });
    assert.equal(denied.status, 429);
    assert.match(denied.body.error, /rate limit exceeded/i);
    assert.match(denied.body.error, /delete/);
    assert.ok(denied.headers['retry-after']);
    // The endpoint targeted by the denied request must still exist.
    assert.ok(prismaState.endpoints.some((e) => e.id === 'ep-pre-50'));
  });

  test('DELETE webhooks: MEMBER 403 does NOT burn a delete slot', async () => {
    prismaState.membership.role = 'MEMBER';
    prismaState.endpoints.push({
      id: 'ep-x',
      organizationId: 'org-1',
      userId: 'u-admin',
      url: 'https://hook.example/x',
      events: ['*'],
      secret: 'whk_' + 'a'.repeat(48),
      isActive: true,
      createdAt: new Date(),
    });
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/orgs/org-1/webhooks/ep-x',
    });
    assert.equal(res.status, 403);
    assert.equal(rateLimitMock._counters.get('org-webhook-delete:org-1') || 0, 0);
  });
});
