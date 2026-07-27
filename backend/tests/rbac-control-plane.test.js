'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const request = require('supertest');

function loadOptional(specifier) {
  try {
    return require(specifier);
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const rbacRoutes = loadOptional('../src/routes/rbac');
const {
  assertSuperadminRemains,
} = require('../src/services/rbac-superadmin-invariant');
const systemAssignments = require('../src/services/rbac-system-assignments');
const { globalErrorHandler } = require('../src/middleware/error-handler');

function requireFeature(value, label) {
  assert.ok(value, `${label} has not been implemented`);
  return value;
}

function invoke(middleware, req) {
  let statusCode = 200;
  let body;
  let nextCalls = 0;
  return new Promise((resolve, reject) => {
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(value) {
        body = value;
        resolve({ statusCode, body, nextCalls });
        return this;
      },
    };
    const next = (error) => {
      if (error) return reject(error);
      nextCalls += 1;
      resolve({ statusCode, body, nextCalls });
    };
    Promise.resolve(middleware(req, res, next)).catch(reject);
  });
}

function createSuperadminInvariantFixture({ users, assignments }) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE "users" (
      "id" TEXT PRIMARY KEY,
      "isSuperAdmin" INTEGER NOT NULL,
      "deletedAt" TEXT
    );
    CREATE TABLE "roles" (
      "id" TEXT PRIMARY KEY,
      "code" TEXT NOT NULL
    );
    CREATE TABLE "user_roles" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "roleId" TEXT NOT NULL,
      "scope" TEXT NOT NULL,
      "scopeId" TEXT,
      "assignedBy" TEXT
    );
    INSERT INTO "roles" ("id", "code") VALUES ('role-superadmin', 'SUPERADMIN');
  `);
  const insertUser = db.prepare(
    'INSERT INTO "users" ("id", "isSuperAdmin", "deletedAt") VALUES (?, ?, ?)',
  );
  const insertAssignment = db.prepare(
    'INSERT INTO "user_roles" ("id", "userId", "roleId", "scope", "scopeId", "assignedBy") VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const user of users) {
    insertUser.run(user.id, user.isSuperAdmin ? 1 : 0, user.deletedAt || null);
  }
  for (const assignment of assignments) {
    insertAssignment.run(
      assignment.id,
      assignment.userId,
      'role-superadmin',
      'GLOBAL',
      null,
      assignment.assignedBy ?? null,
    );
  }
  return {
    tx: {
      async $queryRawUnsafe(sql, ...params) {
        if (/set_config/i.test(sql)) return [{ lock_timeout: params[0] }];
        if (/pg_advisory_xact_lock/i.test(sql)) return [{ locked: true }];
        const sqliteSql = sql
          .replace(/::"RoleScope"/g, '')
          .replace(/::int/g, '')
          .replace(/::text/g, '')
          .replace(/\$(\d+)/g, '?$1');
        return db.prepare(sqliteSql).all(...params);
      },
    },
    close() {
      db.close();
    },
  };
}

test('RBAC control plane requires a superadmin session and global rbac.manage', async () => {
  const createMiddleware = requireFeature(
    rbacRoutes?.createRbacControlPlaneMiddleware,
    'RBAC control-plane middleware',
  );
  const permissionCalls = [];
  const middleware = createMiddleware({
    requirePermissionImpl(permission, options) {
      permissionCalls.push({ permission, options });
      return (_req, _res, next) => next();
    },
  });

  const apiKey = await invoke(middleware, {
    authMethod: 'api_key',
    apiKey: { organizationId: 'org-1', scopes: ['*'] },
    user: { id: 'actor-1', isSuperAdmin: true },
  });
  assert.equal(apiKey.statusCode, 403);
  assert.equal(apiKey.body.code, 'rbac_session_required');

  const ordinary = await invoke(middleware, {
    authMethod: 'session',
    user: { id: 'actor-2', isSuperAdmin: false },
  });
  assert.equal(ordinary.statusCode, 403);
  assert.equal(ordinary.body.code, 'rbac_superadmin_required');

  const allowed = await invoke(middleware, {
    authMethod: 'session',
    user: { id: 'actor-3', isSuperAdmin: true },
  });
  assert.equal(allowed.nextCalls, 1);
  assert.equal(permissionCalls.length, 1);
  assert.equal(permissionCalls[0].permission, 'rbac.manage');
  assert.equal(permissionCalls[0].options.globalOnly, true);
  assert.equal(permissionCalls[0].options.allowOrgApiKey, false);
  assert.equal(permissionCalls[0].options.legacyPredicate, null);
});

test('grant ceiling is permission-subset based and cannot be bypassed by role names', () => {
  const roleWithinGrantCeiling = requireFeature(
    rbacRoutes?.roleWithinGrantCeiling,
    'RBAC grant ceiling',
  );
  const actor = new Set(['rbac.manage', 'chat.read']);
  assert.equal(
    roleWithinGrantCeiling(actor, {
      code: 'USER',
      permissions: [{ permission: { code: 'chat.read' } }],
    }),
    true,
  );
  assert.equal(
    roleWithinGrantCeiling(actor, {
      code: 'MISLEADING_LOW_ROLE_NAME',
      permissions: [
        { permission: { code: 'chat.read' } },
        { permission: { code: 'users.impersonate' } },
      ],
    }),
    false,
  );
});

test('RBAC assignment endpoints enforce ceiling and use audited atomic upsert/deleteMany', async () => {
  const createRouter = requireFeature(
    rbacRoutes?.createAdminRbacRouter,
    'admin RBAC router factory',
  );
  const calls = [];
  const audits = [];
  const versions = [];
  const assignments = new Map();
  const roles = {
    USER: {
      id: 'role_user',
      code: 'USER',
      name: 'User',
      permissions: [{ permission: { code: 'chat.read' } }],
    },
    SUPERADMIN: {
      id: 'role_superadmin',
      code: 'SUPERADMIN',
      name: 'Super Admin',
      permissions: [
        { permission: { code: 'rbac.manage' } },
        { permission: { code: 'users.impersonate' } },
      ],
    },
  };
  const tx = {
    user: {
      async findUnique({ where }) {
        calls.push({ kind: 'user.findUnique', where });
        return {
          id: where.id,
          deletedAt: null,
          isSuperAdmin: where.id === 'actor-1',
        };
      },
    },
    role: {
      async findUnique({ where }) {
        calls.push({ kind: 'role.findUnique', where });
        return roles[where.code] || null;
      },
    },
    userRole: {
      async findMany({ where }) {
        calls.push({ kind: 'userRole.findMany', where });
        return [{
          id: 'actor-superadmin',
          userId: where.userId,
          scope: 'GLOBAL',
          scopeId: null,
          role: {
            code: 'SUPERADMIN',
            permissions: [
              { permission: { code: 'rbac.manage' } },
              { permission: { code: 'chat.read' } },
            ],
          },
        }];
      },
      async findFirst({ where }) {
        calls.push({ kind: 'userRole.findFirst', where });
        return [...assignments.values()].find((row) => (
          row.userId === where.userId
          && row.roleId === where.roleId
          && row.scope === where.scope
          && row.scopeId === where.scopeId
        )) || null;
      },
      async findUnique({ where }) {
        calls.push({ kind: 'userRole.findUnique', where });
        const row = assignments.get(where.id);
        return row ? { ...row, role: roles.USER } : null;
      },
      async create({ data }) {
        calls.push({ kind: 'userRole.create', data });
        const row = { ...data, assignedAt: new Date() };
        assignments.set(row.id, row);
        return row;
      },
      async update({ where, data }) {
        calls.push({ kind: 'userRole.update', where, data });
        const row = { ...assignments.get(where.id), ...data };
        assignments.set(row.id, row);
        return row;
      },
      async upsert(args) {
        calls.push({ kind: 'userRole.upsert', args });
        const row = assignments.get(args.where.id)
          ? { ...assignments.get(args.where.id), ...args.update }
          : { ...args.create, id: args.where.id, assignedAt: new Date() };
        assignments.set(row.id, row);
        return row;
      },
      async deleteMany({ where }) {
        calls.push({ kind: 'userRole.deleteMany', where });
        const row = assignments.get(where.id);
        if (!row || row.userId !== where.userId) return { count: 0 };
        assignments.delete(where.id);
        return { count: 1 };
      },
    },
    async $queryRawUnsafe(sql, ...params) {
      if (/set_config/i.test(sql)) {
        calls.push({ kind: 'assignment.lock-timeout', sql, params });
        return [{ lock_timeout: params[0] }];
      }
      calls.push({ kind: 'assignment.lock', sql, params });
      return [{ locked: true }];
    },
  };
  const prisma = {
    ...tx,
    async $transaction(fn) {
      calls.push({ kind: 'transaction' });
      return fn(tx);
    },
  };
  const router = createRouter({
    prismaClient: prisma,
    authenticateMiddleware(req, _res, next) {
      req.user = { id: 'actor-1', isSuperAdmin: true };
      req.authMethod = 'session';
      next();
    },
    controlPlaneMiddleware: (_req, _res, next) => next(),
    getUserPermissionsImpl: async () => new Set(['rbac.manage', 'chat.read']),
    invalidatePermissionsCacheImpl: async () => {},
    writeAuditLogImpl: async (_db, entry) => {
      audits.push(entry);
    },
    bumpPermissionVersionImpl: async (db) => {
      assert.equal(db, tx);
      versions.push('bumped');
      return String(versions.length);
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin/rbac', router);

  const callsBeforeSystemPrincipal = calls.length;
  const protectedPrincipal = await request(app)
    .post(`/api/admin/rbac/users/${encodeURIComponent(systemAssignments.SYSTEM_ASSIGNMENT_TAG)}/roles`)
    .send({ roleCode: 'USER', scope: 'GLOBAL' });
  assert.equal(protectedPrincipal.status, 409);
  assert.equal(
    protectedPrincipal.body.code,
    'rbac_system_principal_protected',
  );
  assert.equal(calls.length, callsBeforeSystemPrincipal);

  const denied = await request(app)
    .post('/api/admin/rbac/users/target-1/roles')
    .send({ roleCode: 'SUPERADMIN', scope: 'GLOBAL' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'rbac_grant_ceiling');

  const created = await request(app)
    .post('/api/admin/rbac/users/target-1/roles')
    .send({ roleCode: 'USER', scope: 'GLOBAL' });
  assert.equal(created.status, 201);
  assert.ok(calls.some((call) => call.kind === 'assignment.lock'));
  assert.ok(calls.some((call) => call.kind === 'userRole.create'));
  assert.equal(calls.some((call) => call.kind === 'userRole.upsert'), false);
  const assignmentId = created.body.assignment.id;

  const revoked = await request(app)
    .delete(`/api/admin/rbac/users/target-1/roles/${assignmentId}`);
  assert.equal(revoked.status, 200);
  assert.ok(calls.some((call) => call.kind === 'userRole.deleteMany'));
  assert.equal(calls.some((call) => call.kind === 'userRole.delete'), false);
  assert.equal(versions.length, 2);

  assert.deepEqual(
    audits.map((entry) => ({
      action: entry.action,
      actor: entry.userId,
      target: entry.metadata.targetUserId,
      role: entry.metadata.roleCode,
      scope: entry.metadata.scope,
      result: entry.metadata.result,
    })),
    [
      {
        action: 'rbac_assignment_grant',
        actor: 'actor-1',
        target: 'target-1',
        role: 'USER',
        scope: 'GLOBAL',
        result: 'created',
      },
      {
        action: 'rbac_assignment_revoke',
        actor: 'actor-1',
        target: 'target-1',
        role: 'USER',
        scope: 'GLOBAL',
        result: 'deleted',
      },
    ],
  );
});

function createDeleteHarness({ assignment, remainingSuperadmins = 1 }) {
  const calls = [];
  const tx = {
    user: {
      async findUnique({ where }) {
        calls.push({ kind: 'user.findUnique' });
        return {
          id: where.id,
          deletedAt: null,
          isSuperAdmin: where.id === 'actor-1',
        };
      },
    },
    userRole: {
      async findMany({ where }) {
        calls.push({ kind: 'userRole.findMany' });
        return [{
          id: 'actor-superadmin',
          userId: where.userId,
          scope: 'GLOBAL',
          scopeId: null,
          role: {
            code: 'SUPERADMIN',
            permissions: [
              { permission: { code: 'rbac.manage' } },
              { permission: { code: 'chat.read' } },
            ],
          },
        }];
      },
      async findUnique() {
        calls.push({ kind: 'userRole.findUnique' });
        return assignment;
      },
      async deleteMany() {
        calls.push({ kind: 'userRole.deleteMany' });
        return { count: 1 };
      },
    },
    async $queryRawUnsafe(sql, ...params) {
      if (/set_config/i.test(sql)) {
        calls.push({ kind: 'lock-timeout', sql, params });
        return [{ lock_timeout: params[0] }];
      }
      if (/pg_advisory_xact_lock/i.test(sql)) {
        calls.push({ kind: 'lock', sql, params });
        return [{ locked: true }];
      }
      calls.push({ kind: 'count', sql, params });
      return [{ effective_count: remainingSuperadmins }];
    },
  };
  const prisma = {
    userRole: tx.userRole,
    role: { findMany: async () => [] },
    async $transaction(fn) {
      calls.push({ kind: 'transaction' });
      return fn(tx);
    },
  };
  const router = rbacRoutes.createAdminRbacRouter({
    prismaClient: prisma,
    authenticateMiddleware(req, _res, next) {
      req.user = { id: 'actor-1', isSuperAdmin: true };
      req.authMethod = 'session';
      next();
    },
    controlPlaneMiddleware: (_req, _res, next) => next(),
    invalidatePermissionsCacheImpl: async () => {},
    writeAuditLogImpl: async () => {},
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin/rbac', router);
  return { app, calls };
}

test('RBAC control plane refuses current or historical assignedBy system provenance', async () => {
  const isSystemManagedAssignment = requireFeature(
    rbacRoutes?.isSystemManagedAssignment,
    'system assignment classifier',
  );
  const tagPrefix = requireFeature(
    systemAssignments.SYSTEM_ASSIGNMENT_TAG_PREFIX,
    'system assignment tag family',
  );
  for (const assignedBy of [
    `${tagPrefix}1`,
    `${tagPrefix}2`,
    `${tagPrefix}99`,
  ]) {
    assert.equal(
      isSystemManagedAssignment({ id: 'arbitrary-id', assignedBy }),
      true,
      assignedBy,
    );
  }
  assert.equal(
    isSystemManagedAssignment({
      id: 'rbac_sys_v2_g_prefix-is-not-provenance',
      assignedBy: 'human-admin',
    }),
    false,
  );

  const { app, calls } = createDeleteHarness({
    assignment: {
      id: 'manual-looking-id',
      userId: 'target-1',
      roleId: 'role_user',
      scope: 'GLOBAL',
      scopeId: null,
      assignedBy: `${tagPrefix}1`,
      role: { code: 'USER' },
    },
  });
  const response = await request(app)
    .delete('/api/admin/rbac/users/target-1/roles/manual-looking-id');

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'rbac_system_assignment_protected');
  assert.equal(calls.some((call) => call.kind === 'userRole.deleteMany'), false);
});

test('RBAC control plane does not protect an ID prefix without assignedBy provenance', async () => {
  const { app, calls } = createDeleteHarness({
    assignment: {
      id: 'rbac_sys_v2_g_human-owned',
      userId: 'target-1',
      roleId: 'role_user',
      scope: 'GLOBAL',
      scopeId: null,
      assignedBy: 'human-admin',
      role: { code: 'USER' },
    },
  });

  const response = await request(app)
    .delete('/api/admin/rbac/users/target-1/roles/rbac_sys_v2_g_human-owned');

  assert.equal(response.status, 200);
  assert.equal(calls.some((call) => call.kind === 'userRole.deleteMany'), true);
  assert.deepEqual(
    calls
      .filter((call) => [
        'lock-timeout',
        'lock',
        'user.findUnique',
        'userRole.findMany',
        'userRole.findUnique',
        'userRole.deleteMany',
      ].includes(call.kind))
      .map((call) => call.kind),
    [
      'lock-timeout',
      'lock',
      'lock-timeout',
      'user.findUnique',
      'userRole.findMany',
      'user.findUnique',
      'userRole.findUnique',
      'userRole.deleteMany',
    ],
  );
});

test('last effective global SUPERADMIN check is locked and evaluated inside revoke transaction', async () => {
  const assignment = {
    id: 'rbac_grant_superadmin',
    userId: 'target-1',
    roleId: 'role_superadmin',
    scope: 'GLOBAL',
    scopeId: null,
    assignedBy: 'actor-1',
    role: { code: 'SUPERADMIN' },
  };
  const deniedHarness = createDeleteHarness({
    assignment,
    remainingSuperadmins: 0,
  });
  const denied = await request(deniedHarness.app)
    .delete('/api/admin/rbac/users/target-1/roles/rbac_grant_superadmin');

  assert.equal(denied.status, 409);
  assert.equal(denied.body.code, 'rbac_last_superadmin');
  assert.deepEqual(
    deniedHarness.calls
      .filter((call) => [
        'transaction',
        'lock-timeout',
        'lock',
        'user.findUnique',
        'userRole.findMany',
        'userRole.findUnique',
        'count',
      ].includes(call.kind))
      .map((call) => call.kind),
    [
      'transaction',
      'lock-timeout',
      'lock',
      'lock-timeout',
      'user.findUnique',
      'userRole.findMany',
      'user.findUnique',
      'userRole.findUnique',
      'count',
    ],
  );
  assert.equal(
    deniedHarness.calls.some((call) => call.kind === 'userRole.deleteMany'),
    false,
  );

  const allowedHarness = createDeleteHarness({
    assignment,
    remainingSuperadmins: 1,
  });
  const allowed = await request(allowedHarness.app)
    .delete('/api/admin/rbac/users/target-1/roles/rbac_grant_superadmin');
  assert.equal(allowed.status, 200);
  assert.equal(
    allowedHarness.calls.some((call) => call.kind === 'userRole.deleteMany'),
    true,
  );
});

test('legacy demotion excludes every historical assignedBy system grant for the target user', async () => {
  const calls = [];
  const tx = {
    async $queryRawUnsafe(sql, ...params) {
      if (/set_config/i.test(sql)) {
        calls.push({ kind: 'lock-timeout' });
        return [{ lock_timeout: params[0] }];
      }
      if (/pg_advisory_xact_lock/i.test(sql)) {
        calls.push({ kind: 'lock' });
        return [{ locked: true }];
      }
      calls.push({ kind: 'count', sql, params });
      const excludesHistoricalFamily = /assignedBy" NOT LIKE 'rbac-system:v%/.test(sql)
        && params.includes('legacy-superadmin');
      return [{ effective_count: excludesHistoricalFamily ? 0 : 1 }];
    },
  };

  await assert.rejects(
    assertSuperadminRemains(tx, {
      excludeSystemAssignmentsForUserId: 'legacy-superadmin',
    }),
    { code: 'RBAC_LAST_SUPERADMIN' },
  );
  assert.deepEqual(calls.map((call) => call.kind), [
    'lock-timeout',
    'lock',
    'lock-timeout',
    'count',
  ]);
});

test('last-superadmin invariant ignores a manual SUPERADMIN role on a non-superadmin user', async () => {
  const fixture = createSuperadminInvariantFixture({
    users: [
      { id: 'effective-admin', isSuperAdmin: true },
      { id: 'manual-role-only', isSuperAdmin: false },
      { id: 'deleted-admin', isSuperAdmin: true, deletedAt: new Date().toISOString() },
    ],
    assignments: [
      { id: 'effective-assignment', userId: 'effective-admin' },
      { id: 'manual-assignment', userId: 'manual-role-only' },
      { id: 'deleted-assignment', userId: 'deleted-admin' },
    ],
  });
  try {
    await assert.rejects(
      assertSuperadminRemains(fixture.tx, {
        excludeAssignmentId: 'effective-assignment',
      }),
      { code: 'RBAC_LAST_SUPERADMIN' },
    );
  } finally {
    fixture.close();
  }
});

test('control-plane grant locks before rereading target and cleans a deleted user', async () => {
  const assignments = new Map([
    ['stale-manual', {
      id: 'stale-manual',
      userId: 'deleted-target',
      roleId: 'role_user',
      scope: 'GLOBAL',
      scopeId: null,
      assignedBy: 'actor-0',
    }],
  ]);
  const events = [];
  const role = {
    id: 'role_user',
    code: 'USER',
    name: 'User',
    permissions: [{ permission: { code: 'chat.read' } }],
  };
  const tx = {
    async $queryRawUnsafe(sql) {
      events.push(/pg_advisory_xact_lock/i.test(sql) ? 'lock' : 'lock-timeout');
      return [{ locked: true }];
    },
    user: {
      async findUnique({ where }) {
        events.push(where.id === 'actor-1' ? 'actor-read' : 'user-read');
        if (where.id === 'actor-1') {
          return {
            id: 'actor-1',
            isSuperAdmin: true,
            deletedAt: null,
          };
        }
        return { id: 'deleted-target', deletedAt: new Date() };
      },
    },
    role: {
      async findUnique() {
        events.push('role-read');
        return role;
      },
    },
    userRole: {
      async findMany() {
        events.push('actor-roles-read');
        return [{
          id: 'actor-superadmin',
          userId: 'actor-1',
          scope: 'GLOBAL',
          scopeId: null,
          role: {
            code: 'SUPERADMIN',
            permissions: [
              { permission: { code: 'rbac.manage' } },
              { permission: { code: 'chat.read' } },
            ],
          },
        }];
      },
      async deleteMany({ where }) {
        events.push('delete');
        let count = 0;
        for (const [id, assignment] of assignments) {
          if (assignment.userId === where.userId) {
            assignments.delete(id);
            count += 1;
          }
        }
        return { count };
      },
    },
  };
  const prisma = {
    role: {
      async findUnique() {
        assert.fail('role source of truth must be read after the global lock');
      },
    },
    async $transaction(fn) {
      return fn(tx);
    },
  };
  const router = rbacRoutes.createAdminRbacRouter({
    prismaClient: prisma,
    authenticateMiddleware(req, _res, next) {
      req.user = { id: 'actor-1', isSuperAdmin: true };
      req.authMethod = 'session';
      next();
    },
    controlPlaneMiddleware: (_req, _res, next) => next(),
    getUserPermissionsImpl: async () => new Set(['rbac.manage', 'chat.read']),
    invalidatePermissionsCacheImpl: async () => {},
    writeAuditLogImpl: async () => {},
    bumpPermissionVersionImpl: async () => '1',
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin/rbac', router);

  const response = await request(app)
    .post('/api/admin/rbac/users/deleted-target/roles')
    .send({ roleCode: 'USER', scope: 'GLOBAL' });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'rbac_assignment_target_inactive');
  assert.equal(assignments.size, 0);
  assert.deepEqual(
    events.filter((event) => event !== 'lock-timeout'),
    [
      'lock',
      'actor-read',
      'actor-roles-read',
      'user-read',
      'delete',
    ],
  );
});

test('control-plane lock contention returns retryable 503 with Retry-After', async () => {
  const busy = new Error('RBAC_MUTATION_BUSY');
  busy.code = 'RBAC_MUTATION_BUSY';
  busy.statusCode = 503;
  busy.status = 503;
  busy.retryable = true;
  busy.retryAfterSeconds = 1;
  busy.expose = true;

  const tx = {
    async $queryRawUnsafe(sql) {
      if (/set_config/i.test(sql)) return [{ lock_timeout: '250ms' }];
      throw busy;
    },
  };
  const prisma = {
    role: {
      async findUnique() {
        return {
          id: 'role_user',
          code: 'USER',
          permissions: [{ permission: { code: 'chat.read' } }],
        };
      },
    },
    async $transaction(fn) {
      return fn(tx);
    },
  };
  const router = rbacRoutes.createAdminRbacRouter({
    prismaClient: prisma,
    authenticateMiddleware(req, _res, next) {
      req.user = { id: 'actor-1', isSuperAdmin: true };
      req.authMethod = 'session';
      next();
    },
    controlPlaneMiddleware: (_req, _res, next) => next(),
    getUserPermissionsImpl: async () => new Set(['rbac.manage', 'chat.read']),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin/rbac', router);
  app.use(globalErrorHandler({
    logger: { error() {}, warn() {} },
    stdout() {},
  }));

  const response = await request(app)
    .post('/api/admin/rbac/users/target-1/roles')
    .send({ roleCode: 'USER', scope: 'GLOBAL' });

  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'RBAC_MUTATION_BUSY');
  assert.equal(response.body.retryable, true);
  assert.equal(response.headers['retry-after'], '1');
});

function createQueuedActorHarness({
  actor,
  actorPermissionCodes = ['rbac.manage', 'chat.read'],
  assignment = null,
} = {}) {
  const events = [];
  let mutated = false;
  const roles = {
    USER: {
      id: 'role-user',
      code: 'USER',
      name: 'User',
      permissions: [{ permission: { code: 'chat.read' } }],
    },
    SUPERADMIN: {
      id: 'role-superadmin',
      code: 'SUPERADMIN',
      name: 'Super Admin',
      permissions: actorPermissionCodes.map((code) => ({ permission: { code } })),
    },
  };
  const tx = {
    async $queryRawUnsafe(sql, ...params) {
      if (/pg_advisory_xact_lock/i.test(sql)) {
        events.push('lock');
        return [{ locked: true }];
      }
      events.push(String(params[0]) === '0' ? 'lock-timeout-reset' : 'lock-timeout');
      return [{ lock_timeout: params[0] || '0' }];
    },
    user: {
      async findUnique({ where }) {
        events.push(`user-read:${where.id}`);
        if (where.id === 'actor-queued') return actor;
        return { id: where.id, deletedAt: null };
      },
    },
    role: {
      async findUnique({ where }) {
        events.push(`role-read:${where.code}`);
        return roles[where.code] || null;
      },
    },
    userRole: {
      async findMany({ where }) {
        events.push(`actor-roles-read:${where.userId}`);
        return [{
          id: 'actor-superadmin',
          userId: 'actor-queued',
          scope: 'GLOBAL',
          scopeId: null,
          role: roles.SUPERADMIN,
        }];
      },
      async findFirst() {
        return null;
      },
      async findUnique() {
        events.push('assignment-read');
        return assignment;
      },
      async create({ data }) {
        mutated = true;
        events.push('assignment-create');
        return { ...data, assignedAt: new Date() };
      },
      async update() {
        assert.fail('unexpected assignment update');
      },
      async deleteMany({ where }) {
        if (where.id) {
          mutated = true;
          events.push('assignment-delete');
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  };
  const prismaClient = {
    role: { findMany: async () => [] },
    userRole: tx.userRole,
    async $transaction(fn) {
      events.push('transaction');
      return fn(tx);
    },
  };
  const router = rbacRoutes.createAdminRbacRouter({
    prismaClient,
    authenticateMiddleware(req, _res, next) {
      req.user = {
        id: 'actor-queued',
        isSuperAdmin: true,
      };
      req.authMethod = 'session';
      next();
    },
    controlPlaneMiddleware: (_req, _res, next) => next(),
    getUserPermissionsImpl: async () => new Set([
      'rbac.manage',
      'chat.read',
      'users.impersonate',
    ]),
    invalidatePermissionsCacheImpl: async () => {},
    writeAuditLogImpl: async () => {},
    bumpPermissionVersionImpl: async () => '1',
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin/rbac', router);
  return {
    app,
    events,
    wasMutated: () => mutated,
  };
}

test('queued control-plane grant rechecks actor deletion under the global lock', async () => {
  const harness = createQueuedActorHarness({
    actor: {
      id: 'actor-queued',
      isSuperAdmin: true,
      deletedAt: new Date('2026-07-01T00:00:00Z'),
    },
  });

  const response = await request(harness.app)
    .post('/api/admin/rbac/users/target-1/roles')
    .send({ roleCode: 'USER', scope: 'GLOBAL' });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'rbac_actor_inactive');
  assert.equal(harness.wasMutated(), false);
  assert.ok(harness.events.indexOf('lock') < harness.events.indexOf('user-read:actor-queued'));
});

test('queued control-plane revoke rechecks actor demotion under the global lock', async () => {
  const harness = createQueuedActorHarness({
    actor: {
      id: 'actor-queued',
      isSuperAdmin: false,
      deletedAt: null,
    },
    assignment: {
      id: 'assignment-1',
      userId: 'target-1',
      roleId: 'role-user',
      scope: 'GLOBAL',
      scopeId: null,
      assignedBy: 'actor-queued',
      role: {
        id: 'role-user',
        code: 'USER',
        permissions: [{ permission: { code: 'chat.read' } }],
      },
    },
  });

  const response = await request(harness.app)
    .delete('/api/admin/rbac/users/target-1/roles/assignment-1');

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'rbac_actor_superadmin_required');
  assert.equal(harness.wasMutated(), false);
  assert.equal(harness.events.includes('assignment-read'), false);
});

test('grant ceiling uses actor effective global permissions reread inside the lock', async () => {
  const harness = createQueuedActorHarness({
    actor: {
      id: 'actor-queued',
      isSuperAdmin: true,
      deletedAt: null,
    },
    actorPermissionCodes: ['rbac.manage'],
  });

  const response = await request(harness.app)
    .post('/api/admin/rbac/users/target-1/roles')
    .send({ roleCode: 'USER', scope: 'GLOBAL' });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'rbac_grant_ceiling');
  assert.equal(harness.wasMutated(), false);
  assert.ok(harness.events.includes('actor-roles-read:actor-queued'));
});
