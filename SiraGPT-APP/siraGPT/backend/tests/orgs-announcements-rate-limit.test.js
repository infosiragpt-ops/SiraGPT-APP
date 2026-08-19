'use strict';

/**
 * Tests for the per-org announcement create rate limit (cycle 122).
 *
 *   - POST /api/orgs/:id/announcements → 20 creates / org / 24h
 *
 * Mirrors the require-cache substitution pattern used by
 * orgs-invitations-rate-limit.test.js so the orgs router runs against
 * fakes for auth, prisma, audit-log, trigger registry and the
 * rate-limit store.
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

// ── auth ──────────────────────────────────────────────────────────
const authMock = {
  _user: {
    id: 'u-admin',
    email: 'admin@example.com',
    name: 'Admin',
    emailVerifiedAt: new Date(),
  },
  authenticateToken: (req, _res, next) => {
    req.user = authMock._user;
    next();
  },
};

// ── prisma fake ───────────────────────────────────────────────────
let annIdCounter = 0;
const prismaState = {
  membership: {
    id: 'm1',
    orgId: 'org-1',
    userId: 'u-admin',
    role: 'ADMIN',
    organization: { id: 'org-1', billingPlan: 'ENTERPRISE' },
  },
  announcements: [],
};

const prismaMock = {
  orgMembership: {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      if (orgId !== prismaState.membership.orgId) return null;
      if (userId !== prismaState.membership.userId) return null;
      return { ...prismaState.membership };
    },
    count: async () => 1,
    findMany: async () => [],
  },
  orgAnnouncement: {
    create: async ({ data }) => {
      const row = {
        id: `ann-${++annIdCounter}`,
        orgId: data.orgId,
        title: data.title,
        body: data.body,
        severity: data.severity,
        createdById: data.createdById,
        expiresAt: data.expiresAt ?? null,
        createdAt: new Date(),
      };
      prismaState.announcements.push(row);
      return row;
    },
  },
};

// ── audit + triggers ──────────────────────────────────────────────
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

// ── rate-limit store fake (per-key counters) ──────────────────────
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
require.cache[rateLimitStorePath] = {
  id: rateLimitStorePath, filename: rateLimitStorePath, loaded: true, exports: rateLimitMock,
};

delete require.cache[orgsRoutePath];
const orgsRouter = require(orgsRoutePath);

// ── helper: in-process server ─────────────────────────────────────
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
            resolve({
              status: res.statusCode,
              body: json,
              retryAfter: res.headers['retry-after'],
            });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

function resetState() {
  prismaState.announcements.length = 0;
  annIdCounter = 0;
  auditMock._calls.length = 0;
  rateLimitMock._reset();
  prismaState.membership.orgId = 'org-1';
  prismaState.membership.role = 'ADMIN';
  prismaState.membership.organization = { id: 'org-1', billingPlan: 'ENTERPRISE' };
  authMock._user = {
    id: 'u-admin',
    email: 'admin@example.com',
    name: 'Admin',
    emailVerifiedAt: new Date(),
  };
}

function makeBody(i) {
  return { title: `Notice ${i}`, body: `Body ${i}`, severity: 'info' };
}

// ── POST /:id/announcements — 20 / org / 24h ──────────────────────
describe('POST /api/orgs/:id/announcements · per-org create rate limit (cycle 122)', () => {
  beforeEach(resetState);

  test('allows the 20th create and blocks the 21st with 429 + Retry-After', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/announcements',
        body: makeBody(i),
      });
      assert.equal(res.status, 201, `call ${i + 1} should succeed`);
    }
    const blocked = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements',
      body: makeBody(99),
    });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.body && /rate limit/i.test(blocked.body.error));
    assert.ok(blocked.body.retryAfter > 0);
    const headerSec = Number(blocked.retryAfter);
    assert.ok(
      Number.isFinite(headerSec) && headerSec > 0,
      'Retry-After header must be a positive integer seconds value',
    );
  });

  test('counter is scoped per org — a different org id is unaffected', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/announcements',
        body: makeBody(i),
      });
      assert.equal(r.status, 201);
    }
    const blocked = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements',
      body: makeBody(21),
    });
    assert.equal(blocked.status, 429);

    // Switch membership over to org-2 and confirm the bucket is fresh.
    prismaState.membership.orgId = 'org-2';
    prismaState.membership.organization = { id: 'org-2', billingPlan: 'ENTERPRISE' };
    const ok = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-2/announcements',
      body: makeBody(1),
    });
    assert.equal(ok.status, 201);
  });

  test('limiter runs after the role gate — non-admin sees 403 (counter untouched)', async () => {
    prismaState.membership.role = 'MEMBER';
    for (let i = 0; i < 25; i++) {
      const res = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/announcements',
        body: makeBody(i),
      });
      assert.equal(res.status, 403, `non-admin attempt ${i + 1} should 403`);
    }
    // Promote back to ADMIN; the bucket must still be untouched.
    prismaState.membership.role = 'ADMIN';
    const ok = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/announcements',
      body: makeBody(100),
    });
    assert.equal(ok.status, 201, 'fresh counter after role gate rejections');
  });
});
