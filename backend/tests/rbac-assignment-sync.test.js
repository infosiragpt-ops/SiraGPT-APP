'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadOptional(specifier) {
  try {
    return require(specifier);
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const syncModule = loadOptional('../src/services/rbac-assignment-sync');
const bootstrapModule = loadOptional('../src/services/rbac-bootstrap');
const systemAssignmentsModule = loadOptional('../src/services/rbac-system-assignments');

function requireFeature(value, label) {
  assert.ok(value, `${label} has not been implemented`);
  return value;
}

function fakePrisma() {
  const calls = [];
  const users = new Map([
    ['target-1', {
      id: 'target-1',
      isAdmin: false,
      isSuperAdmin: false,
      deletedAt: null,
    }],
  ]);
  const memberships = new Map();
  const assignments = new Map([
    ['manual-grant', {
      id: 'manual-grant',
      userId: 'target-1',
      roleId: 'role_superadmin',
      scope: 'GLOBAL',
      scopeId: null,
      assignedBy: 'human-admin',
    }],
  ]);
  const roles = new Map([
    ['SUPERADMIN', { id: 'role_superadmin', code: 'SUPERADMIN' }],
    ['PLATFORM_ADMIN', { id: 'role_platform_admin', code: 'PLATFORM_ADMIN' }],
    ['USER', { id: 'role_user', code: 'USER' }],
    ['ORG_OWNER', { id: 'role_org_owner', code: 'ORG_OWNER' }],
    ['ORG_ADMIN', { id: 'role_org_admin', code: 'ORG_ADMIN' }],
    ['ORG_MEMBER', { id: 'role_org_member', code: 'ORG_MEMBER' }],
    ['ORG_VIEWER', { id: 'role_org_viewer', code: 'ORG_VIEWER' }],
  ]);

  function matchesDelete(row, where) {
    if (Array.isArray(where.AND) && !where.AND.every((part) => matchesDelete(row, part))) return false;
    if (Array.isArray(where.OR) && !where.OR.some((part) => matchesDelete(row, part))) return false;
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.roleId !== undefined && row.roleId !== where.roleId) return false;
    if (where.scope !== undefined && row.scope !== where.scope) return false;
    if (where.scopeId !== undefined && row.scopeId !== where.scopeId) return false;
    if (where.id?.startsWith && !row.id.startsWith(where.id.startsWith)) return false;
    if (where.id?.not && row.id === where.id.not) return false;
    if (
      where.assignedBy?.startsWith
      && !String(row.assignedBy || '').startsWith(where.assignedBy.startsWith)
    ) return false;
    return true;
  }

  const tx = {
    async $executeRawUnsafe(sql, ...params) {
      calls.push({ kind: 'assignment.lock', sql, params });
      return 1;
    },
    async $queryRawUnsafe(sql, ...params) {
      if (/set_config/i.test(sql)) {
        calls.push({ kind: 'rbac.lock-timeout', sql, params });
        return [{ lock_timeout: params[0] }];
      }
      if (/pg_advisory_xact_lock/i.test(sql)) {
        calls.push({ kind: 'assignment.lock', sql, params });
        return [{ locked: true }];
      }
      if (/INSERT INTO "user_roles"/i.test(sql)) {
        calls.push({ kind: 'assignment.rawUpsert', sql, params });
        const incoming = {
          id: params[0],
          userId: params[1],
          roleId: params[2],
          scope: params[3],
          scopeId: params[4],
          assignedBy: params[5],
        };
        const existing = [...assignments.values()].find((row) => (
          row.userId === incoming.userId
          && row.roleId === incoming.roleId
          && row.scope === incoming.scope
          && (row.scopeId || '') === (incoming.scopeId || '')
        ));
        if (existing) return [{ id: existing.id }];
        assignments.set(incoming.id, incoming);
        return [{ id: incoming.id }];
      }
      calls.push({ kind: 'permissionVersion.bump' });
      return [{ version: '1' }];
    },
    role: {
      async findUnique({ where }) {
        calls.push({ kind: 'role.findUnique', where });
        return roles.get(where.code) || null;
      },
    },
    orgMembership: {
      async findUnique({ where }) {
        calls.push({ kind: 'orgMembership.findUnique', where });
        const key = where.orgId_userId;
        return memberships.get(`${key.orgId}:${key.userId}`) || null;
      },
    },
    userRole: {
      async findFirst({ where }) {
        calls.push({ kind: 'userRole.findFirst', where });
        return [...assignments.values()].find((row) => matchesDelete(row, where)) || null;
      },
      async create({ data }) {
        calls.push({ kind: 'userRole.create', data });
        assignments.set(data.id, { ...data });
        return { ...data };
      },
      async update({ where, data }) {
        calls.push({ kind: 'userRole.update', where, data });
        const row = assignments.get(where.id);
        Object.assign(row, data);
        return { ...row };
      },
      async upsert(args) {
        calls.push({ kind: 'userRole.upsert', args });
        const prior = assignments.get(args.where.id);
        const value = prior
          ? { ...prior, ...args.update }
          : { ...args.create };
        assignments.set(value.id, value);
        return value;
      },
      async deleteMany(args) {
        calls.push({ kind: 'userRole.deleteMany', args });
        let count = 0;
        for (const [id, row] of assignments) {
          if (matchesDelete(row, args.where)) {
            assignments.delete(id);
            count += 1;
          }
        }
        return { count };
      },
    },
    user: {
      async findUnique({ where }) {
        calls.push({ kind: 'user.findUnique', where });
        return users.get(where.id) || {
          id: where.id,
          isAdmin: false,
          isSuperAdmin: false,
          deletedAt: null,
        };
      },
      async update(args) {
        calls.push({ kind: 'user.update', args });
        const prior = users.get(args.where.id) || {
          id: args.where.id,
          isAdmin: false,
          isSuperAdmin: false,
          deletedAt: null,
        };
        const updated = { ...prior, ...args.data };
        users.set(updated.id, updated);
        return updated;
      },
      async create(args) {
        calls.push({ kind: 'user.create', args });
        const created = {
          id: 'created-user',
          ...args.data,
          isAdmin: Boolean(args.data.isAdmin),
          isSuperAdmin: Boolean(args.data.isSuperAdmin),
          deletedAt: args.data.deletedAt ?? null,
        };
        users.set(created.id, created);
        return created;
      },
    },
  };

  return {
    ...tx,
    calls,
    assignments,
    users,
    memberships,
    async $transaction(fn) {
      calls.push({ kind: 'transaction' });
      return fn(tx);
    },
  };
}

