'use strict';

/**
 * Tests for the per-org / per-email invitation rate limits (ratchet 44).
 *
 *   - POST /api/orgs/:id/invite            → 50 creates / org / 24h
 *   - POST /api/orgs/invitation/:token/accept → 100 accepts / email / 24h
 *
 * Defense-in-depth on top of token-uniqueness + member-cap. We mirror
 * the require-cache substitution pattern used by orgs-invitations.test.js
 * and orgs-api-keys.test.js so the orgs router runs against fakes for
 * auth, prisma, audit-log, trigger registry and the rate-limit store.
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
let invIdCounter = 0;
const prismaState = {
  membership: {
    id: 'm1',
    orgId: 'org-1',
    userId: 'u-admin',
    role: 'ADMIN',
    organization: { id: 'org-1', billingPlan: 'ENTERPRISE' },
  },
  invitations: [],
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
  },
  orgInvitation: {
    count: async () => 0,
    create: async ({ data }) => {
      const row = {
        id: `inv-${++invIdCounter}`,
        orgId: data.orgId,
        email: data.email,
        role: data.role,
        token: data.token,
        invitedBy: data.invitedBy,
        acceptedAt: null,
        expiresAt: data.expiresAt,
        createdAt: new Date(),
      };
      prismaState.invitations.push(row);
      return row;
    },
    findUnique: async () => null, // not exercised in this file
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
  prismaState.invitations.length = 0;
  invIdCounter = 0;
  auditMock._calls.length = 0;
  rateLimitMock._reset();
  authMock._user = {
    id: 'u-admin',
    email: 'admin@example.com',
    name: 'Admin',
    emailVerifiedAt: new Date(),
  };
}

// ── POST /:id/invite — 50 / org / 24h ─────────────────────────────
describe('POST /api/orgs/:id/invite · per-org create rate limit', () => {
  beforeEach(resetState);

  test('allows the 50th invite and blocks the 51st with 429 + Retry-After', async () => {
    // Burn 50 successful creates against the same org.
    for (let i = 0; i < 50; i++) {
      const res = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/invite',
        body: { email: `user${i}@example.com`, role: 'MEMBER' },
      });
      assert.equal(res.status, 201, `call ${i + 1} should succeed`);
    }
    // 51st must trip the limit.
    const blocked = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/invite',
      body: { email: 'overflow@example.com', role: 'MEMBER' },
    });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.body && /rate limit/i.test(blocked.body.error));
    assert.ok(blocked.body.retryAfter > 0);
    const headerSec = Number(blocked.retryAfter);
    assert.ok(Number.isFinite(headerSec) && headerSec > 0,
      'Retry-After header must be a positive integer seconds value');
  });

  test('counter is scoped per org — a different org id is unaffected', async () => {
    // Saturate org-1.
    for (let i = 0; i < 50; i++) {
      await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/invite',
        body: { email: `a${i}@example.com`, role: 'MEMBER' },
      });
    }
    const blocked = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/invite',
      body: { email: 'overflow@example.com', role: 'MEMBER' },
    });
    assert.equal(blocked.status, 429);

    // org-2 must still work. Switch the fake membership over.
    prismaState.membership.orgId = 'org-2';
    prismaState.membership.organization = { id: 'org-2', billingPlan: 'ENTERPRISE' };
    const ok = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-2/invite',
      body: { email: 'new@example.com', role: 'MEMBER' },
    });
    assert.equal(ok.status, 201);
  });
});

// ── POST /invitation/:token/accept — 100 / email / 24h ────────────
describe('POST /api/orgs/invitation/:token/accept · per-email accept rate limit', () => {
  beforeEach(resetState);

  test('returns 429 + Retry-After after 100 attempts from the same email', async () => {
    const token = 't'.repeat(32);
    // First 100 attempts pass the limiter and then 404 on findUnique=null.
    for (let i = 0; i < 100; i++) {
      const res = await callRoute({
        method: 'POST',
        urlPath: `/api/orgs/invitation/${token}/accept`,
      });
      assert.equal(res.status, 404, `attempt ${i + 1} should 404 (passes limiter)`);
    }
    const blocked = await callRoute({
      method: 'POST',
      urlPath: `/api/orgs/invitation/${token}/accept`,
    });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.body && /rate limit/i.test(blocked.body.error));
    assert.ok(blocked.body.retryAfter > 0);
    const headerSec = Number(blocked.retryAfter);
    assert.ok(Number.isFinite(headerSec) && headerSec > 0);
  });

  test('counter is scoped per email — a different signed-in user is unaffected', async () => {
    const token = 'u'.repeat(32);
    // Saturate admin@example.com.
    for (let i = 0; i < 100; i++) {
      await callRoute({
        method: 'POST',
        urlPath: `/api/orgs/invitation/${token}/accept`,
      });
    }
    const blocked = await callRoute({
      method: 'POST',
      urlPath: `/api/orgs/invitation/${token}/accept`,
    });
    assert.equal(blocked.status, 429);

    // Different email → fresh bucket.
    authMock._user = {
      id: 'u-other',
      email: 'other@example.com',
      name: 'Other',
      emailVerifiedAt: new Date(),
    };
    const ok = await callRoute({
      method: 'POST',
      urlPath: `/api/orgs/invitation/${token}/accept`,
    });
    assert.equal(ok.status, 404, 'fresh email passes the limiter (404 from token lookup)');
  });

  test('rate-limit check runs before the token-length 400 guard does NOT short-circuit it', async () => {
    // Short token still rejected with 400 — the limiter is placed AFTER
    // the syntactic check so malformed tokens never poison the counter.
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/invitation/short/accept',
    });
    assert.equal(res.status, 400);
  });
});
