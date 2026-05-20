'use strict';

/**
 * Ratchet 45 — SSO identity list / unlink endpoints.
 *
 * Covers:
 *   GET /api/users/me/sso-identities
 *     - returns the caller's identities only, sorted by lastUsedAt desc
 *     - externalId is masked (head***tail) — never echoed verbatim
 *     - orgSlug is resolved from the joined Organization row
 *     - returns [] when the Prisma client doesn't expose the model
 *
 *   DELETE /api/users/me/sso-identities/:id
 *     - 403 reauth_required when neither password nor recent session present
 *     - 404 sso_identity_not_found when the id belongs to a different user
 *     - 200 with correct password — deletes the row + audits sso_identity_unlinked
 *     - 200 with a session created within the trailing 5-minute window
 *
 *   maskExternalId helper
 *     - empty / short ids
 *     - long ids keep head + tail
 *
 * Same require-cache mocking strategy as user-2fa-disable.test.js.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-sso-identities-jwt-secret-at-least-32-chars!!';

const authMiddlewarePath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const auditPath = path.resolve(__dirname, '../src/utils/audit-log.js');
const usersRoutePath = path.resolve(__dirname, '../src/routes/users.js');
const emailPath = path.resolve(__dirname, '../src/services/email.js');
const rateLimitAuthPath = path.resolve(__dirname, '../src/middleware/rate-limit-auth.js');
const rateLimitStorePath = path.resolve(__dirname, '../src/middleware/rate-limit-store.js');

const passwordHash = bcrypt.hashSync('correct-horse', 4);

const state = {
  user: {
    id: 'u-sso-id-1',
    email: 'sso@example.com',
    name: 'SSO Tester',
    password: passwordHash,
    isAdmin: false,
    isSuperAdmin: false,
  },
  session: null,
  identities: [],
  orgs: [],
  deletes: [],
};

const authMock = {
  authenticateToken: (req, _res, next) => {
    req.user = state.user;
    req.session = state.session;
    next();
  },
};

const prismaMock = {
  user: {
    findUnique: async ({ where, select }) => {
      if (where.id !== state.user.id) return null;
      if (select) {
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = state.user[k];
        return out;
      }
      return state.user;
    },
  },
  sSOIdentity: {
    findMany: async ({ where, orderBy, select }) => {
      let rows = state.identities.filter((r) => r.userId === where.userId);
      if (orderBy && orderBy.lastUsedAt === 'desc') {
        rows = rows.slice().sort((a, b) =>
          new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
      }
      if (select) {
        return rows.map((r) => {
          const out = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = r[k];
          return out;
        });
      }
      return rows;
    },
    findUnique: async ({ where, select }) => {
      const row = state.identities.find((r) => r.id === where.id) || null;
      if (!row) return null;
      if (select) {
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = row[k];
        return out;
      }
      return row;
    },
    delete: async ({ where }) => {
      const idx = state.identities.findIndex((r) => r.id === where.id);
      if (idx >= 0) {
        const [row] = state.identities.splice(idx, 1);
        state.deletes.push(row);
        return row;
      }
      return null;
    },
  },
  organization: {
    findMany: async ({ where, select }) => {
      const ids = (where && where.id && where.id.in) || [];
      const rows = state.orgs.filter((o) => ids.includes(o.id));
      if (select) {
        return rows.map((r) => {
          const out = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = r[k];
          return out;
        });
      }
      return rows;
    },
    findFirst: async () => null,
  },
  session: {
    deleteMany: async () => ({ count: 0 }),
    update: async () => null,
  },
};

const auditMock = {
  _calls: [],
  writeAuditLog: (_db, payload) => { auditMock._calls.push(payload); },
};

const emailMock = {
  sendEmailVerification: async () => {},
  isConfigured: () => false,
};
const rateLimitAuthMock = {
  makeAuthRateLimit: () => (_req, _res, next) => next(),
};
const rateLimitStoreMock = {
  consume: async (_key, _limit, windowMs) => ({
    allowed: true,
    resetAt: new Date(Date.now() + windowMs),
  }),
};

require.cache[authMiddlewarePath] = {
  id: authMiddlewarePath, filename: authMiddlewarePath, loaded: true, exports: authMock,
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: prismaMock,
};
require.cache[auditPath] = {
  id: auditPath, filename: auditPath, loaded: true, exports: auditMock,
};
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, exports: emailMock,
};
require.cache[rateLimitAuthPath] = {
  id: rateLimitAuthPath,
  filename: rateLimitAuthPath,
  loaded: true,
  exports: rateLimitAuthMock,
};
require.cache[rateLimitStorePath] = {
  id: rateLimitStorePath,
  filename: rateLimitStorePath,
  loaded: true,
  exports: rateLimitStoreMock,
};

delete require.cache[usersRoutePath];
const usersRouter = require(usersRoutePath);
const { maskExternalId } = usersRouter.INTERNAL;

function callRoute({ method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/users', usersRouter);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? null : JSON.stringify(body);
      const headers = { 'content-type': 'application/json' };
      if (payload !== null) headers['content-length'] = Buffer.byteLength(payload);
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method, headers },
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
      if (payload !== null) req.write(payload);
      req.end();
    });
  });
}

function resetState() {
  state.user.password = passwordHash;
  state.session = null;
  state.orgs = [
    { id: 'org-a', slug: 'acme' },
    { id: 'org-b', slug: 'globex' },
  ];
  state.identities = [
    {
      id: 'id-1',
      userId: state.user.id,
      orgId: 'org-a',
      provider: 'saml',
      externalId: 'jorge@acme.example.com',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      lastUsedAt: new Date('2026-05-10T00:00:00Z'),
    },
    {
      id: 'id-2',
      userId: state.user.id,
      orgId: 'org-b',
      provider: 'oidc',
      externalId: 'sub-1234567890',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      lastUsedAt: new Date('2026-05-15T00:00:00Z'),
    },
    // Belongs to a different user — must never be visible.
    {
      id: 'id-3',
      userId: 'other-user',
      orgId: 'org-a',
      provider: 'saml',
      externalId: 'someone@else.example',
      createdAt: new Date('2026-03-01T00:00:00Z'),
      lastUsedAt: new Date('2026-05-17T00:00:00Z'),
    },
  ];
  state.deletes.length = 0;
  auditMock._calls.length = 0;
}

describe('maskExternalId', () => {
  test('returns null for empty / non-string inputs', () => {
    assert.equal(maskExternalId(null), null);
    assert.equal(maskExternalId(''), null);
    assert.equal(maskExternalId('   '), null);
    assert.equal(maskExternalId(42), null);
  });

  test('returns *** for short ids (≤ 6 chars)', () => {
    assert.equal(maskExternalId('abc'), '***');
    assert.equal(maskExternalId('abcdef'), '***');
  });

  test('keeps 3 head + 3 tail chars for longer ids', () => {
    assert.equal(maskExternalId('jorge@example.com'), 'jor***com');
    assert.equal(maskExternalId('sub-1234567890'), 'sub***890');
  });
});

describe('GET /api/users/me/sso-identities', () => {
  beforeEach(resetState);

  test('lists only the caller\'s identities sorted by lastUsedAt desc', async () => {
    const res = await callRoute({
      method: 'GET',
      urlPath: '/api/users/me/sso-identities',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.identities.length, 2);
    assert.equal(res.body.identities[0].id, 'id-2'); // newer lastUsedAt
    assert.equal(res.body.identities[1].id, 'id-1');
    // Other-user row never leaks.
    assert.ok(!res.body.identities.some((r) => r.id === 'id-3'));
  });

  test('masks externalId and resolves orgSlug', async () => {
    const res = await callRoute({
      method: 'GET',
      urlPath: '/api/users/me/sso-identities',
    });
    const acme = res.body.identities.find((r) => r.id === 'id-1');
    assert.equal(acme.provider, 'saml');
    assert.equal(acme.orgSlug, 'acme');
    assert.equal(acme.externalId, 'jor***com');
    // Raw values must never appear.
    assert.ok(!acme.externalId.includes('@'));
  });

  test('returns [] when the Prisma client doesn\'t expose sSOIdentity', async () => {
    const original = prismaMock.sSOIdentity;
    prismaMock.sSOIdentity = undefined;
    try {
      const res = await callRoute({
        method: 'GET',
        urlPath: '/api/users/me/sso-identities',
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.identities, []);
    } finally {
      prismaMock.sSOIdentity = original;
    }
  });
});

describe('DELETE /api/users/me/sso-identities/:id', () => {
  beforeEach(resetState);

  test('403 reauth_required without password and without recent session', async () => {
    state.session = { id: 's-old', createdAt: new Date(Date.now() - 60 * 60 * 1000) };
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/users/me/sso-identities/id-1',
      body: {},
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'reauth_required');
    // Row preserved.
    assert.ok(state.identities.some((r) => r.id === 'id-1'));
  });

  test('200 with correct password — deletes row and audits', async () => {
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/users/me/sso-identities/id-1',
      body: { currentPassword: 'correct-horse' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(!state.identities.some((r) => r.id === 'id-1'));
    assert.equal(state.deletes.length, 1);
    const call = auditMock._calls.find((c) => c.action === 'sso_identity_unlinked');
    assert.ok(call);
    assert.equal(call.metadata.ssoIdentityId, 'id-1');
    assert.equal(call.metadata.provider, 'saml');
    assert.equal(call.metadata.orgId, 'org-a');
  });

  test('200 with recent session (< 5min) — no password required', async () => {
    state.session = { id: 's-fresh', createdAt: new Date(Date.now() - 60 * 1000) };
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/users/me/sso-identities/id-2',
      body: {},
    });
    assert.equal(res.status, 200);
    assert.ok(!state.identities.some((r) => r.id === 'id-2'));
  });

  test('404 when the id belongs to a different user', async () => {
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/users/me/sso-identities/id-3',
      body: { currentPassword: 'correct-horse' },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'sso_identity_not_found');
    // Other-user row untouched.
    assert.ok(state.identities.some((r) => r.id === 'id-3'));
  });

  test('404 when the id does not exist', async () => {
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/users/me/sso-identities/does-not-exist',
      body: { currentPassword: 'correct-horse' },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'sso_identity_not_found');
  });
});
