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
const rateLimitStorePath = path.resolve(__dirname, '../src/middleware/rate-limit-store.js');
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

function matchApiKeyWhere(row, where) {
  if (!where) return true;
  if (where.organizationId && row.organizationId !== where.organizationId) return false;
  if (where.id) {
    if (typeof where.id === 'object' && Array.isArray(where.id.in)) {
      if (!where.id.in.includes(row.id)) return false;
    } else if (row.id !== where.id) {
      return false;
    }
  }
  if (Object.prototype.hasOwnProperty.call(where, 'deletedAt')) {
    if (where.deletedAt === null && row.deletedAt) return false;
  }
  if (Array.isArray(where.OR)) {
    const ok = where.OR.some((cond) => {
      if (cond.name && typeof cond.name === 'object' && 'contains' in cond.name) {
        const needle = cond.name.mode === 'insensitive'
          ? String(cond.name.contains).toLowerCase()
          : String(cond.name.contains);
        const hay = cond.name.mode === 'insensitive'
          ? String(row.name || '').toLowerCase()
          : String(row.name || '');
        return hay.includes(needle);
      }
      if (typeof cond.prefix === 'string') return row.prefix === cond.prefix;
      return false;
    });
    if (!ok) return false;
  }
  return true;
}

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
    findFirst: async ({ where }) => {
      return prismaState.apiKeys.find((r) => {
        if (where.id && r.id !== where.id) return false;
        if (where.organizationId && r.organizationId !== where.organizationId) return false;
        return true;
      }) || null;
    },
    findMany: async ({ where, orderBy, take, skip }) => {
      void orderBy;
      const filtered = prismaState.apiKeys.filter((r) => matchApiKeyWhere(r, where));
      // Stable order desc by createdAt (insertion order is ascending).
      filtered.sort((a, b) => (b.createdAt?.getTime?.() || 0) - (a.createdAt?.getTime?.() || 0));
      const offset = Number.isFinite(skip) ? skip : 0;
      const end = Number.isFinite(take) ? offset + take : undefined;
      return filtered.slice(offset, end);
    },
    count: async ({ where }) => {
      return prismaState.apiKeys.filter((r) => matchApiKeyWhere(r, where)).length;
    },
    update: async ({ where, data }) => {
      const row = prismaState.apiKeys.find((r) => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }) => {
      prismaState.updateManyCalls = (prismaState.updateManyCalls || 0) + 1;
      const idIn = where.id && typeof where.id === 'object' && Array.isArray(where.id.in)
        ? new Set(where.id.in)
        : null;
      let count = 0;
      for (const r of prismaState.apiKeys) {
        if (idIn) {
          if (!idIn.has(r.id)) continue;
        } else if (where.id && r.id !== where.id) {
          continue;
        }
        if (where.organizationId && r.organizationId !== where.organizationId) continue;
        if (Object.prototype.hasOwnProperty.call(where, 'deletedAt')) {
          if (where.deletedAt === null && r.deletedAt) continue;
        }
        Object.assign(r, data);
        count++;
      }
      return { count };
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

// In-memory rate-limit-store mock with per-key counters. Resettable
// between tests via `rateLimitMock._reset()` so that the per-org daily
// caps from the route don't leak between scenarios.
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
            resolve({ status: res.statusCode, body: json, raw: buf, headers: res.headers });
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
  prismaState.updateManyCalls = 0;
  auditMock._calls.length = 0;
  authMock._user = { id: 'u-admin', email: 'admin@example.com' };
  nextId = 0;
  rateLimitMock._reset();
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

  test('paginates with ?page= and ?limit= and reports total/pages', async () => {
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/api-keys',
        body: { name: `k${i}` },
      });
    }
    const page1 = await callRoute({
      method: 'GET',
      urlPath: '/api/orgs/org-1/api-keys?page=1&limit=2',
    });
    assert.equal(page1.status, 200);
    assert.equal(page1.body.total, 5);
    assert.equal(page1.body.page, 1);
    assert.equal(page1.body.pages, 3);
    assert.equal(page1.body.items.length, 2);

    const page3 = await callRoute({
      method: 'GET',
      urlPath: '/api/orgs/org-1/api-keys?page=3&limit=2',
    });
    assert.equal(page3.status, 200);
    assert.equal(page3.body.items.length, 1);

    // Out-of-range page returns an empty page (not an error).
    const page99 = await callRoute({
      method: 'GET',
      urlPath: '/api/orgs/org-1/api-keys?page=99&limit=2',
    });
    assert.equal(page99.status, 200);
    assert.equal(page99.body.items.length, 0);
    assert.equal(page99.body.total, 5);
  });

  test('caps ?limit= at 200 and defaults to 50 when invalid', async () => {
    await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'only' },
    });
    const huge = await callRoute({
      method: 'GET',
      urlPath: '/api/orgs/org-1/api-keys?limit=99999',
    });
    assert.equal(huge.status, 200);
    assert.equal(huge.body.total, 1);
    // Default limit when invalid: 50; cap when too large: 200. Either
    // way the single row comes back without error.
    assert.equal(huge.body.items.length, 1);

    const bogus = await callRoute({
      method: 'GET',
      urlPath: '/api/orgs/org-1/api-keys?limit=abc&page=-2',
    });
    assert.equal(bogus.status, 200);
    assert.equal(bogus.body.page, 1);
  });

  test('?q= filters by name (case-insensitive contains)', async () => {
    await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'CI Bot Prod' },
    });
    await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'Staging worker' },
    });
    const res = await callRoute({
      method: 'GET',
      urlPath: '/api/orgs/org-1/api-keys?q=bot',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.items[0].name, 'CI Bot Prod');
  });

  test('?q= matches an exact prefix and is combinable with pagination', async () => {
    const a = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'alpha' },
    });
    await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'beta' },
    });
    const prefix = a.body.apiKey.prefix;
    const res = await callRoute({
      method: 'GET',
      urlPath: `/api/orgs/org-1/api-keys?q=${encodeURIComponent(prefix)}&page=1&limit=10`,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.items[0].prefix, prefix);
    assert.equal(res.body.page, 1);
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
    // Ratchet 45 (TrueDelete) — the row is tombstoned, not removed.
    assert.equal(prismaState.apiKeys.length, 1);
    assert.ok(prismaState.apiKeys[0].deletedAt instanceof Date);
    assert.equal(del.body.softDeleted, true);
    assert.equal(auditMock._calls[0].action, 'org_api_key_delete');

    // The org-facing list MUST hide the tombstoned key.
    const list = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/api-keys' });
    assert.equal(list.status, 200);
    assert.equal(list.body.apiKeys.length, 0);

    // A second delete of the same id is a clean 404 (no silent no-op).
    const again = await callRoute({
      method: 'DELETE',
      urlPath: `/api/orgs/org-1/api-keys/${keyId}`,
    });
    assert.equal(again.status, 404);
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

// ── POST /api/orgs/:id/api-keys/:keyId/rotate ──────────────────────
describe('POST /api/orgs/:id/api-keys/:keyId/rotate', () => {
  beforeEach(() => {
    resetState();
    delete process.env.API_KEY_GRACE_HOURS;
  });

  test('rotates the key, returns the new token once, invalidates the old hash', async () => {
    const created = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'rotatable' },
    });
    const original = created.body.apiKey;
    auditMock._calls.length = 0;

    const res = await callRoute({
      method: 'POST',
      urlPath: `/api/orgs/org-1/api-keys/${original.id}/rotate`,
      body: {},
    });
    assert.equal(res.status, 200);
    const rotated = res.body.apiKey;
    assert.ok(rotated.token.startsWith('sk_'));
    assert.notEqual(rotated.token, original.token);
    assert.notEqual(rotated.prefix, original.prefix);
    // Same id, fresh hash on the row.
    assert.equal(rotated.id, original.id);
    const stored = prismaState.apiKeys.find((r) => r.id === original.id);
    assert.notEqual(stored.tokenHash, undefined);
    // No grace by default.
    assert.equal(res.body.grace, null);
    // Audit fired.
    assert.equal(auditMock._calls.at(-1).action, 'org_api_key_rotate');
  });

  test('grace window creates a short-lived clone of the old hash', async () => {
    const created = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'gracefull' },
    });
    const original = created.body.apiKey;

    const res = await callRoute({
      method: 'POST',
      urlPath: `/api/orgs/org-1/api-keys/${original.id}/rotate`,
      body: { graceHours: 24 },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.grace);
    assert.equal(res.body.grace.hours, 24);
    // Two rows: rotated parent + grace clone with old prefix.
    assert.equal(prismaState.apiKeys.length, 2);
    const grace = prismaState.apiKeys.find((r) => r.id === res.body.grace.apiKeyId);
    assert.ok(grace);
    assert.equal(grace.prefix, original.prefix);
    assert.match(grace.name, /rotated grace/);
    assert.ok(grace.expiresAt instanceof Date);
  });

  test('env API_KEY_GRACE_HOURS opts callers in implicitly', async () => {
    process.env.API_KEY_GRACE_HOURS = '2';
    const created = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'env-grace' },
    });
    const res = await callRoute({
      method: 'POST',
      urlPath: `/api/orgs/org-1/api-keys/${created.body.apiKey.id}/rotate`,
      body: {},
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.grace);
    assert.equal(res.body.grace.hours, 2);
  });

  test('returns 404 for unknown keyId', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys/nope/rotate',
      body: {},
    });
    assert.equal(res.status, 404);
  });

  test('MEMBER role is rejected (403)', async () => {
    prismaState.membership.role = 'MEMBER';
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys/whatever/rotate',
      body: {},
    });
    assert.equal(res.status, 403);
  });
});