test('legacy admin promotion and demotion atomically upsert one tagged system grant', async () => {
  const feature = requireFeature(syncModule, 'RBAC assignment sync');
  const prisma = fakePrisma();
  const audits = [];
  const invalidations = [];
  const service = feature.createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async (userId) => invalidations.push(userId),
    writeAuditLog: async (_db, entry) => audits.push(entry),
  });

  prisma.users.set('target-1', {
    id: 'target-1',
    isAdmin: true,
    isSuperAdmin: false,
    deletedAt: null,
  });
  const promoted = await service.syncLegacyAdminAssignment({
    userId: 'target-1',
    isAdmin: true,
    isSuperAdmin: false,
    actorId: 'actor-1',
  });
  prisma.users.set('target-1', {
    id: 'target-1',
    isAdmin: false,
    isSuperAdmin: false,
    deletedAt: null,
  });
  const demoted = await service.syncLegacyAdminAssignment({
    userId: 'target-1',
    isAdmin: false,
    isSuperAdmin: false,
    actorId: 'actor-1',
  });

  assert.equal(promoted.roleCode, 'PLATFORM_ADMIN');
  assert.equal(demoted.roleCode, 'USER');
  assert.match(promoted.assignmentId, new RegExp(`^${feature.SYSTEM_ASSIGNMENT_PREFIX}`));
  assert.equal(prisma.assignments.get(demoted.assignmentId).roleId, 'role_user');
  assert.equal(
    [...prisma.assignments.values()].filter(
      (row) => row.userId === 'target-1'
        && row.scope === 'GLOBAL'
        && row.id.startsWith(feature.SYSTEM_ASSIGNMENT_PREFIX),
    ).length,
    1,
  );
  assert.equal(prisma.assignments.has('manual-grant'), true, 'manual assignments must survive demotion');
  assert.ok(prisma.calls.some((call) => call.kind === 'assignment.lock'));
  assert.ok(prisma.calls.some((call) => call.kind === 'userRole.create'));
  assert.ok(prisma.calls.some((call) => (
    call.kind === 'userRole.deleteMany'
    && JSON.stringify(call.args.where).includes('assignedBy')
  )));
  assert.deepEqual(invalidations, ['target-1', 'target-1']);
  assert.deepEqual(
    audits.map((entry) => ({
      action: entry.action,
      actorId: entry.userId,
      targetUserId: entry.metadata.targetUserId,
      roleCode: entry.metadata.roleCode,
      scope: entry.metadata.scope,
      result: entry.metadata.result,
    })),
    [
      {
        action: 'rbac_system_assignment_sync',
        actorId: 'actor-1',
        targetUserId: 'target-1',
        roleCode: 'PLATFORM_ADMIN',
        scope: 'GLOBAL',
        result: 'synchronized',
      },
      {
        action: 'rbac_system_assignment_sync',
        actorId: 'actor-1',
        targetUserId: 'target-1',
        roleCode: 'USER',
        scope: 'GLOBAL',
        result: 'synchronized',
      },
    ],
  );
});

test('organization role changes reuse one tagged grant and preserve manual grants', async () => {
  const feature = requireFeature(syncModule, 'RBAC assignment sync');
  const prisma = fakePrisma();
  prisma.assignments.set('manual-org-grant', {
    id: 'manual-org-grant',
    userId: 'target-1',
    roleId: 'role_org_admin',
    scope: 'ORG',
    scopeId: 'org-1',
    assignedBy: 'human-admin',
  });
  const service = feature.createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
  });

  prisma.memberships.set('org-1:target-1', {
    userId: 'target-1',
    orgId: 'org-1',
    role: 'MEMBER',
  });
  const member = await service.syncOrgRoleAssignment({
    userId: 'target-1',
    orgId: 'org-1',
    orgRole: 'MEMBER',
    actorId: 'actor-1',
  });
  prisma.memberships.set('org-1:target-1', {
    userId: 'target-1',
    orgId: 'org-1',
    role: 'OWNER',
  });
  const owner = await service.syncOrgRoleAssignment({
    userId: 'target-1',
    orgId: 'org-1',
    orgRole: 'OWNER',
    actorId: 'actor-1',
  });

  assert.equal(prisma.assignments.get(owner.assignmentId).roleId, 'role_org_owner');
  assert.equal(prisma.assignments.has('manual-org-grant'), true);

  prisma.memberships.delete('org-1:target-1');
  await service.removeOrgRoleAssignment({
    userId: 'target-1',
    orgId: 'org-1',
    actorId: 'actor-1',
  });
  assert.equal(prisma.assignments.has('manual-org-grant'), true);
  assert.equal(
    [...prisma.assignments.values()].some(
      (row) => row.userId === 'target-1'
        && row.scope === 'ORG'
        && row.scopeId === 'org-1'
        && row.id.startsWith(feature.SYSTEM_ASSIGNMENT_PREFIX),
    ),
    false,
  );
});

test('demotion cleanup recognizes assignedBy system tags from every bootstrap generation', async () => {
  const feature = requireFeature(syncModule, 'RBAC assignment sync');
  const tagPrefix = requireFeature(
    systemAssignmentsModule?.SYSTEM_ASSIGNMENT_TAG_PREFIX,
    'system assignment tag family',
  );
  const prisma = fakePrisma();
  for (const [id, assignedBy] of [
    ['historical-system-v1', `${tagPrefix}1`],
    ['historical-system-v2', `${tagPrefix}2`],
    ['historical-system-v99', `${tagPrefix}99`],
  ]) {
    prisma.assignments.set(id, {
      id,
      userId: 'target-1',
      roleId: 'role_platform_admin',
      scope: 'GLOBAL',
      scopeId: null,
      assignedBy,
    });
  }
  const service = feature.createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
  });

  const result = await service.syncLegacyAdminAssignment({
    userId: 'target-1',
    isAdmin: false,
    isSuperAdmin: false,
    actorId: 'actor-1',
  });

  assert.equal(prisma.assignments.has(result.assignmentId), true);
  assert.equal(prisma.assignments.has('manual-grant'), true);
  for (const staleId of [
    'historical-system-v1',
    'historical-system-v2',
    'historical-system-v99',
  ]) {
    assert.equal(prisma.assignments.has(staleId), false, staleId);
  }
});

