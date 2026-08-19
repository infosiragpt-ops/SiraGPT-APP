'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

function loadOptional(specifier) {
  try {
    return require(specifier);
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' && error.message.includes(specifier.replace('../', ''))) {
      return null;
    }
    throw error;
  }
}

const catalog = loadOptional('../src/services/rbac-catalog');
const bootstrapModule = loadOptional('../src/services/rbac-bootstrap');
const systemAssignments = loadOptional('../src/services/rbac-system-assignments');

function requireFeature(value, label) {
  assert.ok(value, `${label} has not been implemented`);
  return value;
}

function executeAssignmentDriftSql(sql, {
  users = [],
  roles = [],
  memberships = [],
  assignments = [],
} = {}) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE "users" (
        "id" TEXT PRIMARY KEY,
        "isAdmin" INTEGER NOT NULL,
        "isSuperAdmin" INTEGER NOT NULL,
        "deletedAt" TEXT
      );
      CREATE TABLE "roles" (
        "id" TEXT PRIMARY KEY,
        "code" TEXT NOT NULL
      );
      CREATE TABLE "org_memberships" (
        "userId" TEXT NOT NULL,
        "orgId" TEXT NOT NULL,
        "role" TEXT NOT NULL
      );
      CREATE TABLE "user_roles" (
        "id" TEXT PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "roleId" TEXT NOT NULL,
        "scope" TEXT NOT NULL,
        "scopeId" TEXT,
        "assignedBy" TEXT
      );
    `);
    const insertUser = db.prepare(
      'INSERT INTO "users" ("id", "isAdmin", "isSuperAdmin", "deletedAt") VALUES (?, ?, ?, ?)',
    );
    const insertRole = db.prepare('INSERT INTO "roles" ("id", "code") VALUES (?, ?)');
    const insertMembership = db.prepare(
      'INSERT INTO "org_memberships" ("userId", "orgId", "role") VALUES (?, ?, ?)',
    );
    const insertAssignment = db.prepare(
      'INSERT INTO "user_roles" ("id", "userId", "roleId", "scope", "scopeId", "assignedBy") VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const user of users) {
      insertUser.run(
        user.id,
        user.isAdmin ? 1 : 0,
        user.isSuperAdmin ? 1 : 0,
        user.deletedAt || null,
      );
    }
    for (const role of roles) insertRole.run(role.id, role.code);
    for (const membership of memberships) {
      insertMembership.run(membership.userId, membership.orgId, membership.role);
    }
    for (const assignment of assignments) {
      insertAssignment.run(
        assignment.id,
        assignment.userId,
        assignment.roleId,
        assignment.scope,
        assignment.scopeId ?? null,
        assignment.assignedBy ?? null,
      );
    }
    const sqliteSql = sql
      .replace(/::"RoleScope"/g, '')
      .replace(/::text/g, '');
    return Number(db.prepare(sqliteSql).get().system_assignment_drift_count);
  } finally {
    db.close();
  }
}

function executeReconciliationCandidatesSql(sql, {
  users = [],
  roles = [],
  memberships = [],
} = {}) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE "users" (
        "id" TEXT PRIMARY KEY,
        "isAdmin" INTEGER NOT NULL,
        "isSuperAdmin" INTEGER NOT NULL,
        "deletedAt" TEXT
      );
      CREATE TABLE "roles" (
        "id" TEXT PRIMARY KEY,
        "code" TEXT NOT NULL
      );
      CREATE TABLE "org_memberships" (
        "userId" TEXT NOT NULL,
        "orgId" TEXT NOT NULL,
        "role" TEXT NOT NULL
      );
    `);
    const insertUser = db.prepare(
      'INSERT INTO "users" ("id", "isAdmin", "isSuperAdmin", "deletedAt") VALUES (?, ?, ?, ?)',
    );
    const insertRole = db.prepare('INSERT INTO "roles" ("id", "code") VALUES (?, ?)');
    const insertMembership = db.prepare(
      'INSERT INTO "org_memberships" ("userId", "orgId", "role") VALUES (?, ?, ?)',
    );
    for (const user of users) {
      insertUser.run(
        user.id,
        user.isAdmin ? 1 : 0,
        user.isSuperAdmin ? 1 : 0,
        user.deletedAt || null,
      );
    }
    for (const role of roles) insertRole.run(role.id, role.code);
    for (const membership of memberships) {
      insertMembership.run(membership.userId, membership.orgId, membership.role);
    }
    const sqliteSql = sql
      .replace(/::"RoleScope"/g, '')
      .replace(/::text/g, '');
    return db.prepare(sqliteSql).all();
  } finally {
    db.close();
  }
}