// ── POST /api/orgs/:id/api-keys/bulk-revoke ────────────────────────
describe('POST /api/orgs/:id/api-keys/bulk-revoke', () => {
  beforeEach(() => resetState());

  async function seedKeys(n) {
    const ids = [];
    for (let i = 0; i < n; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/api-keys',
        body: { name: `bulk-${i}` },
      });
      ids.push(r.body.apiKey.id);
    }
    return ids;
  }

  test('soft-deletes the listed ids and returns revoked/notFound split', async () => {
    const ids = await seedKeys(3);
    auditMock._calls.length = 0;

    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys/bulk-revoke',
      body: { ids: [ids[0], ids[2], 'ghost-id'] },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.revoked.sort(), [ids[0], ids[2]].sort());
    assert.deepEqual(res.body.notFound, ['ghost-id']);

    // Two tombstones, one untouched.
    const tombstoned = prismaState.apiKeys.filter((r) => r.deletedAt instanceof Date);
    assert.equal(tombstoned.length, 2);
    // Batched: the revocations land in ONE updateMany, not an N+1 loop.
    assert.equal(prismaState.updateManyCalls, 1);
    // Org-facing list hides the tombstoned rows.
    const list = await callRoute({ method: 'GET', urlPath: '/api/orgs/org-1/api-keys' });
    assert.equal(list.body.total, 1);
    // One audit row per successful revocation, with bulk:true metadata.
    const bulkLogs = auditMock._calls.filter((c) => c.action === 'org_api_key_delete');
    assert.equal(bulkLogs.length, 2);
    assert.equal(bulkLogs[0].metadata.bulk, true);
  });

  test('rejects non-array ids', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys/bulk-revoke',
      body: { ids: 'k1' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /ids must be an array/);
  });

  test('rejects empty ids', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys/bulk-revoke',
      body: { ids: [] },
    });
    assert.equal(res.status, 400);
  });

  test('rejects more than 50 ids', async () => {
    const ids = new Array(51).fill(0).map((_, i) => `k-${i}`);
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys/bulk-revoke',
      body: { ids },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /max 50/);
  });

  test('rejects non-string ids', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys/bulk-revoke',
      body: { ids: ['ok', 42] },
    });
    assert.equal(res.status, 400);
  });

  test('treats already-soft-deleted ids as notFound (idempotent)', async () => {
    const ids = await seedKeys(1);
    await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys/bulk-revoke',
      body: { ids: [ids[0]] },
    });
    const again = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys/bulk-revoke',
      body: { ids: [ids[0]] },
    });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.revoked, []);
    assert.deepEqual(again.body.notFound, [ids[0]]);
  });

  test('dedupes repeated ids in the request', async () => {
    const ids = await seedKeys(1);
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys/bulk-revoke',
      body: { ids: [ids[0], ids[0], ids[0]] },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.revoked, [ids[0]]);
    assert.deepEqual(res.body.notFound, []);
  });

  test('MEMBER role is rejected (403)', async () => {
    prismaState.membership.role = 'MEMBER';
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys/bulk-revoke',
      body: { ids: ['anything'] },
    });
    assert.equal(res.status, 403);
  });

  test('non-member returns 404', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-other/api-keys/bulk-revoke',
      body: { ids: ['anything'] },
    });
    assert.equal(res.status, 404);
  });
});

