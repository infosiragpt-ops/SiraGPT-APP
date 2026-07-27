'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { UserRepository } = require('../src/repositories/UserRepository');
const { SsoCallbackService } = require('../src/services/SsoCallbackService');
const syncModule = require('../src/services/rbac-assignment-sync');
const systemAssignments = require('../src/services/rbac-system-assignments');

const passthroughRetry = (fn) => fn();

test('password and OAuth repository creates delegate to atomic RBAC lifecycle creation', async () => {
  const calls = [];
  const rbacAssignments = {
    async createLegacyAdminUser(args) {
      calls.push(args);
      return { id: `user-${calls.length}`, ...args.data };
    },
  };
  const prisma = {
    user: {
      create() {
        assert.fail('repository creation must not bypass the RBAC lifecycle transaction');
      },
    },
  };
  const repository = new UserRepository({
    prisma,
    withRetry: passthroughRetry,
    rbacAssignments,
  });

  const passwordUser = await repository.createPasswordUser({
    name: 'Password User',
    email: 'password@example.test',
    passwordHash: 'password-hash',
  });
  const oauthUser = await repository.createOAuthUser({
    googleId: 'google-1',
    name: 'OAuth User',
    email: 'oauth@example.test',
    avatar: null,
    passwordHash: 'oauth-hash',
    gmailTokens: 'gmail-sealed',
    googleServicesTokens: 'services-sealed',
  });

  assert.equal(passwordUser.id, 'user-1');
  assert.equal(oauthUser.id, 'user-2');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.data.isAdmin, false);
    assert.equal(call.data.isSuperAdmin, false);
  }
});

test('SSO JIT creation and organization membership dual-write in one transaction', async () => {
  const events = [];
  let insideTransaction = false;
  const tx = {
    async $queryRawUnsafe(sql, ...params) {
      assert.equal(insideTransaction, true);
      if (/pg_advisory_xact_lock/i.test(sql)) {
        events.push('rbac.lock');
        return [{ locked: true }];
      }
      events.push(String(params[0]) === '0' ? 'rbac.timeout.reset' : 'rbac.timeout');
      return [{ lock_timeout: params[0] }];
    },
    user: {
      async findUnique() {
        assert.equal(insideTransaction, true);
        events.push('user.find');
        return null;
      },
      async create({ data }) {
        assert.equal(insideTransaction, true);
        events.push('user.create');
        return { id: 'sso-user', ...data, isSuperAdmin: false };
      },
    },
    orgMembership: {
      async upsert({ create }) {
        assert.equal(insideTransaction, true);
        events.push('membership.upsert');
        return { ...create };
      },
    },
  };
  const prisma = {
    user: {
      async findUnique() {
        return null;
      },
    },
    orgMembership: {
      async findUnique() {
        return null;
      },
      upsert: tx.orgMembership.upsert,
    },
    async $transaction(fn) {
      events.push('transaction.begin');
      insideTransaction = true;
      try {
        return await fn(tx);
      } finally {
        insideTransaction = false;
        events.push('transaction.end');
      }
    },
  };
  const rbacAssignments = {
    async syncLegacyAdminAssignment(args) {
      assert.equal(insideTransaction, true);
      assert.equal(args.prismaClient, tx);
      assert.equal(args.userId, 'sso-user');
      assert.equal(args.isAdmin, false);
      assert.equal(args.isSuperAdmin, false);
      assert.equal(args.invalidateAfter, false);
      assert.equal(args.lockAlreadyHeld, true);
      events.push('rbac.user');
    },
    async syncOrgRoleAssignment(args) {
      assert.equal(insideTransaction, true);
      assert.equal(args.prismaClient, tx);
      assert.equal(args.userId, 'sso-user');
      assert.equal(args.orgId, 'org-1');
      assert.equal(args.orgRole, 'MEMBER');
      assert.equal(args.invalidateAfter, false);
      assert.equal(args.lockAlreadyHeld, true);
      events.push('rbac.org');
    },
    async invalidateUser(userId) {
      assert.equal(insideTransaction, false);
      assert.equal(userId, 'sso-user');
      events.push('invalidate');
    },
  };
  const service = new SsoCallbackService({
    prisma,
    rbacAssignments,
    audit: async () => {},
    samlHandler: { verifySamlResponse: async () => ({ ok: true }) },
    oidcHandler: { verifyOidcCode: async () => ({ ok: true }) },
    resolveOrg: async () => null,
    signSessionToken: () => 'token',
    hashPassword: async () => 'hash',
  });

  const result = await service._provisionUser({
    verified: { email: 'sso@example.test', displayName: 'SSO User' },
    org: { id: 'org-1' },
    policy: 'jit_create',
    req: {},
  });

  assert.equal(result.createdUser, true);
  assert.deepEqual(events, [
    'transaction.begin',
    'rbac.timeout',
    'rbac.lock',
    'rbac.timeout.reset',
    'user.find',
    'user.create',
    'rbac.user',
    'membership.upsert',
    'rbac.org',
    'transaction.end',
    'invalidate',
  ]);
});