function fakePrisma(readiness = {
  legacy_admin_gap_count: 0,
  superadmin_permission_gap_count: 0,
}) {
  const calls = [];
  const tx = {
    async $executeRawUnsafe(sql, ...params) {
      calls.push({ kind: 'execute', sql, params });
      return 1;
    },
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ kind: 'query', sql, params });
      if (/AS user_id[\s\S]+UNION ALL/i.test(sql)) return [];
      return [readiness];
    },
  };
  return {
    calls,
    async $transaction(fn) {
      calls.push({ kind: 'transaction' });
      return fn(tx);
    },
  };
}

function markerAwarePrisma({
  markerValue = null,
  readiness = {
    legacy_admin_gap_count: 0,
    superadmin_permission_gap_count: 0,
    canonical_catalog_gap_count: 0,
    system_assignment_drift_count: 0,
  },
} = {}) {
  const calls = [];
  let marker = markerValue;
  let transactionTail = Promise.resolve();

  function makeTx() {
    return {
      systemSettings: {
        async findUnique({ where }) {
          calls.push({ kind: 'marker-read', key: where.key });
          return marker === null ? null : { key: where.key, value: marker };
        },
        async upsert(args) {
          calls.push({ kind: 'marker-upsert', args });
          marker = args.update.value;
          return { key: args.where.key, value: marker };
        },
      },
      async $executeRawUnsafe(sql, ...params) {
        calls.push({ kind: 'execute', sql, params });
        return 1;
      },
      async $queryRawUnsafe(sql, ...params) {
        calls.push({ kind: 'query', sql, params });
        if (/AS user_id[\s\S]+UNION ALL/i.test(sql)) return [];
        return [readiness];
      },
    };
  }

  return {
    calls,
    get marker() { return marker; },
    async $transaction(fn) {
      const run = transactionTail.then(async () => {
        calls.push({ kind: 'transaction' });
        const markerBefore = marker;
        try {
          return await fn(makeTx());
        } catch (error) {
          marker = markerBefore;
          throw error;
        }
      });
      transactionTail = run.catch(() => {});
      return run;
    },
  };
}

function scaleAwarePrisma(candidateCount) {
  let marker = null;
  let queryCount = 0;
  const lockCalls = [];
  const readiness = {
    legacy_admin_gap_count: 0,
    superadmin_permission_gap_count: 0,
    canonical_catalog_gap_count: 0,
    canonical_role_permission_excess_count: 0,
    system_assignment_drift_count: 0,
  };
  const tx = {
    systemSettings: {
      async findUnique() {
        queryCount += 1;
        return marker === null ? null : { value: marker };
      },
      async upsert({ update }) {
        queryCount += 1;
        marker = update.value;
        return { value: marker };
      },
    },
    userRole: {
      async findFirst() {
        queryCount += 1;
        return null;
      },
      async create({ data }) {
        queryCount += 1;
        return data;
      },
      async update({ data }) {
        queryCount += 1;
        return data;
      },
      async deleteMany() {
        queryCount += 1;
        return { count: 0 };
      },
    },
    async $executeRawUnsafe(sql, ...params) {
      queryCount += 1;
      if (/pg_advisory/i.test(sql)) lockCalls.push({ sql, params });
      return 1;
    },
    async $queryRawUnsafe(sql, ...params) {
      queryCount += 1;
      if (/pg_advisory/i.test(sql)) lockCalls.push({ sql, params });
      if (/rbac_bootstrap_scope_locks/i.test(sql)) {
        return [{ locked_count: candidateCount }];
      }
      if (/rbac_bootstrap_set_reconcile/i.test(sql)) {
        return [{ adopted_count: 0, inserted_count: candidateCount, deleted_count: 0 }];
      }
      if (/AS user_id[\s\S]+UNION ALL/i.test(sql)) {
        return Array.from({ length: candidateCount }, (_, index) => ({
          user_id: `scale-user-${index}`,
          role_id: 'role_user',
          scope: 'GLOBAL',
          scope_id: null,
        }));
      }
      if (/system_assignment_drift_count/i.test(sql)) return [readiness];
      return [{ version: '1', locked: true }];
    },
  };
  return {
    get queryCount() { return queryCount; },
    lockCalls,
    async $transaction(fn) {
      return fn(tx);
    },
  };
}

