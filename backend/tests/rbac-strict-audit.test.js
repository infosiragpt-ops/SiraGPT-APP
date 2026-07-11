'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createRbacAssignmentSyncService } = require('../src/services/rbac-assignment-sync');
const { createAdminRbacRouter } = require('../src/routes/rbac');
const auditModule = require('../src/utils/audit-log');

test('strict audit writer uses the transaction client and propagates persistence failures', async () => {
  assert.equal(typeof auditModule.writeAuditLogStrict, 'function');
  const txFailure = new Error('audit unavailable');
  const tx = {
    auditLog: {
      async create(args) {
        assert.equal(args.data.action, 'rbac_assignment_grant');
        assert.equal(args.data.actorId, 'actor-1');
        assert.equal(args.data.resourceType, 'rbac_assignment');
        throw txFailure;
      },
    },
  };

  await assert.rejects(
    auditModule.writeAuditLogStrict(tx, {
      action: 'rbac_assignment_grant',
      userId: 'actor-1',
      resource: 'rbac_assignment',
      resourceId: 'target-1',
    }),
    (error) => error === txFailure,
  );
  await assert.rejects(
    auditModule.writeAuditLogStrict({}, { action: 'rbac_assignment_grant' }),
    (error) => error?.code === 'AUDIT_MODEL_UNAVAILABLE',
  );
});

function transactionalSyncPrisma() {
  const state = {
    users: new Map(),
    assignments: new Map(),
  };
  const roles = new Map([
    ['USER', { id: 'role_user', code: 'USER' }],
  ]);
  const root = {
    state,
    async $transaction(fn) {
      const snapshot = {
        users: new Map(state.users),
        assignments: new Map(state.assignments),
      };
      const tx = {
        role: {
          findUnique: async ({ where }) => roles.get(where.code) || null,
        },
        user: {
          async create({ data }) {
            const row = { id: 'created-user', isSuperAdmin: false, ...data };
            state.users.set(row.id, row);
            return row;
          },
          async findUnique({ where }) {
            return state.users.get(where.id) || null;
          },
        },
        userRole: {
          async findFirst({ where }) {
            return [...state.assignments.values()].find((row) => (
              row.userId === where.userId
              && row.roleId === where.roleId
              && row.scope === where.scope
              && (row.scopeId || null) === (where.scopeId || null)
            )) || null;
          },
          async create({ data }) {
            state.assignments.set(data.id, { ...data });
            return { ...data };
          },
          async update({ where, data }) {
            const row = state.assignments.get(where.id);
            Object.assign(row, data);
            return { ...row };
          },
          async deleteMany() {
            return { count: 0 };
          },
        },
        async $queryRawUnsafe(sql, ...params) {
          if (/set_config/i.test(sql)) return [{ lock_timeout: params[0] }];
          assert.match(sql, /pg_advisory_xact_lock/i);
          return [{ locked: true }];
        },
      };
      try {
        return await fn(tx);
      } catch (error) {
        state.users = snapshot.users;
        state.assignments = snapshot.assignments;
        root.state = state;
        throw error;
      }
    },
  };
  return root;
}

test('dual-write user creation rolls back user and assignment when strict audit fails', async () => {
  const prisma = transactionalSyncPrisma();
  let invalidations = 0;
  let versionBumps = 0;
  const service = createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async () => {
      invalidations += 1;
    },
    writeAuditLog: async () => {
      throw new Error('audit write failed');
    },
    bumpPermissionVersion: async () => {
      versionBumps += 1;
      return '1';
    },
  });

  await assert.rejects(
    service.createLegacyAdminUser({
      data: {
        name: 'Atomic User',
        email: 'atomic@example.test',
        password: 'hash',
        isAdmin: false,
        isSuperAdmin: false,
      },
    }),
    /audit write failed/,
  );

  assert.equal(prisma.state.users.size, 0);
  assert.equal(prisma.state.assignments.size, 0);
  assert.equal(versionBumps, 0);
  assert.equal(invalidations, 0);
});

test('manual RBAC grant rolls back assignment when strict audit fails', async () => {
  const assignments = new Map();
  let auditAttempts = 0;
  const role = {
    id: 'role_user',
    code: 'USER',
    name: 'User',
    permissions: [{ permission: { code: 'chat.read' } }],
  };
  const root = {
    role: {
      findUnique: async () => role,
    },
    async $transaction(fn) {
      const snapshot = new Map(assignments);
      const tx = {
        user: {
          async findUnique({ where }) {
            return {
              id: where.id,
              deletedAt: null,
              isSuperAdmin: where.id === 'actor-1',
            };
          },
        },
        role: {
          async findUnique() {
            return role;
          },
        },
        userRole: {
          async findMany({ where }) {
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
          findFirst: async () => null,
          async create({ data }) {
            const row = { ...data, assignedAt: new Date() };
            assignments.set(row.id, row);
            return row;
          },
          async update({ where, data }) {
            const row = { ...assignments.get(where.id), ...data };
            assignments.set(row.id, row);
            return row;
          },
        },
        async $queryRawUnsafe(sql, ...params) {
          if (/set_config/i.test(sql)) return [{ lock_timeout: params[0] }];
          return [{ locked: true }];
        },
      };
      try {
        return await fn(tx);
      } catch (error) {
        assignments.clear();
        for (const [key, value] of snapshot) assignments.set(key, value);
        throw error;
      }
    },
  };
  const router = createAdminRbacRouter({
    prismaClient: root,
    authenticateMiddleware(req, _res, next) {
      req.user = { id: 'actor-1', isSuperAdmin: true };
      next();
    },
    controlPlaneMiddleware: (_req, _res, next) => next(),
    getUserPermissionsImpl: async () => new Set(['rbac.manage', 'chat.read']),
    invalidatePermissionsCacheImpl: async () => {
      assert.fail('a rolled-back mutation must not publish invalidation');
    },
    writeAuditLogImpl: async () => {
      auditAttempts += 1;
      throw new Error('audit write failed');
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin/rbac', router);
  app.use((_error, _req, res, _next) => res.status(500).json({ error: 'internal' }));

  const response = await request(app)
    .post('/api/admin/rbac/users/target-1/roles')
    .send({ roleCode: 'USER', scope: 'GLOBAL' });

  assert.equal(response.status, 500);
  assert.equal(auditAttempts, 1);
  assert.equal(assignments.size, 0);
});
