'use strict';

/**
 * Ratchet 44 — per-org Slack integration connect/test rate limits.
 *
 *   POST /api/orgs/:id/slack         → 10 connects / org / 24h
 *   POST /api/orgs/:id/slack/test    → 20 tests    / org / 24h
 *
 * Limit-exceeded returns 429 with a `Retry-After` header (seconds) and
 * `{ error, retryAfter }` JSON body. Counters are scoped per-org and
 * burned only AFTER membership/role enforcement so unauthorised probes
 * can't exhaust the daily budget. Models the orgs-webhook-rate-limits
 * suite (same pattern, slack-specific keys).
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
const slackServicePath = path.resolve(__dirname, '../src/services/slack-integration.js');
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
  slackRows: [],
};

let nextSlackId = 0;

const prismaMock = {
  orgMembership: {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      if (orgId !== prismaState.membership.orgId) return null;
      if (userId !== prismaState.membership.userId) return null;
      return { ...prismaState.membership, organization: { id: orgId, billingPlan: 'PRO' } };
    },
  },
  slackIntegration: {
    findFirst: async ({ where }) => {
      return prismaState.slackRows.find((r) => {
        if (where.organizationId && r.organizationId !== where.organizationId) return false;
        return true;
      }) || null;
    },
    create: async ({ data }) => {
      const row = {
        id: `slk-${++nextSlackId}`,
        userId: data.userId,
        organizationId: data.organizationId || null,
        webhookUrl: data.webhookUrl,
        channelName: data.channelName || null,
        isEnabled: data.isEnabled !== false,
        createdAt: new Date(),
        lastEventAt: null,
      };
      prismaState.slackRows.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = prismaState.slackRows.find((r) => r.id === where.id);
      if (!row) return null;
      Object.assign(row, data);
      return row;
    },
    deleteMany: async () => ({ count: 0 }),
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

const slackServiceMock = {
  encryptToken: (plain) => `enc::${plain}`,
  decryptToken: (cipher) => (cipher && cipher.startsWith('enc::') ? cipher.slice(5) : null),
  sendEventNotification: async () => ({ ok: true, status: 200 }),
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
require.cache[slackServicePath] = { id: slackServicePath, filename: slackServicePath, loaded: true, exports: slackServiceMock };

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
  prismaState.slackRows = [];
  auditMock._calls.length = 0;
  authMock._user = { id: 'u-admin', email: 'admin@example.com', emailVerifiedAt: new Date() };
  nextSlackId = 0;
  rateLimitMock._reset();
}

const VALID_HOOK = 'https://hooks.slack.com/services/T000/B000/abcdefghijklmnop';

describe('per-org slack rate limits (ratchet 44)', () => {
  beforeEach(() => resetState());

  test('POST slack: 11th connect within the window returns 429 + Retry-After', async () => {
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/slack',
        body: { webhookUrl: `${VALID_HOOK}${i}`, channelName: '#general' },
      });
      assert.equal(ok.status, 201, `connect #${i + 1} should succeed`);
    }
    const denied = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/slack',
      body: { webhookUrl: VALID_HOOK, channelName: '#general' },
    });
    assert.equal(denied.status, 429);
    assert.match(denied.body.error, /rate limit exceeded/i);
    assert.match(denied.body.error, /connect/);
    assert.ok(Number(denied.body.retryAfter) >= 1);
    assert.ok(denied.headers['retry-after']);
    assert.ok(Number(denied.headers['retry-after']) >= 1);
  });

  test('POST slack: rate-limit counter is per-org (org-2 unaffected)', async () => {
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
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await callRoute({
          method: 'POST',
          urlPath: '/api/orgs/org-1/slack',
          body: { webhookUrl: `${VALID_HOOK}${i}` },
        });
      }
      const denied = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/slack',
        body: { webhookUrl: VALID_HOOK },
      });
      assert.equal(denied.status, 429);

      const otherOk = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-2/slack',
        body: { webhookUrl: VALID_HOOK },
      });
      assert.equal(otherOk.status, 201);
    } finally {
      prismaMock.orgMembership.findUnique = originalFindUnique;
    }
  });

  test('POST slack: validation 400 (bad webhookUrl) does NOT burn a slot', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/slack',
      body: { webhookUrl: 'http://evil.example.com/x' },
    });
    assert.equal(res.status, 400);
    assert.equal(rateLimitMock._counters.get('org-slack-connect:org-1') || 0, 0);
  });

  test('POST slack: non-member 404 does NOT burn a slot', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-99/slack',
      body: { webhookUrl: VALID_HOOK },
    });
    assert.notEqual(res.status, 201);
    assert.equal(rateLimitMock._counters.get('org-slack-connect:org-99') || 0, 0);
  });

  test('POST slack: MEMBER 403 does NOT burn a connect slot', async () => {
    prismaState.membership.role = 'MEMBER';
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/slack',
      body: { webhookUrl: VALID_HOOK },
    });
    assert.equal(res.status, 403);
    assert.equal(rateLimitMock._counters.get('org-slack-connect:org-1') || 0, 0);
  });

  test('POST slack/test: 21st test within the window returns 429 + Retry-After', async () => {
    // Pre-populate a configured integration so /test reaches the limiter.
    prismaState.slackRows.push({
      id: 'slk-pre',
      organizationId: 'org-1',
      userId: 'u-admin',
      webhookUrl: `enc::${VALID_HOOK}`,
      channelName: '#general',
      isEnabled: true,
      createdAt: new Date(),
      lastEventAt: null,
    });
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/slack/test',
      });
      assert.equal(ok.status, 200, `test #${i + 1} should succeed`);
    }
    const denied = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/slack/test',
    });
    assert.equal(denied.status, 429);
    assert.match(denied.body.error, /rate limit exceeded/i);
    assert.match(denied.body.error, /test/);
    assert.ok(denied.headers['retry-after']);
  });

  test('POST slack/test: MEMBER 403 does NOT burn a test slot', async () => {
    prismaState.membership.role = 'MEMBER';
    prismaState.slackRows.push({
      id: 'slk-pre',
      organizationId: 'org-1',
      userId: 'u-admin',
      webhookUrl: `enc::${VALID_HOOK}`,
      channelName: '#general',
      isEnabled: true,
      createdAt: new Date(),
      lastEventAt: null,
    });
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/slack/test',
    });
    assert.equal(res.status, 403);
    assert.equal(rateLimitMock._counters.get('org-slack-test:org-1') || 0, 0);
  });
});