test('RBAC source-of-truth catalog defines PLATFORM_ADMIN without implicit escalation', () => {
  const source = requireFeature(catalog, 'RBAC catalog');
  assert.ok(source.ROLE_CODES.includes('PLATFORM_ADMIN'));
  assert.ok(source.ROLE_CODES.includes('SUPERADMIN'));
  assert.deepEqual(source.ORG_ROLE_TO_ROLE_CODE, {
    OWNER: 'ORG_OWNER',
    ADMIN: 'ORG_ADMIN',
    MEMBER: 'ORG_MEMBER',
    VIEWER: 'ORG_VIEWER',
  });

  const allPermissionCodes = new Set(source.PERMISSIONS.map((permission) => permission.code));
  assert.deepEqual(new Set(source.ROLE_PERMISSIONS.SUPERADMIN), allPermissionCodes);

  const platform = new Set(source.ROLE_PERMISSIONS.PLATFORM_ADMIN);
  for (const required of [
    'admin.users.read',
    'admin.models.manage',
    'admin.metrics.read',
    'audit.read',
  ]) {
    assert.ok(platform.has(required), `PLATFORM_ADMIN missing ${required}`);
  }
  for (const forbidden of ['users.impersonate', 'rbac.manage']) {
    assert.equal(platform.has(forbidden), false, `PLATFORM_ADMIN must not inherit ${forbidden}`);
  }
});

test('bootstrap SQL is replay-safe and backfills global plus organization assignments', () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const statements = feature.buildRbacBootstrapStatements();
  assert.ok(Array.isArray(statements));
  assert.ok(statements.length >= 6);
  const sql = statements.map((statement) => statement.sql).join('\n');

  assert.match(sql, /ON CONFLICT/i);
  assert.match(sql, /"isSuperAdmin"[\s\S]+SUPERADMIN/);
  assert.match(sql, /"isAdmin"[\s\S]+PLATFORM_ADMIN/);
  assert.match(sql, /ELSE 'USER'/);
  assert.match(sql, /FROM "org_memberships"/);
  for (const role of ['ORG_OWNER', 'ORG_ADMIN', 'ORG_MEMBER', 'ORG_VIEWER']) {
    assert.match(sql, new RegExp(role));
  }
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\b/i);
});