test('required manual tuple collision is atomically adopted with system provenance', async () => {
  const feature = requireFeature(syncModule, 'RBAC assignment sync');
  const systemTag = requireFeature(
    systemAssignmentsModule?.SYSTEM_ASSIGNMENT_TAG,
    'versioned system assignment tag',
  );
  const prisma = fakePrisma();
  prisma.assignments.set('manual-required-tuple', {
    id: 'manual-required-tuple',
    userId: 'collision-user',
    roleId: 'role_platform_admin',
    scope: 'GLOBAL',
    scopeId: null,
    assignedBy: 'human-admin',
  });
  prisma.assignments.set('manual-unrelated-role', {
    id: 'manual-unrelated-role',
    userId: 'collision-user',
    roleId: 'role_superadmin',
    scope: 'GLOBAL',
    scopeId: null,
    assignedBy: 'human-admin',
  });
  const service = feature.createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
  });

  prisma.users.set('collision-user', {
    id: 'collision-user',
    isAdmin: true,
    isSuperAdmin: false,
    deletedAt: null,
  });
  const result = await service.syncLegacyAdminAssignment({
    userId: 'collision-user',
    isAdmin: true,
    isSuperAdmin: false,
    actorId: 'actor-1',
  });

  assert.equal(result.assignmentId, 'manual-required-tuple');
  assert.equal(prisma.assignments.size, 3);
  assert.equal(prisma.assignments.get('manual-required-tuple').assignedBy, systemTag);
  assert.equal(prisma.assignments.get('manual-unrelated-role').assignedBy, 'human-admin');
});

test('concurrent reconciliation converges through the natural assignment tuple', async () => {
  const feature = requireFeature(syncModule, 'RBAC assignment sync');
  const prisma = fakePrisma();
  const service = feature.createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
  });

  prisma.users.set('concurrent-user', {
    id: 'concurrent-user',
    isAdmin: true,
    isSuperAdmin: false,
    deletedAt: null,
  });
  await Promise.all(Array.from({ length: 20 }, () => service.syncLegacyAdminAssignment({
    userId: 'concurrent-user',
    isAdmin: true,
    isSuperAdmin: false,
    actorId: 'actor-1',
  })));
  const systemRows = [...prisma.assignments.values()].filter(
    (row) => row.userId === 'concurrent-user' && row.id.startsWith(feature.SYSTEM_ASSIGNMENT_PREFIX),
  );
  assert.equal(systemRows.length, 1);
  assert.equal(
    prisma.calls.some((call) => call.kind === 'assignment.lock'),
    true,
  );
});

test('bootstrap and lifecycle transition share the one global mutation lock', async () => {
  const syncFeature = requireFeature(syncModule, 'RBAC assignment sync');
  const bootstrapFeature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const calls = [];
  const assignments = new Map();
  const lockTails = new Map();
  const roles = new Map([
    ['PLATFORM_ADMIN', { id: 'role_platform_admin', code: 'PLATFORM_ADMIN' }],
    ['USER', { id: 'role_user', code: 'USER' }],
  ]);
  let marker = null;

  function matchesTuple(row, where) {
    return row.userId === where.userId
      && (!where.roleId || row.roleId === where.roleId)
      && row.scope === where.scope
      && (row.scopeId || null) === (where.scopeId || null);
  }

  const prisma = {
    async $transaction(fn) {
      const releases = [];
      async function acquire(lockKey) {
        const previous = lockTails.get(lockKey) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        const tail = previous.then(() => current);
        lockTails.set(lockKey, tail);
        await previous;
        releases.push({ lockKey, release, tail });
      }
      const tx = {
        systemSettings: {
          async findUnique({ where }) {
            if (where.key !== bootstrapFeature.BOOTSTRAP_MARKER_KEY) return null;
            return marker === null ? null : { value: marker };
          },
          async upsert({ where, create, update }) {
            if (where.key === bootstrapFeature.BOOTSTRAP_MARKER_KEY) {
              marker = update.value;
              return { value: marker };
            }
            return { value: update.value || create.value || '1' };
          },
        },
        role: {
          async findUnique({ where }) {
            return roles.get(where.code) || null;
          },
        },
        user: {
          async findUnique({ where }) {
            return {
              id: where.id,
              isAdmin: false,
              isSuperAdmin: false,
              deletedAt: null,
            };
          },
        },
        userRole: {
          async findFirst({ where }) {
            return [...assignments.values()].find((row) => matchesTuple(row, where)) || null;
          },
          async create({ data }) {
            calls.push({ kind: 'create', data });
            assignments.set(data.id, { ...data });
            return { ...data };
          },
          async update({ where, data }) {
            calls.push({ kind: 'update', where, data });
            const row = assignments.get(where.id);
            Object.assign(row, data);
            return { ...row };
          },
          async deleteMany({ where }) {
            const exceptId = where.AND?.find((entry) => entry.id?.not)?.id?.not;
            let count = 0;
            for (const [id, row] of assignments) {
              if (
                row.userId === where.userId
                && (!where.scope || row.scope === where.scope)
                && (
                  where.scopeId === undefined
                  || (row.scopeId || null) === (where.scopeId || null)
                )
                && id !== exceptId
                && String(row.assignedBy || '').startsWith('rbac-system:v')
              ) {
                assignments.delete(id);
                count += 1;
              }
            }
            return { count };
          },
        },
        async $executeRawUnsafe(sql, ...params) {
          calls.push({ kind: 'execute', sql, params });
          return 1;
        },
        async $queryRawUnsafe(sql, ...params) {
          calls.push({ kind: 'query', sql, params });
          if (/set_config/i.test(sql)) {
            return [{ lock_timeout: params[0] }];
          }
          if (/pg_advisory_xact_lock/i.test(sql)) {
            await acquire(`global:${params[0]}`);
            return [{ locked: true }];
          }
          if (/rbac_bootstrap_set_reconcile/i.test(sql)) {
            let assignment = [...assignments.values()].find((row) => (
              row.userId === 'race-user'
              && row.roleId === 'role_platform_admin'
              && row.scope === 'GLOBAL'
              && row.scopeId == null
            ));
            if (assignment) {
              assignment.assignedBy = systemAssignmentsModule.SYSTEM_ASSIGNMENT_TAG;
            } else {
              assignment = {
                id: 'bootstrap-platform-assignment',
                userId: 'race-user',
                roleId: 'role_platform_admin',
                scope: 'GLOBAL',
                scopeId: null,
                assignedBy: systemAssignmentsModule.SYSTEM_ASSIGNMENT_TAG,
              };
              assignments.set(assignment.id, assignment);
            }
            for (const [id, row] of assignments) {
              if (
                id !== assignment.id
                && row.userId === 'race-user'
                && row.scope === 'GLOBAL'
                && row.scopeId == null
                && String(row.assignedBy || '').startsWith('rbac-system:v')
              ) {
                assignments.delete(id);
              }
            }
            return [{ desired_count: 1, inserted_count: 1 }];
          }
          if (/AS user_id[\s\S]+UNION ALL/i.test(sql)) {
            return [{
              user_id: 'race-user',
              role_id: 'role_platform_admin',
              scope: 'GLOBAL',
              scope_id: null,
            }];
          }
          if (/system_assignment_drift_count/i.test(sql)) {
            return [{
              legacy_admin_gap_count: 0,
              superadmin_permission_gap_count: 0,
              canonical_catalog_gap_count: 0,
              canonical_role_permission_excess_count: 0,
              system_assignment_drift_count: 0,
            }];
          }
          return [{ version: '1' }];
        },
      };
      try {
        return await fn(tx);
      } finally {
        for (const held of releases.reverse()) {
          held.release();
          if (lockTails.get(held.lockKey) === held.tail) {
            lockTails.delete(held.lockKey);
          }
        }
      }
    },
  };
  const bootstrap = bootstrapFeature.createRbacBootstrapService({
    prisma,
    env: { NODE_ENV: 'production', RBAC_ENFORCEMENT_MODE: 'enforce' },
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    logger: { info() {}, warn() {}, error() {} },
  });
  const lifecycle = syncFeature.createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
  });

  await Promise.all([
    bootstrap.bootstrap(),
    lifecycle.syncLegacyAdminAssignment({
      userId: 'race-user',
      isAdmin: false,
      isSuperAdmin: false,
      actorId: 'actor-1',
    }),
  ]);

  assert.equal(assignments.size, 1);
  const tupleLockKeys = [
    ...calls
      .filter((call) => call.kind === 'query' && /pg_advisory_xact_lock/i.test(call.sql))
      .map((call) => call.params[0]),
  ];
  assert.equal(tupleLockKeys.length, 2);
  assert.equal(tupleLockKeys[0], tupleLockKeys[1]);
  assert.equal(tupleLockKeys[0], systemAssignmentsModule.RBAC_MUTATION_LOCK_KEY);
  assert.equal(calls.some((call) => /ON\s+CONFLICT[\s\S]*COALESCE/i.test(call.sql || '')), false);
});