// ── GET /api/orgs/:id/api-keys.csv ─────────────────────────────────
describe('GET /api/orgs/:id/api-keys.csv', () => {
  beforeEach(() => resetState());

  test('exports all keys (including tombstoned) as RFC4180 CSV', async () => {
    const a = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'alpha', scopes: ['read', 'write'] },
    });
    const b = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'beta, with comma' },
    });
    // Tombstone one to confirm it still appears in the export.
    await callRoute({
      method: 'DELETE',
      urlPath: `/api/orgs/org-1/api-keys/${b.body.apiKey.id}`,
    });

    const res = await callRoute({
      method: 'GET',
      urlPath: '/api/orgs/org-1/api-keys.csv',
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /attachment/);
    assert.match(res.headers['content-disposition'], /org-1-api-keys\.csv/);

    const lines = res.raw.split('\r\n');
    // Header + 2 rows + trailing empty (CRLF terminator)
    assert.equal(lines[0], 'id,name,prefix,scopes,createdAt,lastUsedAt,expiresAt,isDeleted');
    assert.equal(lines.length, 4);
    assert.equal(lines[3], '');

    // Row containing a comma must be quoted.
    const betaLine = lines.find((l) => l.includes('beta'));
    assert.ok(betaLine.includes('"beta, with comma"'));
    // Tombstoned row reports isDeleted=true.
    assert.ok(betaLine.endsWith(',true'));

    // Alpha row reports scopes joined with `;` and isDeleted=false.
    const alphaLine = lines.find((l) => l.startsWith(a.body.apiKey.id));
    assert.ok(alphaLine.includes('read;write'));
    assert.ok(alphaLine.endsWith(',false'));
  });

  test('quotes fields containing quotes by doubling them', async () => {
    await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'has "quotes" inside' },
    });
    const res = await callRoute({
      method: 'GET',
      urlPath: '/api/orgs/org-1/api-keys.csv',
    });
    assert.equal(res.status, 200);
    assert.ok(res.raw.includes('"has ""quotes"" inside"'));
  });

  test('returns header-only CSV when org has no keys', async () => {
    const res = await callRoute({
      method: 'GET',
      urlPath: '/api/orgs/org-1/api-keys.csv',
    });
    assert.equal(res.status, 200);
    assert.equal(res.raw, 'id,name,prefix,scopes,createdAt,lastUsedAt,expiresAt,isDeleted\r\n');
  });

  test('MEMBER role is rejected (403)', async () => {
    prismaState.membership.role = 'MEMBER';
    const res = await callRoute({
      method: 'GET',
      urlPath: '/api/orgs/org-1/api-keys.csv',
    });
    assert.equal(res.status, 403);
  });

  test('non-member returns 404', async () => {
    const res = await callRoute({
      method: 'GET',
      urlPath: '/api/orgs/org-other/api-keys.csv',
    });
    assert.equal(res.status, 404);
  });
});

