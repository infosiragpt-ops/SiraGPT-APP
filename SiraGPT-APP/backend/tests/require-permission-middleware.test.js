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
const userRoleCalls = { count: 0, lastUserId: null, lastWhere: null };
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
  u_scope: [
    {
      scope: 'GLOBAL',
      role: {
        permissions: [{ permission: { code: 'admin.users.read' } }],
      },
    },
    {
      scope: 'ORG',
      scopeId: 'org-1',
      role: {
        permissions: [{ permission: { code: 'org.members.invite' } }],
      },
    },
  ],
};

const stubs = new Map();
stubs.set('../config/database', {
  userRole: {
    async findMany({ where }) {
      userRoleCalls.count += 1;
      userRoleCalls.lastUserId = where.userId;
      userRoleCalls.lastWhere = where;
      if (where.userId === 'u_lookup_error') {
        const error = new Error('database details must not escape');
        error.code = 'DATABASE_UNAVAILABLE';
        throw error;
      }
      const rows = fixtures[where.userId] || [];
      if (where.scope) return rows.filter((row) => row.scope === where.scope);
      return rows;
    },
  },
});

Module.prototype.require = function (spec) {
  if (stubs.has(spec)) return stubs.get(spec);
  return origRequire.apply(this, arguments);
};

// Force a small TTL so the TTL test runs fast.
process.env.RBAC_CACHE_TTL_MS = '50';
process.env.NODE_ENV = 'test';
delete process.env.RBAC_ENFORCEMENT_MODE; // non-production default: shadow

const requirePermission = require('../src/middleware/require-permission');
const {
  getUserPermissions,
  loadUserPermissions,
  invalidatePermissionsCache,
  enforcementMode,
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

test('loadUserPermissions: globalOnly excludes organization-scoped grants', async () => {
  const set = await loadUserPermissions('u_scope', { globalOnly: true });
  assert.deepEqual(Array.from(set), ['admin.users.read']);
  assert.deepEqual(userRoleCalls.lastWhere, {
    userId: 'u_scope',
    scope: 'GLOBAL',
    scopeId: null,
  });
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
  for (const entry of _cacheForTests.values()) entry.expiresAt = Date.now() - 1;
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
  assert.deepEqual(ctx.req._rbacAllowed, {
    code: 'chat.read',
    hasPermission: true,
    isSuperAdmin: false,
    legacyAllowed: null,
    decisionSource: 'rbac',
  });
});

test('requirePermission: 403 when missing the permission', async () => {
  _cacheForTests.clear();
  const ctx = makeCtx({ user: { id: 'u1', isSuperAdmin: false } });
  requirePermission('rbac.manage')(ctx.req, ctx.res, ctx.nextHook());
  await ctx.done;
  assert.equal(ctx.res.statusCode, 403);
  assert.equal(ctx.res.jsonBody.missingPermission, 'rbac.manage');
});

test('requirePermission: shadow replacement gate follows legacy allow when RBAC denies', async () => {
  _cacheForTests.clear();
  const origConsoleWarn = console.warn;
  let shadowDiff = null;
  console.warn = (line) => {
    try {
      if (typeof line === 'string' && line.includes('rbac.shadow.diff')) {
        shadowDiff = JSON.parse(line);
      }
    } catch (_) {}
  };
  const ctx = makeCtx({ user: { id: 'u_empty', isSuperAdmin: true } });
  let nextCalled = false;
  requirePermission('rbac.manage', {
    legacyPredicate: (user) => Boolean(user?.isSuperAdmin),
  })(ctx.req, ctx.res, ctx.nextHook(() => { nextCalled = true; }));
  await ctx.done;
  console.warn = origConsoleWarn;
  assert.equal(nextCalled, true, 'shadow mode must let superadmin through');
  assert.equal(shadowDiff.direction, 'legacy_allow_rbac_deny');
  assert.equal(ctx.req._rbacAllowed.decisionSource, 'legacy_shadow');
});

test('requirePermission: shadow replacement gate follows legacy deny when RBAC allows', async () => {
  process.env.RBAC_ENFORCEMENT_MODE = 'shadow';
  _cacheForTests.clear();
  const diffs = [];
  const ctx = makeCtx({ user: { id: 'u_admin', isAdmin: false, isSuperAdmin: false } });
  ctx.req.log = {
    warn(payload) {
      diffs.push(payload);
    },
  };
  requirePermission('admin.users.read', {
    legacyPredicate: (user) => Boolean(user?.isAdmin || user?.isSuperAdmin),
  })(ctx.req, ctx.res, ctx.nextHook());
  await ctx.done;

  assert.equal(ctx.res.statusCode, 403);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].direction, 'legacy_deny_rbac_allow');
  delete process.env.RBAC_ENFORCEMENT_MODE;
});