test('natural-tuple assignment upsert uses the global lock and no expression conflict target', async () => {
  const upsertSystemManagedAssignment = requireFeature(
    systemAssignmentsModule?.upsertSystemManagedAssignment,
    'lock-based system assignment upsert',
  );
  const assignments = new Map();
  const calls = [];
  const lockTails = new Map();
  let transactionSequence = 0;

  const prisma = {
    async $transaction(fn) {
      transactionSequence += 1;
      const transactionId = transactionSequence;
      const releases = [];
      const tx = {
        async $queryRawUnsafe(sql, lockKey) {
          if (/set_config/i.test(sql)) return [{ lock_timeout: lockKey }];
          calls.push({ kind: 'lock', transactionId, sql, lockKey });
          const previous = lockTails.get(lockKey) || Promise.resolve();
          let release;
          const current = new Promise((resolve) => { release = resolve; });
          const tail = previous.then(() => current);
          lockTails.set(lockKey, tail);
          await previous;
          releases.push({ lockKey, release, tail });
          return [{ locked: true }];
        },
        userRole: {
          async findFirst({ where }) {
            calls.push({ kind: 'select', transactionId, where });
            return [...assignments.values()].find((row) => (
              row.userId === where.userId
              && row.roleId === where.roleId
              && row.scope === where.scope
              && (row.scopeId || null) === (where.scopeId || null)
            )) || null;
          },
          async create({ data }) {
            calls.push({ kind: 'create', transactionId, data });
            assignments.set(data.id, { ...data });
            return { ...data };
          },
          async update({ where, data }) {
            calls.push({ kind: 'update', transactionId, where, data });
            const row = assignments.get(where.id);
            Object.assign(row, data);
            return { ...row };
          },
        },
      };
      try {
        return await fn(tx);
      } finally {
        for (const held of releases.reverse()) {
          held.release();
          if (lockTails.get(held.lockKey) === held.tail) {
            lockTails.delete(held.lockKey);
          }
        }
      }
    },
  };
  const tuple = {
    userId: 'fresh-schema-user',
    roleId: 'role_user',
    scope: 'GLOBAL',
    scopeId: null,
  };

  const [first, second] = await Promise.all([
    prisma.$transaction((tx) => upsertSystemManagedAssignment(tx, {
      id: 'id-format-a',
      ...tuple,
    })),
    prisma.$transaction((tx) => upsertSystemManagedAssignment(tx, {
      id: 'completely-different-id-format-b',
      ...tuple,
    })),
  ]);

  assert.equal(assignments.size, 1);
  assert.equal(first.id, second.id);
  assert.equal(calls.filter((call) => call.kind === 'lock').length, 2);
  assert.equal(calls.filter((call) => call.kind === 'create').length, 1);
  assert.equal(calls.filter((call) => call.kind === 'update').length, 1);
  assert.ok(calls.every((call) => !/ON\s+CONFLICT/i.test(call.sql || '')));
  assert.match(calls.find((call) => call.kind === 'lock').sql, /pg_advisory_xact_lock/i);
});