test('bootstrap is process-idempotent, invalidates permission cache, and audits readiness', async () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const prisma = fakePrisma();
  const invalidations = [];
  const audits = [];
  const service = feature.createRbacBootstrapService({
    prisma,
    env: { NODE_ENV: 'production', RBAC_ENFORCEMENT_MODE: 'enforce' },
    invalidatePermissionsCache: (userId) => invalidations.push(userId ?? null),
    writeAuditLog: async (_prisma, entry) => {
      audits.push(entry);
      return { id: 'audit-rbac' };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const first = await service.bootstrap();
  const callsAfterFirst = prisma.calls.length;
  const second = await service.bootstrap();

  assert.equal(first.state, 'ready');
  assert.equal(first.mode, 'enforce');
  assert.equal(second.replay, true);
  assert.equal(prisma.calls.length, callsAfterFirst);
  assert.deepEqual(invalidations, [null]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'rbac_bootstrap_ready');
  assert.equal(service.getStatus().ready, true);
});

test('enforce bootstrap fails closed with value-free diagnostics when readiness gaps remain', async () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const prisma = markerAwarePrisma({
    readiness: {
      legacy_admin_gap_count: 2,
      superadmin_permission_gap_count: 3,
      accidental_user_id: 'sensitive-user-id',
      accidental_permission: 'sensitive.permission',
    },
  });
  const service = feature.createRbacBootstrapService({
    prisma,
    env: { NODE_ENV: 'production', RBAC_ENFORCEMENT_MODE: 'enforce' },
    logger: { info() {}, warn() {}, error() {} },
  });

  await assert.rejects(
    () => service.bootstrap(),
    (error) => {
      assert.equal(error.code, 'RBAC_READINESS_FAILED');
      const publicDiagnostic = JSON.stringify(error.diagnostics);
      assert.doesNotMatch(publicDiagnostic, /sensitive-user-id|sensitive\.permission/);
      assert.deepEqual(error.diagnostics, {
        legacyAdminGapCount: 2,
        superadminPermissionGapCount: 3,
      });
      return true;
    },
  );
  assert.equal(service.getStatus().state, 'failed');
  assert.equal(service.getStatus().ready, false);
  assert.equal(service.getStatus().errorCode, 'RBAC_READINESS_FAILED');
  assert.equal(prisma.marker, null);
});

test('shadow bootstrap reports readiness gaps without opening enforce mode', async () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const prisma = markerAwarePrisma({
    readiness: {
      legacy_admin_gap_count: 1,
      superadmin_permission_gap_count: 0,
    },
  });
  const service = feature.createRbacBootstrapService({
    prisma,
    env: { NODE_ENV: 'test', RBAC_ENFORCEMENT_MODE: 'shadow' },
    logger: { info() {}, warn() {}, error() {} },
  });

  const status = await service.bootstrap();
  assert.equal(status.state, 'degraded');
  assert.equal(status.mode, 'shadow');
  assert.equal(status.ready, false);
  assert.equal(status.errorCode, 'RBAC_READINESS_FAILED');
  assert.equal(prisma.marker, null);
});

test('first bootstrap writes a version marker and tags system-managed assignments', async () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  assert.equal(typeof feature.BOOTSTRAP_VERSION, 'number');
  assert.match(feature.BOOTSTRAP_MARKER_KEY, /^rbac_bootstrap:/);
  assert.match(feature.SYSTEM_ASSIGNMENT_PREFIX, /^rbac_sys_/);

  const prisma = markerAwarePrisma();
  const service = feature.createRbacBootstrapService({
    prisma,
    env: { NODE_ENV: 'production', RBAC_ENFORCEMENT_MODE: 'enforce' },
    logger: { info() {}, warn() {}, error() {} },
  });
  const status = await service.bootstrap();
  const sql = prisma.calls
    .filter((call) => call.kind === 'execute')
    .map((call) => call.sql)
    .join('\n');

  assert.equal(status.reconciled, true);
  assert.equal(status.bootstrapVersion, feature.BOOTSTRAP_VERSION);
  assert.match(sql, /"assignedBy"/);
  assert.ok(
    prisma.calls.some(
      (call) => call.kind === 'execute'
        && call.params.includes(systemAssignments.SYSTEM_ASSIGNMENT_TAG),
    ),
  );
  const markerWrite = prisma.calls.findIndex((call) => call.kind === 'marker-upsert');
  const finalSeed = prisma.calls.reduce(
    (index, call, current) => call.kind === 'execute' && /(?:INSERT INTO "(?:roles|permissions|role_permissions|users)"|UPDATE "user_roles"|DELETE FROM "user_roles")/i.test(call.sql)
      ? current
      : index,
    -1,
  );
  assert.ok(markerWrite > finalSeed, 'marker must be written after the one-time reconciliation');
  const readinessCheck = prisma.calls.findIndex(
    (call) => call.kind === 'query' && /system_assignment_drift_count/i.test(call.sql),
  );
  assert.ok(
    markerWrite > readinessCheck,
    'marker must be written only after readiness succeeds',
  );
  assert.match(prisma.marker, new RegExp(`"version":${feature.BOOTSTRAP_VERSION}`));
});