// ── Per-org API key rate limits (ratchet 44) ───────────────────────
describe('per-org api-key rate limits (ratchet 44)', () => {
  beforeEach(() => resetState());

  test('POST api-keys: 11th create within the window returns 429 + Retry-After', async () => {
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/api-keys',
        body: { name: `k-${i}` },
      });
      assert.equal(ok.status, 201, `create #${i + 1} should succeed`);
    }
    const denied = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'over-the-cap' },
    });
    assert.equal(denied.status, 429);
    assert.match(denied.body.error, /rate limit exceeded/i);
    assert.match(denied.body.error, /create/);
    assert.ok(Number(denied.body.retryAfter) >= 1);
    assert.ok(denied.headers['retry-after']);
    assert.ok(Number(denied.headers['retry-after']) >= 1);
  });

  test('POST api-keys: rate-limit counter is per-org (org-2 unaffected)', async () => {
    // Allow membership lookups for a second org with the same admin.
    const originalFindUnique = prismaMock.orgMembership.findUnique;
    prismaMock.orgMembership.findUnique = async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      if (userId !== 'u-admin') return null;
      if (orgId === 'org-1' || orgId === 'org-2') {
        return {
          id: 'm', orgId, userId, role: 'ADMIN', organization: { id: orgId },
        };
      }
      return null;
    };
    try {
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await callRoute({
          method: 'POST',
          urlPath: '/api/orgs/org-1/api-keys',
          body: { name: `k-${i}` },
        });
      }
      // org-1 is now exhausted
      const denied = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/api-keys',
        body: { name: 'over' },
      });
      assert.equal(denied.status, 429);

      // org-2 should still have a fresh budget.
      const otherOk = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-2/api-keys',
        body: { name: 'fresh' },
      });
      assert.equal(otherOk.status, 201);
    } finally {
      prismaMock.orgMembership.findUnique = originalFindUnique;
    }
  });

  test('rate-limit is checked AFTER role enforcement (MEMBER still gets 403)', async () => {
    prismaState.membership.role = 'MEMBER';
    // Even with no consumed slots, role check happens first.
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys',
      body: { name: 'x' },
    });
    assert.equal(res.status, 403);
    // No rate-limit slot was burned by the unauthorised attempt.
    assert.equal(rateLimitMock._counters.get('org-api-key-create:org-1') || 0, 0);
  });

  test('bulk-revoke: pre-consumes one slot per unique id and 429s when batch exceeds remaining budget', async () => {
    // Seed 10 keys (this also burns the create budget, but that's not
    // what we're testing here — reset the limiter once we're seeded).
    const ids = [];
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/api-keys',
        body: { name: `k-${i}` },
      });
      ids.push(r.body.apiKey.id);
    }
    // Pretend we've already burned 95 revokes today; a batch of 6 should
    // be denied as a whole (no partial work, no audit-log entries).
    rateLimitMock._counters.set('org-api-key-revoke:org-1', 95);
    const auditBefore = auditMock._calls.length;

    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys/bulk-revoke',
      body: { ids: ids.slice(0, 6) },
    });
    assert.equal(res.status, 429);
    assert.match(res.body.error, /rate limit exceeded/i);
    assert.match(res.body.error, /revoke/);
    assert.ok(res.headers['retry-after']);

    // No key was tombstoned — bulk-revoke is all-or-nothing.
    const tombstoned = prismaState.apiKeys.filter((r) => r.deletedAt);
    assert.equal(tombstoned.length, 0);
    // No audit-log entries were written for this batch.
    assert.equal(auditMock._calls.length, auditBefore);
  });

  test('bulk-revoke under the cap consumes one slot per unique id', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await callRoute({
        method: 'POST',
        urlPath: '/api/orgs/org-1/api-keys',
        body: { name: `b-${i}` },
      });
      ids.push(r.body.apiKey.id);
    }
    const beforeRevoke = rateLimitMock._counters.get('org-api-key-revoke:org-1') || 0;
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/orgs/org-1/api-keys/bulk-revoke',
      // Repeats are deduped — counter should advance by 3, not 5.
      body: { ids: [ids[0], ids[0], ids[1], ids[2], ids[2]] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.revoked.length, 3);
    const afterRevoke = rateLimitMock._counters.get('org-api-key-revoke:org-1') || 0;
    assert.equal(afterRevoke - beforeRevoke, 3);
  });
});