test('concurrent A-to-B role transitions serialize to one system assignment', async () => {
  const feature = requireFeature(syncModule, 'RBAC assignment sync');
  const tagPrefix = requireFeature(
    systemAssignmentsModule?.SYSTEM_ASSIGNMENT_TAG_PREFIX,
    'system assignment tag family',
  );
  const committed = new Map();
  const lockTails = new Map();
  const roles = new Map([
    ['PLATFORM_ADMIN', { id: 'role_platform_admin', code: 'PLATFORM_ADMIN' }],
    ['USER', { id: 'role_user', code: 'USER' }],
  ]);

  function visibleRows(staged) {
    const rows = new Map(committed);
    for (const [id, row] of staged) {
      if (row === null) rows.delete(id);
      else rows.set(id, row);
    }
    return [...rows.values()];
  }

  const prisma = {
    async $transaction(fn) {
      const staged = new Map();
      const releases = [];
      const tx = {
        role: {
          async findUnique({ where }) {
            return roles.get(where.code) || null;
          },
        },
        user: {
          async findUnique({ where }) {
            return {
              id: where.id,
              isAdmin: false,
              isSuperAdmin: false,
              deletedAt: null,
            };
          },
        },
        userRole: {
          async findFirst({ where }) {
            const row = visibleRows(staged).find((candidate) => (
              candidate.userId === where.userId
              && candidate.scope === where.scope
              && (candidate.scopeId || null) === (where.scopeId || null)
              && (!where.roleId || candidate.roleId === where.roleId)
              && (
                where.roleId
                || String(candidate.assignedBy || '').startsWith(tagPrefix)
              )
            ));
            if (!row) return null;
            return {
              ...row,
              role: [...roles.values()].find((role) => role.id === row.roleId),
            };
          },
          async create({ data }) {
            staged.set(data.id, { ...data });
            return { ...data };
          },
          async update({ where, data }) {
            const row = visibleRows(staged).find((candidate) => candidate.id === where.id);
            const updated = { ...row, ...data };
            staged.set(where.id, updated);
            return updated;
          },
          async deleteMany({ where }) {
            let count = 0;
            const exceptId = where.AND?.find((entry) => entry.id?.not)?.id?.not;
            for (const row of visibleRows(staged)) {
              if (
                row.userId === where.userId
                && row.scope === where.scope
                && (row.scopeId || null) === (where.scopeId || null)
                && row.id !== exceptId
                && String(row.assignedBy || '').startsWith(tagPrefix)
              ) {
                staged.set(row.id, null);
                count += 1;
              }
            }
            return { count };
          },
        },
        async $queryRawUnsafe(sql, lockKey) {
          if (/set_config/i.test(sql)) return [{ lock_timeout: lockKey }];
          const previous = lockTails.get(lockKey) || Promise.resolve();
          let release;
          const current = new Promise((resolve) => { release = resolve; });
          const tail = previous.then(() => current);
          lockTails.set(lockKey, tail);
          await previous;
          releases.push({ lockKey, release, tail });
          return [{ locked: true }];
        },
      };
      try {
        const result = await fn(tx);
        for (const [id, row] of staged) {
          if (row === null) committed.delete(id);
          else committed.set(id, row);
        }
        return result;
      } finally {
        for (const held of releases.reverse()) {
          held.release();
          if (lockTails.get(held.lockKey) === held.tail) lockTails.delete(held.lockKey);
        }
      }
    },
  };
  const service = feature.createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
  });

  await Promise.all([
    service.syncLegacyAdminAssignment({
      userId: 'transition-user',
      isAdmin: true,
      isSuperAdmin: false,
    }),
    service.syncLegacyAdminAssignment({
      userId: 'transition-user',
      isAdmin: false,
      isSuperAdmin: false,
    }),
  ]);

  const rows = [...committed.values()].filter(
    (row) => row.userId === 'transition-user'
      && String(row.assignedBy || '').startsWith(tagPrefix),
  );
  assert.equal(rows.length, 1);
  assert.ok(['role_platform_admin', 'role_user'].includes(rows[0].roleId));
});

test('organization cleanup takes global lock then rereads user and membership before delete', async () => {
  const feature = requireFeature(syncModule, 'RBAC assignment sync');
  const events = [];
  const tx = {
    async $queryRawUnsafe(sql, ...params) {
      if (/set_config/i.test(sql)) {
        const reset = String(params[0]) === '0';
        events.push({ kind: reset ? 'lock-timeout-reset' : 'lock-timeout', sql });
        return [{ lock_timeout: params[0] }];
      }
      events.push({ kind: 'lock', sql });
      return [{ locked: true }];
    },
    user: {
      async findUnique() {
        events.push({ kind: 'user-read' });
        return { id: 'cleanup-user', deletedAt: null };
      },
    },
    orgMembership: {
      async findUnique() {
        events.push({ kind: 'membership-read' });
        return null;
      },
    },
    userRole: {
      async findFirst() {
        events.push({ kind: 'read' });
        return { id: 'system-org-assignment' };
      },
      async deleteMany() {
        events.push({ kind: 'delete' });
        return { count: 1 };
      },
    },
  };
  const service = feature.createRbacAssignmentSyncService({
    prisma: { $transaction: async (fn) => fn(tx) },
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
  });

  await service.removeOrgRoleAssignment({
    userId: 'cleanup-user',
    orgId: 'org-1',
  });

  assert.deepEqual(
    events.map((event) => event.kind),
    [
      'lock-timeout',
      'lock',
      'lock-timeout-reset',
      'user-read',
      'membership-read',
      'read',
      'delete',
    ],
  );
  assert.match(events[1].sql, /pg_advisory_xact_lock/i);
});

test('user-wide cleanup uses one global lock then rereads state before deletion', async () => {
  const feature = requireFeature(syncModule, 'RBAC assignment sync');
  const events = [];
  const assignments = [
    {
      id: 'global-system',
      userId: 'cleanup-user',
      scope: 'GLOBAL',
      scopeId: null,
      assignedBy: systemAssignmentsModule.SYSTEM_ASSIGNMENT_TAG,
    },
    {
      id: 'org-system',
      userId: 'cleanup-user',
      scope: 'ORG',
      scopeId: 'org-1',
      assignedBy: systemAssignmentsModule.SYSTEM_ASSIGNMENT_TAG,
    },
  ];
  const tx = {
    async $queryRawUnsafe(sql, key) {
      if (/set_config/i.test(sql)) {
        events.push({
          kind: String(key) === '0' ? 'lock-timeout-reset' : 'lock-timeout',
          sql,
          key,
        });
        return [{ lock_timeout: key }];
      }
      events.push({ kind: 'lock', sql, key });
      return [{ locked: true }];
    },
    user: {
      async findUnique() {
        events.push({ kind: 'user-read' });
        return { id: 'cleanup-user', deletedAt: null };
      },
    },
    userRole: {
      async findMany() {
        events.push({ kind: 'read' });
        return assignments;
      },
      async deleteMany({ where }) {
        events.push({ kind: 'delete', where });
        return { count: where.id.in.length };
      },
    },
  };
  const service = feature.createRbacAssignmentSyncService({
    prisma: { $transaction: async (fn) => fn(tx) },
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
  });

  const result = await service.removeUserSystemAssignments({
    userId: 'cleanup-user',
  });

  assert.equal(result.deleted, 2);
  assert.deepEqual(
    events.map((event) => event.kind),
    ['lock-timeout', 'lock', 'lock-timeout-reset', 'user-read', 'read', 'delete'],
  );
  assert.equal(events[1].key, systemAssignmentsModule.RBAC_MUTATION_LOCK_KEY);
});