test('bootstrap seeds the assignedBy system principal for fresh FK-enabled schemas', () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const systemTag = requireFeature(
    systemAssignments?.SYSTEM_ASSIGNMENT_TAG,
    'versioned system assignment tag',
  );
  const principalSeed = feature.buildRbacBootstrapStatements().find(
    (statement) => statement.name === 'system_assignment_principal',
  );

  assert.ok(principalSeed, 'system provenance principal seed is required');
  assert.match(principalSeed.sql, /INSERT INTO "users"/i);
  assert.ok(principalSeed.params.includes(systemTag));
});

test('restart with a marker performs readiness only and never recreates grants', async () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const prisma = markerAwarePrisma();
  const first = feature.createRbacBootstrapService({
    prisma,
    env: { NODE_ENV: 'production', RBAC_ENFORCEMENT_MODE: 'enforce' },
    logger: { info() {}, warn() {}, error() {} },
  });
  await first.bootstrap();
  const seedCount = prisma.calls.filter(
    (call) => call.kind === 'execute' && /INSERT INTO "(?:roles|permissions|role_permissions|user_roles)"/i.test(call.sql),
  ).length;

  const restarted = feature.createRbacBootstrapService({
    prisma,
    env: { NODE_ENV: 'production', RBAC_ENFORCEMENT_MODE: 'enforce' },
    logger: { info() {}, warn() {}, error() {} },
  });
  const status = await restarted.bootstrap();
  const seedCountAfterRestart = prisma.calls.filter(
    (call) => call.kind === 'execute' && /INSERT INTO "(?:roles|permissions|role_permissions|user_roles)"/i.test(call.sql),
  ).length;

  assert.equal(status.reconciled, false);
  assert.equal(seedCountAfterRestart, seedCount);
});

test('post-bootstrap drift fails readiness without inserting missing assignments', async () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const prisma = markerAwarePrisma({
    markerValue: JSON.stringify({ version: feature.BOOTSTRAP_VERSION }),
    readiness: {
      legacy_admin_gap_count: 1,
      superadmin_permission_gap_count: 0,
      canonical_catalog_gap_count: 0,
      system_assignment_drift_count: 1,
    },
  });
  const service = feature.createRbacBootstrapService({
    prisma,
    env: { NODE_ENV: 'production', RBAC_ENFORCEMENT_MODE: 'enforce' },
    logger: { info() {}, warn() {}, error() {} },
  });

  await assert.rejects(() => service.bootstrap(), { code: 'RBAC_READINESS_FAILED' });
  assert.equal(
    prisma.calls.some(
      (call) => call.kind === 'execute' && /INSERT INTO "user_roles"/i.test(call.sql),
    ),
    false,
  );
});

test('readiness accepts assignedBy provenance across bootstrap generations', () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const sql = feature.RBAC_READINESS_SQL;
  const tagPrefix = requireFeature(
    systemAssignments?.SYSTEM_ASSIGNMENT_TAG_PREFIX,
    'system assignment tag family',
  );

  assert.ok(
    sql.split(`LIKE '${tagPrefix}%'`).length - 1 >= 4,
    'readiness must recognize assignedBy tags from all bootstrap versions',
  );
  assert.match(sql, /ur\."assignedBy"\s+LIKE/);
  assert.doesNotMatch(sql, /ur\."id"\s+LIKE\s+'(?:rbac|ur_)/);
});

test('readiness SQL does not classify a valid GLOBAL system row as organization drift', () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const sql = requireFeature(
    feature.RBAC_SYSTEM_ASSIGNMENT_DRIFT_SQL,
    'standalone RBAC assignment-drift SQL',
  );
  const driftCount = executeAssignmentDriftSql(sql, {
    users: [{ id: 'global-user', isAdmin: false, isSuperAdmin: false }],
    roles: [{ id: 'role-user', code: 'USER' }],
    assignments: [{
      id: 'rbac_sys_v2_g_global',
      userId: 'global-user',
      roleId: 'role-user',
      scope: 'GLOBAL',
      scopeId: null,
      assignedBy: systemAssignments.SYSTEM_ASSIGNMENT_TAG,
    }],
  });

  assert.equal(driftCount, 0);
});