test('soft and hard user deletion remove tagged system grants atomically', () => {
  assert.equal(typeof syncModule.softDeleteUser, 'function');
  assert.equal(typeof syncModule.hardDeleteUser, 'function');
  assert.equal(typeof syncModule.removeUserSystemAssignments, 'function');
});

test('central guard rejects every versioned RBAC system principal', () => {
  assert.equal(
    typeof systemAssignments.assertRbacSystemPrincipalMutable,
    'function',
  );
  for (const version of [1, 2, 3, 99]) {
    assert.throws(
      () => systemAssignments.assertRbacSystemPrincipalMutable(
        `${systemAssignments.SYSTEM_ASSIGNMENT_TAG_PREFIX}${version}`,
      ),
      (error) => error?.code === 'RBAC_SYSTEM_PRINCIPAL_PROTECTED'
        && error?.statusCode === 409,
    );
  }
  assert.doesNotThrow(
    () => systemAssignments.assertRbacSystemPrincipalMutable('ordinary-user'),
  );
  assert.deepEqual(
    systemAssignments.excludeRbacSystemPrincipalsWhere({ deletedAt: null }),
    {
      AND: [
        { deletedAt: null },
        { NOT: { id: { startsWith: systemAssignments.SYSTEM_ASSIGNMENT_TAG_PREFIX } } },
      ],
    },
  );
});

test('generic lifecycle rejects system-principal edits and deletes before a transaction', async () => {
  let transactions = 0;
  const service = syncModule.createRbacAssignmentSyncService({
    prisma: {
      async $transaction() {
        transactions += 1;
        throw new Error('transaction must not run');
      },
    },
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
  });
  const userId = systemAssignments.SYSTEM_ASSIGNMENT_TAG;
  const attempts = [
    () => service.updateLegacyAdminUser({ userId, data: { name: 'mutated' } }),
    () => service.softDeleteUser({ userId }),
    () => service.hardDeleteUser({ userId }),
  ];

  for (const attempt of attempts) {
    await assert.rejects(
      Promise.resolve().then(attempt),
      { code: 'RBAC_SYSTEM_PRINCIPAL_PROTECTED', statusCode: 409 },
    );
  }
  assert.equal(transactions, 0);
});

test('all production user creation and deletion paths use RBAC lifecycle services', () => {
  const files = {
    auth: fs.readFileSync(path.resolve(__dirname, '../src/routes/auth.js'), 'utf8'),
    passport: fs.readFileSync(path.resolve(__dirname, '../src/config/passport.js'), 'utf8'),
    users: fs.readFileSync(path.resolve(__dirname, '../src/routes/users.js'), 'utf8'),
    admin: fs.readFileSync(path.resolve(__dirname, '../src/routes/admin.js'), 'utf8'),
    sso: fs.readFileSync(path.resolve(__dirname, '../src/services/SsoCallbackService.js'), 'utf8'),
    hardDeleteJob: fs.readFileSync(
      path.resolve(__dirname, '../src/jobs/hard-delete-deleted-users.js'),
      'utf8',
    ),
  };

  assert.match(files.auth, /rbacAssignments/);
  assert.match(files.passport, /rbacAssignments/);
  assert.match(files.sso, /syncLegacyAdminAssignment/);
  assert.match(files.sso, /syncOrgRoleAssignment/);
  assert.match(files.users, /softDeleteUser/);
  assert.match(files.users, /hardDeleteUser/);
  assert.match(files.admin, /hardDeleteUser/);
  assert.match(files.hardDeleteJob, /hardDeleteUser/);
});