test('bootstrap and lifecycle assignment code has no expression-index ON CONFLICT dependency', () => {
  const bootstrapFeature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const bootstrapAssignmentSql = bootstrapFeature.buildRbacBootstrapStatements()
    .filter((statement) => /"user_roles"/i.test(statement.sql))
    .map((statement) => statement.sql)
    .concat([
      bootstrapFeature.RBAC_SET_BASED_RECONCILIATION_SQL,
    ])
    .join('\n');
  const lifecycleSource = fs.readFileSync(
    path.resolve(__dirname, '../src/services/rbac-assignment-sync.js'),
    'utf8',
  );
  const expressionConflict = /ON\s+CONFLICT\s*\(\s*"userId"\s*,\s*"roleId"\s*,\s*"scope"\s*,\s*\(\s*COALESCE\("scopeId"/i;

  assert.doesNotMatch(bootstrapAssignmentSql, expressionConflict);
  assert.doesNotMatch(lifecycleSource, expressionConflict);
  assert.match(
    bootstrapFeature.RBAC_SET_BASED_RECONCILIATION_SQL,
    /INSERT INTO "user_roles"[\s\S]+SELECT[\s\S]+FROM desired/i,
  );
  assert.match(
    systemAssignmentsModule.RBAC_MUTATION_LOCK_SQL,
    /pg_advisory_xact_lock\(\$1::bigint\)/i,
  );
  assert.doesNotMatch(bootstrapAssignmentSql, /hashtextextended|scope_locks/i);
});

test('legacy user flag mutations and assignment sync share one transaction', async () => {
  const feature = requireFeature(syncModule, 'RBAC assignment sync');
  const prisma = fakePrisma();
  const service = feature.createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
  });

  const user = await service.updateLegacyAdminUser({
    userId: 'target-1',
    data: { name: 'Changed', isAdmin: true },
    select: { id: true, name: true, isAdmin: true },
    actorId: 'actor-1',
  });

  assert.equal(user.isAdmin, true);
  const transactionIndex = prisma.calls.findIndex((call) => call.kind === 'transaction');
  const updateIndex = prisma.calls.findIndex((call) => call.kind === 'user.update');
  const upsertIndex = prisma.calls.findIndex((call) => call.kind === 'userRole.create');
  assert.ok(transactionIndex >= 0 && updateIndex > transactionIndex && upsertIndex > updateIndex);
});

test('legacy superadmin demotion takes global lock before state and invariant reads', async () => {
  const feature = requireFeature(syncModule, 'RBAC assignment sync');
  const events = [];
  let userState = {
    id: 'demoted-user',
    isAdmin: false,
    isSuperAdmin: true,
    deletedAt: null,
  };
  const assignments = new Map([
    ['system-superadmin', {
      id: 'system-superadmin',
      userId: 'demoted-user',
      roleId: 'role_superadmin',
      scope: 'GLOBAL',
      scopeId: null,
      assignedBy: systemAssignmentsModule.SYSTEM_ASSIGNMENT_TAG,
      role: { id: 'role_superadmin', code: 'SUPERADMIN' },
    }],
  ]);
  const tx = {
    async $queryRawUnsafe(sql, ...params) {
      if (/set_config/i.test(sql)) {
        const reset = String(params[0]) === '0';
        events.push(reset ? 'lock-timeout-reset' : 'lock-timeout');
        return [{ lock_timeout: params[0] }];
      }
      if (/pg_advisory_xact_lock/i.test(sql)) {
        events.push('global-lock');
        return [{ locked: true }];
      }
      events.push('invariant-count');
      return [{ effective_count: 1 }];
    },
    user: {
      async findUnique() {
        events.push('user-read');
        return { ...userState };
      },
      async update({ data }) {
        events.push('user-update');
        userState = { ...userState, ...data };
        return { ...userState };
      },
    },
    role: {
      async findUnique({ where }) {
        return {
          id: where.code === 'USER' ? 'role_user' : 'role_superadmin',
          code: where.code,
        };
      },
    },
    userRole: {
      async findFirst({ where }) {
        return [...assignments.values()].find((row) => (
          row.userId === where.userId
          && row.scope === where.scope
          && (!where.roleId || row.roleId === where.roleId)
        )) || null;
      },
      async create({ data }) {
        assignments.set(data.id, data);
        return data;
      },
      async update({ where, data }) {
        const updated = { ...assignments.get(where.id), ...data };
        assignments.set(where.id, updated);
        return updated;
      },
      async deleteMany() {
        return { count: 0 };
      },
    },
  };
  const service = feature.createRbacAssignmentSyncService({
    prisma: { $transaction: async (fn) => fn(tx) },
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
  });

  await service.updateLegacyAdminUser({
    userId: 'demoted-user',
    data: { isSuperAdmin: false },
  });

  assert.deepEqual(events.slice(0, 6), [
    'lock-timeout',
    'global-lock',
    'lock-timeout-reset',
    'user-read',
    'invariant-count',
    'user-update',
  ]);
  assert.equal(
    events.filter((event) => event === 'global-lock').length,
    1,
  );
});

test('dual-write mutation bumps durable permission version before commit', async () => {
  const feature = requireFeature(syncModule, 'RBAC assignment sync');
  const prisma = fakePrisma();
  const events = [];
  const service = feature.createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async (userId) => events.push(`invalidate:${userId}`),
    writeAuditLog: async (db) => {
      assert.notEqual(db, prisma);
      events.push('audit');
    },
    bumpPermissionVersion: async (db) => {
      assert.notEqual(db, prisma);
      events.push('version');
      return '8';
    },
  });

  await service.updateLegacyAdminUser({
    userId: 'target-1',
    data: { isAdmin: true },
    actorId: 'actor-1',
  });

  assert.deepEqual(events, ['audit', 'version', 'invalidate:target-1']);
});

test('legacy and organization mutation sites use the dual-write service', () => {
  const adminSource = fs.readFileSync(path.resolve(__dirname, '../src/routes/admin.js'), 'utf8');
  const orgSource = fs.readFileSync(path.resolve(__dirname, '../src/routes/orgs.js'), 'utf8');

  assert.match(adminSource, /updateLegacyAdminUser/);
  assert.match(adminSource, /createLegacyAdminUser/);
  assert.match(orgSource, /syncOrgRoleAssignment/);
  assert.match(orgSource, /removeOrgRoleAssignment/);
  assert.ok(
    (orgSource.match(/syncOrgRoleAssignment/g) || []).length >= 7,
    'create, accept, role-change, and both ownership paths must dual-write',
  );
  assert.ok(
    (orgSource.match(/removeOrgRoleAssignment/g) || []).length >= 3,
    'leave and member-removal paths must remove system grants',
  );
});