test('readiness SQL does not classify a valid ORG system row as global drift', () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const sql = requireFeature(
    feature.RBAC_SYSTEM_ASSIGNMENT_DRIFT_SQL,
    'standalone RBAC assignment-drift SQL',
  );
  const driftCount = executeAssignmentDriftSql(sql, {
    users: [{ id: 'org-user', isAdmin: false, isSuperAdmin: false }],
    roles: [
      { id: 'role-user', code: 'USER' },
      { id: 'role-org-member', code: 'ORG_MEMBER' },
    ],
    memberships: [{ userId: 'org-user', orgId: 'org-1', role: 'MEMBER' }],
    assignments: [
      {
        id: 'rbac_sys_v2_g_org-user',
        userId: 'org-user',
        roleId: 'role-user',
        scope: 'GLOBAL',
        scopeId: null,
        assignedBy: systemAssignments.SYSTEM_ASSIGNMENT_TAG,
      },
      {
        id: 'rbac_sys_v2_o_org',
        userId: 'org-user',
        roleId: 'role-org-member',
        scope: 'ORG',
        scopeId: 'org-1',
        assignedBy: systemAssignments.SYSTEM_ASSIGNMENT_TAG,
      },
    ],
  });

  assert.equal(driftCount, 0);
});

test('reconciliation candidates exclude deleted users and their organization memberships', () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const sql = requireFeature(
    feature.RBAC_RECONCILIATION_CANDIDATES_SQL,
    'RBAC reconciliation-candidates SQL',
  );
  const candidates = executeReconciliationCandidatesSql(sql, {
    users: [
      { id: 'active-user', isAdmin: false, isSuperAdmin: false },
      {
        id: 'deleted-user',
        isAdmin: true,
        isSuperAdmin: true,
        deletedAt: new Date().toISOString(),
      },
    ],
    roles: [
      { id: 'role-user', code: 'USER' },
      { id: 'role-superadmin', code: 'SUPERADMIN' },
      { id: 'role-org-member', code: 'ORG_MEMBER' },
    ],
    memberships: [
      { userId: 'active-user', orgId: 'org-active', role: 'MEMBER' },
      { userId: 'deleted-user', orgId: 'org-deleted', role: 'MEMBER' },
    ],
  });

  assert.deepEqual(
    candidates.map((row) => [row.user_id, row.scope, row.scope_id]),
    [
      ['active-user', 'GLOBAL', null],
      ['active-user', 'ORG', 'org-active'],
    ],
  );
});

test('readiness ignores memberships whose user is soft-deleted', () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const sql = requireFeature(
    feature.RBAC_SYSTEM_ASSIGNMENT_DRIFT_SQL,
    'standalone RBAC assignment-drift SQL',
  );
  const driftCount = executeAssignmentDriftSql(sql, {
    users: [{
      id: 'deleted-member',
      isAdmin: false,
      isSuperAdmin: false,
      deletedAt: new Date().toISOString(),
    }],
    roles: [
      { id: 'role-user', code: 'USER' },
      { id: 'role-org-member', code: 'ORG_MEMBER' },
    ],
    memberships: [{
      userId: 'deleted-member',
      orgId: 'orphaned-membership',
      role: 'MEMBER',
    }],
  });

  assert.equal(driftCount, 0);
});

test('first bootstrap removes excess permissions only from canonical roles', () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const statements = feature.buildRbacBootstrapStatements();
  const cleanup = statements.find(
    (statement) => statement.name === 'canonical_role_permission_cleanup',
  );

  assert.ok(cleanup, 'canonical role-permission cleanup statement is required');
  assert.match(cleanup.sql, /DELETE FROM "role_permissions"/i);
  assert.match(cleanup.sql, /NOT EXISTS[\s\S]+expected/i);
  assert.deepEqual(cleanup.params, [catalog.ROLE_CODES]);
  assert.doesNotMatch(cleanup.sql, /DELETE FROM "user_roles"/i);
});

