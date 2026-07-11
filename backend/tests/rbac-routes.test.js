'use strict';

// F2 PR10 — Unit tests for the rbac router. Verifies the Zod schema,
// the router shape, and serializeUserRole's shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const origRequire = Module.prototype.require;
const stubs = new Map();
stubs.set('../middleware/auth', {
  authenticateToken: (_req, _res, next) => next(),
});
stubs.set('../middleware/require-permission', Object.assign(
  function fakeFactory() { return (_req, _res, next) => next(); },
  {
    requirePermission: function () { return (_req, _res, next) => next(); },
    getUserPermissions: async () => new Set(['chat.read']),
    invalidatePermissionsCache: () => {},
  },
));
stubs.set('../config/database', {
  role: { async findUnique() { return null; }, async findMany() { return []; } },
  userRole: {
    async findFirst() { return null; },
    async findMany() { return []; },
    async findUnique() { return null; },
    async create({ data }) { return { id: 'ur_test', assignedAt: new Date(), ...data }; },
    async delete() { return null; },
  },
});

Module.prototype.require = function (spec) {
  if (stubs.has(spec)) return stubs.get(spec);
  return origRequire.apply(this, arguments);
};

const rbac = require('../src/routes/rbac');
const { adminRouter, AssignRoleSchema, serializeUserRole } = rbac;

Module.prototype.require = origRequire;

test('rbac: meRouter exposes GET /me/permissions', () => {
  assert.equal(typeof rbac, 'function');
  const paths = new Set();
  for (const layer of rbac.stack) {
    if (!layer.route) continue;
    paths.add(layer.route.path);
  }
  assert.ok(paths.has('/me/permissions'), 'meRouter missing /me/permissions');
});

test('rbac: adminRouter exposes role list + per-user assign/revoke', () => {
  const paths = new Set();
  for (const layer of adminRouter.stack) {
    if (!layer.route) continue;
    paths.add(layer.route.path);
  }
  assert.ok(paths.has('/roles'));
  assert.ok(paths.has('/users/:userId/roles'));
  assert.ok(paths.has('/users/:userId/roles/:assignmentId'));
});

test('AssignRoleSchema: accepts a GLOBAL assignment without scopeId', () => {
  const parse = AssignRoleSchema.safeParse({ roleCode: 'USER', scope: 'GLOBAL' });
  assert.equal(parse.success, true);
});

test('AssignRoleSchema: accepts the least-privilege PLATFORM_ADMIN role', () => {
  const parse = AssignRoleSchema.safeParse({
    roleCode: 'PLATFORM_ADMIN',
    scope: 'GLOBAL',
  });
  assert.equal(parse.success, true);
});

test('AssignRoleSchema: accepts an ORG assignment with scopeId', () => {
  const parse = AssignRoleSchema.safeParse({
    roleCode: 'ORG_MEMBER',
    scope: 'ORG',
    scopeId: 'org_abc',
  });
  assert.equal(parse.success, true);
});

test('AssignRoleSchema: rejects global roles at organization scope', () => {
  const parse = AssignRoleSchema.safeParse({
    roleCode: 'PLATFORM_ADMIN',
    scope: 'ORG',
    scopeId: 'org_abc',
  });
  assert.equal(parse.success, false);
});

test('AssignRoleSchema: rejects organization roles at global scope', () => {
  const parse = AssignRoleSchema.safeParse({
    roleCode: 'ORG_ADMIN',
    scope: 'GLOBAL',
  });
  assert.equal(parse.success, false);
});

test('AssignRoleSchema: rejects unknown role codes', () => {
  const parse = AssignRoleSchema.safeParse({ roleCode: 'GOD_TIER', scope: 'GLOBAL' });
  assert.equal(parse.success, false);
});

test('AssignRoleSchema: defaults scope to GLOBAL when omitted', () => {
  const parse = AssignRoleSchema.safeParse({ roleCode: 'USER' });
  assert.equal(parse.success, true);
  assert.equal(parse.data.scope, 'GLOBAL');
});

test('serializeUserRole: stable shape with role code/name + scope info', () => {
  const out = serializeUserRole(
    { id: 'ur_1', userId: 'u1', scope: 'ORG', scopeId: 'org_1', assignedBy: 'u_admin', assignedAt: new Date('2026-05-24T00:00:00Z') },
    { code: 'ORG_MEMBER', name: 'Org Member' },
  );
  assert.equal(out.id, 'ur_1');
  assert.equal(out.roleCode, 'ORG_MEMBER');
  assert.equal(out.roleName, 'Org Member');
  assert.equal(out.scope, 'ORG');
  assert.equal(out.scopeId, 'org_1');
});

test('serializeUserRole: defends against missing role with nulls (no throw)', () => {
  const out = serializeUserRole(
    { id: 'ur_2', userId: 'u2', scope: 'GLOBAL', scopeId: null, assignedAt: new Date() },
    null,
  );
  assert.equal(out.roleCode, null);
  assert.equal(out.roleName, null);
});
