'use strict';

/**
 * Tests for /api/orgs/:id/api-keys (ratchet 45):
 *   - POST   create (ADMIN+) returns plaintext exactly once
 *   - GET    list (ADMIN+) returns redacted rows
 *   - DELETE remove (ADMIN+)
 *   - role enforcement + 404 for non-members
 *
 * Mirrors the pattern in orgs-invitations.test.js: require-cache
 * substitution for auth + prisma + audit-log, then mount the router
 * onto an in-process Express server.
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
const orgsRoutePath = path.resolve(__dirname, '../src/routes/orgs.js');

const authMock = {
  _user: { id: 'u-admin', email: 'admin@example.com' },
  authenticateToken: (req, _res, next) => {
    req.user = authMock._user;
    next();
  },
};

const prismaState = {
  membership: { id: 'm1', orgId: 'org-1', userId: 'u-admin', role: 'ADMIN' },
  apiKeys: [],
};

let nextId = 0;
const prismaMock = {
  orgMembership: {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      if (orgId !== prismaState.membership.orgId) return null;
      if (userId !== prismaState.membership.userId) return null;
      return { ...prismaState.membership, organization: { id: orgId } };
    },
  },
  apiKey: {
    create: async ({ data }) => {
      const row = {
        id: `key-${++nextId}`,
        name: data.name,
        prefix: data.prefix,
        tokenHash: data.tokenHash,
        organizationId: data.organizationId || null,
        userId: data.userId,
        scopes: Array.isArray(data.scopes) ? [...data.scopes] : [],
        lastUsedAt: null,
        expiresAt: data.expiresAt || null,
        createdAt: new Date(),
      };
      prismaState.apiKeys.push(row);
      return row;
    },
    findMany: async ({ where, orderBy, take }) => {
      void orderBy; void take;
      return prismaState.apiKeys.filter(
        (r) => !where?.organizationId || r.organizationId === where.organizationId
      );
    },
    deleteMany: async ({ where }) => {
      const before = prismaState.apiKeys.length;
      prismaState.apiKeys = prismaState.apiKeys.filter((r) => {
        if (where.id && r.id !== where.id) return true;
        if (where.organizationId && r.organizationId !== where.organizationId) return true;
        return false;
      });
      return { count: before - prismaState.apiKeys.length };
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

require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authMock };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: auditMock };
require.cache[triggersPath] = { id: triggersPath, filename: triggersPath, loaded: true, exports: triggersMock };

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
            resolve({ status: res.statusCode, body: json });
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
  prismaState.apiKeys = [];
  auditMock._calls.length = 0;
  authMock._user = { id: 'u-admin', email: 'admin@example.com' };
  nextId = 0;
}

// ── POST /api/orgs/:id/api-keys ────────────────────────────────────
describe('POST /api/orgs/:id/api-keys', () => {
  beforeEach(() => resetState());

  test('creates a key and returns the plaintext token exactly once', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'CI bot', scopes: ['read', 'write'] },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.apiKey.token.startsWith('sk_'));
    assert.equal(res.body.apiKey.prefix.length, 8);
    assert.equal(res.body.apiKey.organizationId, 'org-1');
    assert.deepEqual(res.body.apiKey.scopes, ['read', 'write']);
    assert.match(res.body.apiKey.warning, /Store this token/i);

    assert.equal(prismaState.apiKeys.length, 1);
    // tokenHash never leaves the server
    assert.equal(res.body.apiKey.tokenHash, undefined);

    // audit log fired
    assert.equal(auditMock._calls.length, 1);
    assert.equal(auditMock._calls[0].action, 'org_api_key_create');
  });

  test('rejects missing name', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: {},
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /name is required/);
  });

  test('rejects invalid scopes', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'x', scopes: ['has space'] },
    });
    assert.equal(res.status, 400);
  });

  test('rejects expiresAt in the past', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'x', expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    assert.equal(res.status, 400);
  });

  test('MEMBER role is rejected (403)', async () => {
    prismaState.membership.role = 'MEMBER';
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'x' },
    });
    assert.equal(res.status, 403);
  });

  test('non-member returns 404', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-other/api-keys',
      body: { name: 'x' },
    });
    assert.equal(res.status, 404);
  });
});

// ── GET /api/orgs/:id/api-keys ─────────────────────────────────────
describe('GET /api/orgs/:id/api-keys', () => {
  beforeEach(() => resetState());

  test('lists keys with redacted shape (no token, no hash)', async () => {
    // Seed via the create endpoint to keep the test honest.
    await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'one' },
    });
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/api-keys' });
    assert.equal(res.status, 200);
    assert.equal(res.body.apiKeys.length, 1);
    const item = res.body.apiKeys[0];
    assert.equal(item.name, 'one');
    assert.ok(item.redacted.startsWith('sk_'));
    assert.equal(item.token, undefined);
    assert.equal(item.tokenHash, undefined);
  });

  test('VIEWER role is rejected (403)', async () => {
    prismaState.membership.role = 'VIEWER';
    const res = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/api-keys' });
    assert.equal(res.status, 403);
  });
});

// ── DELETE /api/orgs/:id/api-keys/:keyId ───────────────────────────
describe('DELETE /api/orgs/:id/api-keys/:keyId', () => {
  beforeEach(() => resetState());

  test('removes the row and writes audit log', async () => {
    const created = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'doomed' },
    });
    const keyId = created.body.apiKey.id;
    auditMock._calls.length = 0;

    const del = await callRoute({
      method: 'DELETE',
      urlPath: `/api/orgs/org-1/api-keys/${keyId}`,
    });
    assert.equal(del.status, 200);
    assert.equal(prismaState.apiKeys.length, 0);
    assert.equal(auditMock._calls[0].action, 'org_api_key_delete');
  });

  test('returns 404 for unknown keyId', async () => {
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/orgs/org-1/api-keys/nope',
    });
    assert.equal(res.status, 404);
  });

  test('MEMBER role is rejected (403)', async () => {
    prismaState.membership.role = 'MEMBER';
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/orgs/org-1/api-keys/anything',
    });
    assert.equal(res.status, 403);
  });
});