test('restart readiness rejects excess permission mappings on canonical roles', async () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const prisma = markerAwarePrisma({
    markerValue: JSON.stringify({ version: feature.BOOTSTRAP_VERSION }),
    readiness: {
      legacy_admin_gap_count: 0,
      superadmin_permission_gap_count: 0,
      canonical_catalog_gap_count: 0,
      canonical_role_permission_excess_count: 1,
      system_assignment_drift_count: 0,
    },
  });
  const service = feature.createRbacBootstrapService({
    prisma,
    env: { NODE_ENV: 'production', RBAC_ENFORCEMENT_MODE: 'enforce' },
    logger: { info() {}, warn() {}, error() {} },
  });

  await assert.rejects(
    () => service.bootstrap(),
    (error) => {
      assert.equal(error.code, 'RBAC_READINESS_FAILED');
      assert.equal(error.diagnostics.canonicalRolePermissionExcessCount, 1);
      return true;
    },
  );
  assert.equal(
    prisma.calls.some(
      (call) => call.kind === 'execute' && /DELETE FROM "role_permissions"/i.test(call.sql),
    ),
    false,
    'restart readiness must report drift without silently repairing it',
  );
});

test('concurrent first-boot services reconcile exactly once under the database lock', async () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const prisma = markerAwarePrisma();
  const options = {
    prisma,
    env: { NODE_ENV: 'production', RBAC_ENFORCEMENT_MODE: 'enforce' },
    logger: { info() {}, warn() {}, error() {} },
  };
  const a = feature.createRbacBootstrapService(options);
  const b = feature.createRbacBootstrapService(options);
  const [aStatus, bStatus] = await Promise.all([a.bootstrap(), b.bootstrap()]);
  const roleSeeds = prisma.calls.filter(
    (call) => call.kind === 'execute' && /INSERT INTO "roles"/i.test(call.sql),
  );

  assert.equal(roleSeeds.length, 1);
  assert.deepEqual(
    [aStatus.reconciled, bStatus.reconciled].sort(),
    [false, true],
  );
});

test('first-boot reconciliation query count is constant for thousands of users', async () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  async function run(candidateCount) {
    const prisma = scaleAwarePrisma(candidateCount);
    const service = feature.createRbacBootstrapService({
      prisma,
      env: { NODE_ENV: 'production', RBAC_ENFORCEMENT_MODE: 'enforce' },
      invalidatePermissionsCache: async () => {},
      writeAuditLog: async () => {},
      logger: { info() {}, warn() {}, error() {} },
    });
    await service.bootstrap();
    return prisma.queryCount;
  }

  const singleUserQueries = await run(1);
  const threeThousandUserQueries = await run(3_000);

  assert.ok(threeThousandUserQueries <= singleUserQueries + 1);
  assert.ok(threeThousandUserQueries < 30);
});

test('bootstrap acquires the one global mutation lock once regardless of user count', async () => {
  const feature = requireFeature(bootstrapModule, 'RBAC bootstrap');
  const globalLockKey = requireFeature(
    systemAssignments?.RBAC_MUTATION_LOCK_KEY,
    'global RBAC mutation lock key',
  );

  for (const candidateCount of [1, 3_000]) {
    const prisma = scaleAwarePrisma(candidateCount);
    const service = feature.createRbacBootstrapService({
      prisma,
      env: { NODE_ENV: 'production', RBAC_ENFORCEMENT_MODE: 'enforce' },
      invalidatePermissionsCache: async () => {},
      writeAuditLog: async () => {},
      logger: { info() {}, warn() {}, error() {} },
    });

    await service.bootstrap();
    const lockCalls = prisma.lockCalls || [];
    assert.equal(lockCalls.length, 1, `candidateCount=${candidateCount}`);
    assert.equal(lockCalls[0].params[0], globalLockKey);
  }

  assert.equal(feature.RBAC_RECONCILIATION_SCOPE_LOCK_SQL, undefined);
});