test('requirePermission: generic RBAC-only routes stay RBAC-authoritative in shadow mode', async () => {
  process.env.RBAC_ENFORCEMENT_MODE = 'shadow';
  _cacheForTests.clear();
  const denied = makeCtx({ user: { id: 'u_empty', isSuperAdmin: true } });
  requirePermission('chat.read')(denied.req, denied.res, denied.nextHook());
  await denied.done;
  assert.equal(denied.res.statusCode, 403);

  _cacheForTests.clear();
  const allowed = makeCtx({ user: { id: 'u1', isSuperAdmin: false } });
  let nextCalled = false;
  requirePermission('chat.read')(
    allowed.req,
    allowed.res,
    allowed.nextHook(() => { nextCalled = true; }),
  );
  await allowed.done;
  assert.equal(nextCalled, true);
  assert.equal(allowed.req._rbacAllowed.decisionSource, 'rbac');
  delete process.env.RBAC_ENFORCEMENT_MODE;
});

test('requirePermission: shadow lookup failure preserves legacy allow and logs the error direction', async () => {
  process.env.RBAC_ENFORCEMENT_MODE = 'shadow';
  _cacheForTests.clear();
  const diffs = [];
  const ctx = makeCtx({
    user: { id: 'u_lookup_error', isAdmin: true, isSuperAdmin: false },
  });
  ctx.req.log = {
    warn(payload) {
      diffs.push(payload);
    },
  };
  let nextError = 'not-called';
  requirePermission('admin.users.read', {
    legacyPredicate: (user) => Boolean(user?.isAdmin || user?.isSuperAdmin),
  })(ctx.req, ctx.res, ctx.nextHook((error) => {
    nextError = error || null;
  }));
  await ctx.done;

  assert.equal(nextError, null);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].direction, 'legacy_allow_rbac_error');
  assert.equal(diffs[0].errorCode, 'RBAC_PERMISSION_LOOKUP_FAILED');
  assert.equal(JSON.stringify(diffs[0]).includes('database details'), false);
  assert.deepEqual(ctx.req._rbacAllowed, {
    code: 'admin.users.read',
    hasPermission: null,
    isSuperAdmin: false,
    legacyAllowed: true,
    decisionSource: 'legacy_shadow_error',
  });
  delete process.env.RBAC_ENFORCEMENT_MODE;
});

test('requirePermission: shadow lookup failure preserves legacy deny and logs the error direction', async () => {
  process.env.RBAC_ENFORCEMENT_MODE = 'shadow';
  _cacheForTests.clear();
  const diffs = [];
  const ctx = makeCtx({
    user: { id: 'u_lookup_error', isAdmin: false, isSuperAdmin: false },
  });
  ctx.req.log = {
    warn(payload) {
      diffs.push(payload);
    },
  };
  requirePermission('admin.users.read', {
    legacyPredicate: (user) => Boolean(user?.isAdmin || user?.isSuperAdmin),
  })(ctx.req, ctx.res, ctx.nextHook());
  await ctx.done;

  assert.equal(ctx.res.statusCode, 403);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].direction, 'legacy_deny_rbac_error');
  assert.equal(diffs[0].errorCode, 'RBAC_PERMISSION_LOOKUP_FAILED');
  delete process.env.RBAC_ENFORCEMENT_MODE;
});

test('requirePermission: RBAC-only lookup failure remains fail-closed in shadow mode', async () => {
  process.env.RBAC_ENFORCEMENT_MODE = 'shadow';
  _cacheForTests.clear();
  const ctx = makeCtx({
    user: { id: 'u_lookup_error', isAdmin: true, isSuperAdmin: true },
  });
  let nextError = null;
  requirePermission('admin.users.read')(
    ctx.req,
    ctx.res,
    ctx.nextHook((error) => {
      nextError = error || null;
    }),
  );
  await ctx.done;

  assert.equal(nextError?.code, 'DATABASE_UNAVAILABLE');
  assert.equal(ctx.req._rbacAllowed, undefined);
  delete process.env.RBAC_ENFORCEMENT_MODE;
});