test('organization source mutations acquire the global RBAC lock before row changes', () => {
  const orgSource = fs.readFileSync(path.resolve(__dirname, '../src/routes/orgs.js'), 'utf8');
  const transactionStart = /\b(?:prisma|db)\.\$transaction\(async \(tx\) => \{/g;
  const sourceMutation = /(?:tx\.organization\.create|tx\.orgMembership\.(?:create|upsert|update|updateMany|delete))/g;
  const transactionIndexes = [...orgSource.matchAll(transactionStart)].map((match) => match.index);
  const mutations = [...orgSource.matchAll(sourceMutation)];

  assert.ok(mutations.length >= 10, 'expected all organization lifecycle mutations');
  for (const mutation of mutations) {
    const transactionIndex = transactionIndexes
      .filter((index) => index < mutation.index)
      .at(-1);
    assert.notEqual(transactionIndex, undefined, mutation[0]);
    const transactionPrefix = orgSource.slice(transactionIndex, mutation.index);
    assert.match(
      transactionPrefix,
      /await acquireRbacMutationLockIfSupported\(tx\)/,
      `${mutation[0]} must not take a row lock before the global RBAC lock`,
    );
  }
});

test('one fixed global RBAC mutation lock replaces every subject-scope lock key', () => {
  const lockKey = requireFeature(
    systemAssignmentsModule?.RBAC_MUTATION_LOCK_KEY,
    'global RBAC mutation lock key',
  );
  const lockSql = requireFeature(
    systemAssignmentsModule?.RBAC_MUTATION_LOCK_SQL,
    'global RBAC mutation lock SQL',
  );

  assert.equal(Number.isSafeInteger(lockKey), true);
  assert.match(lockSql, /pg_advisory_xact_lock/i);
  assert.doesNotMatch(lockSql, /hashtext|userId|scopeId/i);
  assert.equal(systemAssignmentsModule?.assignmentTupleLockKey, undefined);
  assert.equal(systemAssignmentsModule?.acquireAssignmentSubjectScopeLock, undefined);
});

test('global RBAC mutation lock timeout is a retryable 503 instead of an unbounded wait', async () => {
  const acquire = requireFeature(
    systemAssignmentsModule?.acquireRbacMutationLock,
    'bounded global RBAC mutation lock',
  );
  const calls = [];
  const tx = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      if (/set_config/i.test(sql)) return [{ lock_timeout: '250ms' }];
      const error = new Error('canceling statement due to lock timeout');
      error.code = 'P2010';
      error.meta = { code: '55P03' };
      throw error;
    },
  };

  await assert.rejects(
    acquire(tx, { timeoutMs: 250 }),
    (error) => error?.code === 'RBAC_MUTATION_BUSY'
      && error?.statusCode === 503
      && error?.retryable === true
      && error?.retryAfterSeconds === 1,
  );
  assert.equal(
    calls.filter((call) => /pg_advisory_xact_lock/i.test(call.sql)).length,
    1,
  );
});

test('global lock acquisition restores transaction lock_timeout before later RBAC queries', async () => {
  const acquire = requireFeature(
    systemAssignmentsModule?.acquireRbacMutationLock,
    'bounded global RBAC mutation lock',
  );
  const events = [];
  let lockTimeout = '0';
  const tx = {
    async $queryRawUnsafe(sql, ...params) {
      if (/set_config/i.test(sql)) {
        lockTimeout = String(params[0] ?? '0');
        events.push(lockTimeout === '0' ? 'timeout-reset' : 'timeout-bounded');
        return [{ lock_timeout: lockTimeout }];
      }
      if (/pg_advisory_xact_lock/i.test(sql)) {
        events.push('lock');
        return [{ locked: true }];
      }
      events.push('post-lock-query');
      if (lockTimeout !== '0') {
        const error = new Error('later query canceled by stale lock timeout');
        error.code = '55P03';
        throw error;
      }
      return [{ ok: true }];
    },
  };

  await acquire(tx, { timeoutMs: 250 });
  const rows = await tx.$queryRawUnsafe('SELECT 1 /* post-lock authorization query */');

  assert.deepEqual(rows, [{ ok: true }]);
  assert.deepEqual(events, [
    'timeout-bounded',
    'lock',
    'timeout-reset',
    'post-lock-query',
  ]);
});

test('timeout while restoring normal lock_timeout is not mapped as acquisition contention', async () => {
  const acquire = requireFeature(
    systemAssignmentsModule?.acquireRbacMutationLock,
    'bounded global RBAC mutation lock',
  );
  let setCalls = 0;
  const resetError = new Error('canceling statement due to lock timeout during reset');
  resetError.code = '55P03';
  const tx = {
    async $queryRawUnsafe(sql) {
      if (/set_config/i.test(sql)) {
        setCalls += 1;
        if (setCalls === 2) throw resetError;
        return [{ lock_timeout: '250ms' }];
      }
      if (/pg_advisory_xact_lock/i.test(sql)) return [{ locked: true }];
      return [];
    },
  };

  await assert.rejects(
    acquire(tx, { timeoutMs: 250 }),
    (error) => error === resetError && error.code !== 'RBAC_MUTATION_BUSY',
  );
});

test('legacy sync locks then re-reads active user flags as source of truth', async () => {
  const feature = requireFeature(syncModule, 'RBAC assignment sync');
  const events = [];
  const assignments = new Map();
  const roles = new Map([
    ['USER', { id: 'role_user', code: 'USER' }],
    ['PLATFORM_ADMIN', { id: 'role_platform_admin', code: 'PLATFORM_ADMIN' }],
  ]);
  const tx = {
    async $queryRawUnsafe(sql) {
      events.push(/pg_advisory_xact_lock/i.test(sql) ? 'lock' : 'lock-timeout');
      return [{ locked: true }];
    },
    user: {
      async findUnique() {
        events.push('user-read');
        return {
          id: 'source-user',
          isAdmin: false,
          isSuperAdmin: false,
          deletedAt: null,
        };
      },
    },
    role: {
      async findUnique({ where }) {
        events.push(`role-read:${where.code}`);
        return roles.get(where.code) || null;
      },
    },
    userRole: {
      async findFirst({ where }) {
        return [...assignments.values()].find((row) => (
          row.userId === where.userId
          && (!where.roleId || row.roleId === where.roleId)
          && row.scope === where.scope
          && (row.scopeId || null) === (where.scopeId || null)
        )) || null;
      },
      async create({ data }) {
        assignments.set(data.id, data);
        return data;
      },
      async update({ where, data }) {
        const updated = { ...assignments.get(where.id), ...data };
        assignments.set(where.id, updated);
        return updated;
      },
      async deleteMany() {
        return { count: 0 };
      },
    },
  };
  const service = feature.createRbacAssignmentSyncService({
    prisma: { $transaction: async (fn) => fn(tx) },
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
  });

  const result = await service.syncLegacyAdminAssignment({
    userId: 'source-user',
    isAdmin: true,
    isSuperAdmin: false,
  });

  assert.equal(result.roleCode, 'USER', 'caller flags must not override persisted state');
  assert.ok(events.indexOf('lock') < events.indexOf('user-read'));
  assert.ok(events.indexOf('user-read') < events.indexOf('role-read:USER'));
});

