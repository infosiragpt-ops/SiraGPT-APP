'use strict';

// F2 PR9 — Unit tests for requirePermission. Stubs the Prisma client
// so loadUserPermissions can be exercised without a live DB, then
// verifies: cache hit, cache miss, 401 on no user, 403 when missing
// permission, shadow-mode allows isSuperAdmin even on missing perm,
// invalidation, and per-user TTL.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const origRequire = Module.prototype.require;
const userRoleCalls = { count: 0, lastUserId: null };
const fixtures = {
  // userId → array of UserRole rows with nested role.permissions
  u1: [
    {
      role: {
        permissions: [
          { permission: { code: 'chat.read' } },
          { permission: { code: 'chat.create' } },
          { permission: { code: 'paraphrase.use' } },
        ],
      },
    },
  ],
  u_admin: [
    {
      role: {
        permissions: [
          { permission: { code: 'admin.users.read' } },
          { permission: { code: 'credits.adjust' } },
        ],
      },
    },
  ],
  u_empty: [],
};

const stubs = new Map();
stubs.set('../config/database', {
  userRole: {
    async findMany({ where }) {
      userRoleCalls.count += 1;
      userRoleCalls.lastUserId = where.userId;
      return fixtures[where.userId] || [];
    },
  },
});

Module.prototype.require = function (spec) {
  if (stubs.has(spec)) return stubs.get(spec);
  return origRequire.apply(this, arguments);
};

// Force a small TTL so the TTL test runs fast.
process.env.RBAC_CACHE_TTL_MS = '50';
delete process.env.RBAC_SHADOW_MODE; // default ON

const requirePermission = require('../src/middleware/require-permission');
const {
  getUserPermissions,
  loadUserPermissions,
  invalidatePermissionsCache,
  shadowEnabled,
  _cacheForTests,
} = requirePermission;

Module.prototype.require = origRequire;

function makeCtx({ user = { id: 'u1' }, headers = {} } = {}) {
  let statusCode = 200;
  let jsonBody = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { jsonBody = payload; resolveDone('json'); return this; },
    get statusCode() { return statusCode; },
    get jsonBody() { return jsonBody; },
  };
  return {
    req: { user, get: (n) => headers[n.toLowerCase()] },
    res,
    done,
    nextHook: (cb) => (...args) => { cb && cb(...args); resolveDone('next'); },
  };
}

test('loadUserPermissions: returns the union of every role grant for a user', async () => {
  const set = await loadUserPermissions('u1');
  assert.ok(set instanceof Set);
  assert.equal(set.size, 3);
  assert.ok(set.has('chat.read'));
  assert.ok(set.has('paraphrase.use'));
});

test('loadUserPermissions: empty set for users with no role assignments', async () => {
  const set = await loadUserPermissions('u_empty');
  assert.equal(set.size, 0);
});

test('getUserPermissions: caches the result for the configured TTL', async () => {
  _cacheForTests.clear();
  userRoleCalls.count = 0;
  await getUserPermissions('u1');
  await getUserPermissions('u1');
  await getUserPermissions('u1');
  assert.equal(userRoleCalls.count, 1, 'second + third call should hit cache');
});

test('getUserPermissions: cache expires after TTL', async () => {
  _cacheForTests.clear();
  userRoleCalls.count = 0;
  await getUserPermissions('u1');
  await new Promise((r) => setTimeout(r, 80));
  await getUserPermissions('u1');
  assert.equal(userRoleCalls.count, 2, 'TTL expiry should force a reload');
});

test('invalidatePermissionsCache: forces a reload on next call', async () => {
  _cacheForTests.clear();
  userRoleCalls.count = 0;
  await getUserPermissions('u1');
  invalidatePermissionsCache('u1');
  await getUserPermissions('u1');
  assert.equal(userRoleCalls.count, 2);
});

test('invalidatePermissionsCache: with no arg clears the whole cache', async () => {
  _cacheForTests.clear();
  await getUserPermissions('u1');
  await getUserPermissions('u_admin');
  assert.equal(_cacheForTests.size, 2);
  invalidatePermissionsCache();
  assert.equal(_cacheForTests.size, 0);
});

test('requirePermission: factory rejects when permissionCode is missing', () => {
  assert.throws(() => requirePermission(), /permissionCode is required/);
});

test('requirePermission: 401 when req.user is missing', async () => {
  const ctx = makeCtx({ user: null });
  requirePermission('chat.read')(ctx.req, ctx.res, ctx.nextHook());
  await ctx.done;
  assert.equal(ctx.res.statusCode, 401);
});

test('requirePermission: allows when user has the permission', async () => {
  _cacheForTests.clear();
  const ctx = makeCtx({ user: { id: 'u1', isSuperAdmin: false } });
  let nextCalled = false;
  requirePermission('chat.read')(ctx.req, ctx.res, ctx.nextHook(() => { nextCalled = true; }));
  await ctx.done;
  assert.equal(nextCalled, true);
  assert.deepEqual(ctx.req._rbacAllowed, { code: 'chat.read', hasPermission: true, isSuperAdmin: false });
});

test('requirePermission: 403 when missing the permission', async () => {
  _cacheForTests.clear();
  const ctx = makeCtx({ user: { id: 'u1', isSuperAdmin: false } });
  requirePermission('rbac.manage')(ctx.req, ctx.res, ctx.nextHook());
  await ctx.done;
  assert.equal(ctx.res.statusCode, 403);
  assert.equal(ctx.res.jsonBody.missingPermission, 'rbac.manage');
});

test('requirePermission: shadow mode allows isSuperAdmin even without declarative perm', async () => {
  _cacheForTests.clear();
  const origConsoleWarn = console.warn;
  let shadowLogged = false;
  console.warn = (line) => {
    try {
      if (typeof line === 'string' && line.includes('rbac.shadow.diff')) shadowLogged = true;
    } catch (_) {}
  };
  const ctx = makeCtx({ user: { id: 'u_empty', isSuperAdmin: true } });
  let nextCalled = false;
  requirePermission('rbac.manage')(ctx.req, ctx.res, ctx.nextHook(() => { nextCalled = true; }));
  await ctx.done;
  console.warn = origConsoleWarn;
  assert.equal(nextCalled, true, 'shadow mode must let superadmin through');
  assert.equal(shadowLogged, true, 'must log rbac.shadow.diff for the missing declarative perm');
});

test('shadowEnabled: respects RBAC_SHADOW_MODE env var', () => {
  delete process.env.RBAC_SHADOW_MODE;
  assert.equal(shadowEnabled(), true);
  process.env.RBAC_SHADOW_MODE = 'false';
  assert.equal(shadowEnabled(), false);
  process.env.RBAC_SHADOW_MODE = 'true';
  assert.equal(shadowEnabled(), true);
  delete process.env.RBAC_SHADOW_MODE;
});

test('requirePermission: accepts a dynamic permissionCode function', async () => {
  _cacheForTests.clear();
  const ctx = makeCtx({ user: { id: 'u1', isSuperAdmin: false } });
  let nextCalled = false;
  requirePermission((req) => 'chat.' + (req.action || 'read'))(
    Object.assign(ctx.req, { action: 'create' }),
    ctx.res,
    ctx.nextHook(() => { nextCalled = true; }),
  );
  await ctx.done;
  assert.equal(nextCalled, true);
});