test('enforcement mode defaults to shadow outside production and enforce in production', () => {
  process.env.NODE_ENV = 'test';
  delete process.env.RBAC_ENFORCEMENT_MODE;
  assert.equal(shadowEnabled(), true);
  assert.equal(enforcementMode(), 'shadow');
  process.env.NODE_ENV = 'production';
  assert.equal(shadowEnabled(), false);
  assert.equal(enforcementMode(), 'enforce');
  process.env.NODE_ENV = 'test';
});

test('enforcement mode honors only explicit shadow|enforce values', () => {
  process.env.NODE_ENV = 'test';
  process.env.RBAC_ENFORCEMENT_MODE = 'enforce';
  assert.equal(shadowEnabled(), false);
  process.env.RBAC_ENFORCEMENT_MODE = 'shadow';
  assert.equal(shadowEnabled(), true);
  process.env.NODE_ENV = 'production';
  process.env.RBAC_ENFORCEMENT_MODE = 'invalid-value';
  assert.throws(() => enforcementMode(), /RBAC_ENFORCEMENT_MODE_INVALID/);
  process.env.NODE_ENV = 'test';
  delete process.env.RBAC_ENFORCEMENT_MODE;
});

test('requirePermission: shadow compatibility can preserve a legacy isAdmin grant', async () => {
  process.env.RBAC_ENFORCEMENT_MODE = 'shadow';
  _cacheForTests.clear();
  const ctx = makeCtx({ user: { id: 'u_empty', isAdmin: true, isSuperAdmin: false } });
  let nextCalled = false;
  requirePermission('admin.users.read', {
    legacyPredicate: (user) => Boolean(user?.isAdmin || user?.isSuperAdmin),
  })(ctx.req, ctx.res, ctx.nextHook(() => { nextCalled = true; }));
  await ctx.done;
  assert.equal(nextCalled, true);
  delete process.env.RBAC_ENFORCEMENT_MODE;
});

test('requirePermission: enforce mode never accepts a legacy boolean without a grant', async () => {
  process.env.RBAC_ENFORCEMENT_MODE = 'enforce';
  _cacheForTests.clear();
  const ctx = makeCtx({ user: { id: 'u_empty', isAdmin: true, isSuperAdmin: true } });
  requirePermission('rbac.manage', {
    legacyPredicate: (user) => Boolean(user?.isAdmin || user?.isSuperAdmin),
  })(ctx.req, ctx.res, ctx.nextHook());
  await ctx.done;
  assert.equal(ctx.res.statusCode, 403);
  delete process.env.RBAC_ENFORCEMENT_MODE;
});

test('requirePermission: API keys need both an RBAC grant and a matching key scope', async () => {
  process.env.RBAC_ENFORCEMENT_MODE = 'enforce';
  _cacheForTests.clear();
  const denied = makeCtx({ user: { id: 'u_admin', isAdmin: true } });
  denied.req.authMethod = 'api_key';
  denied.req.apiKey = { id: 'key-1', scopes: ['chat.read'], organizationId: null };
  requirePermission('admin.users.read')(denied.req, denied.res, denied.nextHook());
  await denied.done;
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.res.jsonBody.code, 'insufficient_api_key_scope');

  _cacheForTests.clear();
  const allowed = makeCtx({ user: { id: 'u_admin', isAdmin: true } });
  allowed.req.authMethod = 'api_key';
  allowed.req.apiKey = { id: 'key-2', scopes: ['admin.users.read'], organizationId: null };
  let nextCalled = false;
  requirePermission('admin.users.read')(
    allowed.req,
    allowed.res,
    allowed.nextHook(() => { nextCalled = true; }),
  );
  await allowed.done;
  assert.equal(nextCalled, true);
  delete process.env.RBAC_ENFORCEMENT_MODE;
});

test('requirePermission: organization API keys cannot cross a global admin boundary', async () => {
  process.env.RBAC_ENFORCEMENT_MODE = 'enforce';
  _cacheForTests.clear();
  const ctx = makeCtx({ user: { id: 'u_admin', isAdmin: true } });
  ctx.req.authMethod = 'api_key';
  ctx.req.apiKey = {
    id: 'key-org',
    scopes: ['*'],
    organizationId: 'org-1',
  };
  requirePermission('admin.users.read', { allowOrgApiKey: false })(
    ctx.req,
    ctx.res,
    ctx.nextHook(),
  );
  await ctx.done;
  assert.equal(ctx.res.statusCode, 403);
  assert.equal(ctx.res.jsonBody.code, 'api_key_role_boundary');
  delete process.env.RBAC_ENFORCEMENT_MODE;
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