test('organization sync rereads active user and membership role after the global lock', async () => {
  const feature = requireFeature(syncModule, 'RBAC assignment sync');
  const events = [];
  const assignments = new Map();
  const tx = {
    async $queryRawUnsafe(sql) {
      events.push(/pg_advisory_xact_lock/i.test(sql) ? 'lock' : 'lock-timeout');
      return [{ locked: true }];
    },
    user: {
      async findUnique() {
        events.push('user-read');
        return { id: 'org-user', deletedAt: null };
      },
    },
    orgMembership: {
      async findUnique() {
        events.push('membership-read');
        return { userId: 'org-user', orgId: 'org-1', role: 'MEMBER' };
      },
    },
    role: {
      async findUnique({ where }) {
        events.push(`role-read:${where.code}`);
        if (where.code !== 'ORG_MEMBER') return null;
        return { id: 'role_org_member', code: 'ORG_MEMBER' };
      },
    },
    userRole: {
      async findFirst({ where }) {
        return [...assignments.values()].find((row) => (
          row.userId === where.userId
          && (!where.roleId || row.roleId === where.roleId)
          && row.scope === where.scope
          && (row.scopeId || null) === (where.scopeId || null)
        )) || null;
      },
      async create({ data }) {
        assignments.set(data.id, data);
        return data;
      },
      async update({ where, data }) {
        const updated = { ...assignments.get(where.id), ...data };
        assignments.set(where.id, updated);
        return updated;
      },
      async deleteMany() {
        return { count: 0 };
      },
    },
  };
  const service = feature.createRbacAssignmentSyncService({
    prisma: { $transaction: async (fn) => fn(tx) },
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
  });

  const result = await service.syncOrgRoleAssignment({
    userId: 'org-user',
    orgId: 'org-1',
    orgRole: 'OWNER',
  });

  assert.equal(result.roleCode, 'ORG_MEMBER');
  assert.deepEqual(
    events.filter((event) => event !== 'lock-timeout'),
    ['lock', 'user-read', 'membership-read', 'role-read:ORG_MEMBER'],
  );
});

test('deleted user is cleaned under the global lock and cannot regain an assignment', async () => {
  const feature = requireFeature(syncModule, 'RBAC assignment sync');
  const systemTag = requireFeature(
    systemAssignmentsModule?.SYSTEM_ASSIGNMENT_TAG,
    'system assignment tag',
  );
  const events = [];
  const assignments = new Map([
    ['stale-system', {
      id: 'stale-system',
      userId: 'deleted-user',
      roleId: 'role_user',
      scope: 'GLOBAL',
      scopeId: null,
      assignedBy: systemTag,
    }],
    ['stale-manual', {
      id: 'stale-manual',
      userId: 'deleted-user',
      roleId: 'role_user',
      scope: 'GLOBAL',
      scopeId: null,
      assignedBy: 'human-admin',
    }],
  ]);
  const tx = {
    async $queryRawUnsafe(sql) {
      events.push(/pg_advisory_xact_lock/i.test(sql) ? 'lock' : 'lock-timeout');
      return [{ locked: true }];
    },
    user: {
      async findUnique() {
        events.push('user-read');
        return {
          id: 'deleted-user',
          isAdmin: false,
          isSuperAdmin: false,
          deletedAt: new Date(),
        };
      },
    },
    role: {
      async findUnique() {
        assert.fail('a deleted user must be rejected before role lookup');
      },
    },
    userRole: {
      async deleteMany({ where }) {
        events.push('delete');
        let count = 0;
        for (const [id, row] of assignments) {
          if (row.userId === where.userId) {
            assignments.delete(id);
            count += 1;
          }
        }
        return { count };
      },
    },
  };
  const service = feature.createRbacAssignmentSyncService({
    prisma: { $transaction: async (fn) => fn(tx) },
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
  });

  const result = await service.syncLegacyAdminAssignment({
    userId: 'deleted-user',
    isAdmin: true,
    isSuperAdmin: true,
  });

  assert.equal(result.denied, true);
  assert.equal(result.reason, 'inactive_user');
  assert.equal(assignments.size, 0);
  assert.deepEqual(
    events.filter((event) => event !== 'lock-timeout'),
    ['lock', 'user-read', 'delete'],
  );
});

test('concurrent bootstrap delete and grant critical sections serialize without deadlock', async () => {
  const acquire = requireFeature(
    systemAssignmentsModule?.acquireRbacMutationLock,
    'global RBAC mutation lock',
  );
  let lockTail = Promise.resolve();
  let active = 0;
  let maxActive = 0;
  const lockKeys = new Set();
  const events = [];

  async function run(label) {
    let releaseLock = null;
    const tx = {
      async $queryRawUnsafe(sql, ...params) {
        if (/set_config/i.test(sql)) return [{ lock_timeout: '500ms' }];
        lockKeys.add(params[0]);
        const previous = lockTail;
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        lockTail = previous.then(() => held);
        await previous;
        releaseLock = release;
        return [{ locked: true }];
      },
    };
    try {
      await acquire(tx, { timeoutMs: 500 });
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`${label}:enter`);
      await new Promise((resolve) => setTimeout(resolve, 2));
      events.push(`${label}:exit`);
      active -= 1;
    } finally {
      releaseLock?.();
    }
  }

  await Promise.all([
    run('bootstrap'),
    run('delete'),
    run('grant'),
  ]);

  assert.equal(maxActive, 1);
  assert.equal(lockKeys.size, 1);
  assert.deepEqual(events, [
    'bootstrap:enter',
    'bootstrap:exit',
    'delete:enter',
    'delete:exit',
    'grant:enter',
    'grant:exit',
  ]);
});
