'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRbacAssignmentSyncService,
} = require('../src/services/rbac-assignment-sync');
const {
  onUserSessionsRevoked,
} = require('../src/services/auth/user-session-revocation-events');
const {
  authUserLockKey,
} = require('../src/services/auth/auth-user-lock');
const {
  SessionRepository,
} = require('../src/repositories/SessionRepository');
const twoFASms = require('../src/services/two-fa-sms');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createConcurrentAuthDb({
  onSessionCreate,
  onChallengeCreate,
  onUserDelete,
} = {}) {
  const state = {
    user: {
      id: 'race-user',
      isAdmin: false,
      isSuperAdmin: false,
      deletedAt: null,
    },
    sessions: [],
    challenges: [],
    calls: [],
  };
  const heldLocks = new Map();

  async function acquire(key) {
    const normalized = String(key);
    const prior = heldLocks.get(normalized);
    let releasePrior;
    if (prior) {
      await new Promise((resolve) => { prior.waiters.push(resolve); });
    }
    const holder = { waiters: [] };
    heldLocks.set(normalized, holder);
    releasePrior = () => {
      if (heldLocks.get(normalized) !== holder) return;
      heldLocks.delete(normalized);
      holder.waiters.shift()?.();
    };
    return releasePrior;
  }

  const prisma = {
    user: { findUnique() {} },
    session: { create() {} },
    async $queryRawUnsafe() {},
    async $transaction(callback) {
      const releases = [];
      const tx = {
        async $queryRawUnsafe(sql, ...params) {
          if (/pg_advisory_xact_lock/i.test(sql)) {
            state.calls.push(`wait-lock:${params[0]}`);
            releases.push(await acquire(params[0]));
            state.calls.push(`got-lock:${params[0]}`);
          }
          return [{ locked: true }];
        },
        user: {
          async findUnique() {
            state.calls.push(`user.read:${state.user.deletedAt ? 'deleted' : 'active'}`);
            return { ...state.user };
          },
          async update({ data }) {
            await onUserDelete?.(state);
            Object.assign(state.user, data);
            state.calls.push('user.deleted');
            return { ...state.user };
          },
          async delete() {
            state.user.deletedAt = new Date();
            return { ...state.user };
          },
        },
        session: {
          async create({ data }) {
            await onSessionCreate?.(state);
            state.sessions.push({ ...data });
            state.calls.push('session.created');
            return { id: `session-${state.sessions.length}`, ...data };
          },
          async deleteMany({ where }) {
            const before = state.sessions.length;
            state.sessions = state.sessions.filter((row) => row.userId !== where.userId);
            state.calls.push('sessions.revoked');
            return { count: before - state.sessions.length };
          },
        },
        partialSession: {
          async deleteMany() { return { count: 0 }; },
        },
        twoFAChallenge: {
          async updateMany({ where, data }) {
            let count = 0;
            for (const row of state.challenges) {
              if (row.userId !== where.userId) continue;
              if (where.consumedAt === null && row.consumedAt !== null) continue;
              Object.assign(row, data);
              count += 1;
            }
            return { count };
          },
          async create({ data }) {
            await onChallengeCreate?.(state);
            const row = { id: `challenge-${state.challenges.length + 1}`, consumedAt: null, ...data };
            state.challenges.push(row);
            state.calls.push('challenge.created');
            return row;
          },
          async deleteMany({ where }) {
            const before = state.challenges.length;
            state.challenges = state.challenges.filter((row) => row.userId !== where.userId);
            state.calls.push('challenges.revoked');
            return { count: before - state.challenges.length };
          },
        },
        userRole: {
          async findMany() { return []; },
          async deleteMany() { return { count: 0 }; },
        },
      };
      try {
        return await callback(tx);
      } finally {
        for (const release of releases.reverse()) release();
      }
    },
  };
  prisma.twoFAChallenge = { create() {} };
  return { prisma, state };
}

test('soft deletion atomically revokes sessions and unfinished 2FA challenges, then broadcasts', async () => {
  const calls = [];
  const user = {
    id: 'deleted-user',
    isAdmin: false,
    isSuperAdmin: false,
    deletedAt: null,
  };
  const tx = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push(/pg_advisory_xact_lock/i.test(sql)
        ? `lock:${params[0]}`
        : `lock-timeout:${params[0]}`);
      return [{ ok: true }];
    },
    user: {
      async findUnique() {
        return { ...user };
      },
      async update({ data }) {
        Object.assign(user, data);
        calls.push('user.update');
        return { ...user };
      },
    },
    userRole: {
      async findMany() {
        return [];
      },
      async deleteMany() {
        calls.push('roles.delete');
        return { count: 0 };
      },
    },
    session: {
      async deleteMany({ where }) {
        assert.deepEqual(where, { userId: user.id });
        calls.push('sessions.delete');
        return { count: 2 };
      },
    },
    partialSession: {
      async deleteMany({ where }) {
        assert.deepEqual(where, { userId: user.id });
        calls.push('partials.delete');
        return { count: 1 };
      },
    },
    twoFAChallenge: {
      async deleteMany({ where }) {
        assert.deepEqual(where, { userId: user.id });
        calls.push('sms-challenges.delete');
        return { count: 1 };
      },
    },
  };
  const prisma = {
    async $transaction(fn) {
      calls.push('transaction.begin');
      const result = await fn(tx);
      calls.push('transaction.commit');
      return result;
    },
  };
  const service = createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
  });
  const events = [];
  const unsubscribe = onUserSessionsRevoked((event) => events.push(event));

  try {
    await service.softDeleteUser({
      userId: user.id,
      actorId: user.id,
      deletedAt: new Date('2026-07-11T09:00:00.000Z'),
    });
  } finally {
    unsubscribe();
  }

  assert.ok(calls.indexOf('sessions.delete') < calls.indexOf('transaction.commit'));
  assert.ok(calls.indexOf('partials.delete') < calls.indexOf('transaction.commit'));
  assert.ok(calls.indexOf('sms-challenges.delete') < calls.indexOf('transaction.commit'));
  const lockCalls = calls.filter((call) => call.startsWith('lock:'));
  assert.equal(lockCalls.length, 2);
  assert.equal(lockCalls[1], `lock:${authUserLockKey(user.id)}`);
  assert.ok(calls.indexOf(lockCalls[1]) < calls.indexOf('user.update'));
  assert.deepEqual(events, [{
    userId: 'deleted-user',
    reason: 'account_deleted',
  }]);
});

test('deletion awaits the bounded revocation publisher after transaction commit', async () => {
  const publishEntered = deferred();
  const allowPublish = deferred();
  const { prisma, state } = createConcurrentAuthDb();
  const assignments = createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
    emitSessionsRevoked: async () => {
      publishEntered.resolve();
      await allowPublish.promise;
    },
  });
  let settled = false;

  const deletion = assignments.softDeleteUser({
    userId: state.user.id,
    actorId: state.user.id,
  }).finally(() => { settled = true; });
  await publishEntered.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  allowPublish.resolve();
  await deletion;
  assert.equal(settled, true);
});

test('session issuance that wins the auth lock is revoked by the queued deletion', async () => {
  const createEntered = deferred();
  const allowCreate = deferred();
  const { prisma, state } = createConcurrentAuthDb({
    onSessionCreate: async () => {
      createEntered.resolve();
      await allowCreate.promise;
    },
  });
  const sessions = new SessionRepository({
    prisma,
    withRetry: (fn) => fn(),
  });
  const assignments = createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
    emitSessionsRevoked: async () => {},
  });

  const issuance = sessions.create({
    userId: state.user.id,
    token: 'race-token',
    expiresAt: new Date(Date.now() + 60_000),
  });
  await createEntered.promise;
  const deletion = assignments.softDeleteUser({
    userId: state.user.id,
    actorId: state.user.id,
  });
  await new Promise((resolve) => setImmediate(resolve));
  allowCreate.resolve();
  await Promise.all([issuance, deletion]);

  assert.ok(state.user.deletedAt instanceof Date);
  assert.deepEqual(state.sessions, []);
  assert.ok(state.calls.indexOf('session.created') < state.calls.indexOf('user.deleted'));
  assert.ok(state.calls.indexOf('user.deleted') < state.calls.indexOf('sessions.revoked'));
});

test('deletion that wins the auth lock makes queued session issuance fail inactive', async () => {
  const deleteEntered = deferred();
  const allowDelete = deferred();
  const { prisma, state } = createConcurrentAuthDb({
    onUserDelete: async () => {
      deleteEntered.resolve();
      await allowDelete.promise;
    },
  });
  const sessions = new SessionRepository({
    prisma,
    withRetry: (fn) => fn(),
  });
  const assignments = createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
    emitSessionsRevoked: async () => {},
  });

  const deletion = assignments.softDeleteUser({
    userId: state.user.id,
    actorId: state.user.id,
  });
  await deleteEntered.promise;
  const issuance = sessions.create({
    userId: state.user.id,
    token: 'late-token',
    expiresAt: new Date(Date.now() + 60_000),
  });
  await new Promise((resolve) => setImmediate(resolve));
  allowDelete.resolve();
  await deletion;

  await assert.rejects(issuance, (error) => error?.code === 'ACCOUNT_INACTIVE');
  assert.deepEqual(state.sessions, []);
  assert.ok(state.calls.lastIndexOf('user.read:deleted') > state.calls.indexOf('user.deleted'));
});

test('SMS challenge issuance that wins the lock is removed by queued deletion', async () => {
  const challengeEntered = deferred();
  const allowChallenge = deferred();
  const { prisma, state } = createConcurrentAuthDb({
    onChallengeCreate: async () => {
      challengeEntered.resolve();
      await allowChallenge.promise;
    },
  });
  const assignments = createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
    emitSessionsRevoked: async () => {},
  });

  const issuance = twoFASms.createSmsChallenge(
    prisma,
    { id: state.user.id },
    '+14155551234',
  );
  await challengeEntered.promise;
  const deletion = assignments.softDeleteUser({
    userId: state.user.id,
    actorId: state.user.id,
  });
  await new Promise((resolve) => setImmediate(resolve));
  allowChallenge.resolve();
  await Promise.all([issuance, deletion]);

  assert.deepEqual(state.challenges, []);
  assert.ok(state.calls.indexOf('challenge.created') < state.calls.indexOf('user.deleted'));
  assert.ok(state.calls.indexOf('user.deleted') < state.calls.indexOf('challenges.revoked'));
});

test('deletion that wins the lock prevents queued SMS challenge creation', async () => {
  const deleteEntered = deferred();
  const allowDelete = deferred();
  const { prisma, state } = createConcurrentAuthDb({
    onUserDelete: async () => {
      deleteEntered.resolve();
      await allowDelete.promise;
    },
  });
  const assignments = createRbacAssignmentSyncService({
    prisma,
    invalidatePermissionsCache: async () => {},
    writeAuditLog: async () => {},
    bumpPermissionVersion: async () => '1',
    emitSessionsRevoked: async () => {},
  });

  const deletion = assignments.softDeleteUser({
    userId: state.user.id,
    actorId: state.user.id,
  });
  await deleteEntered.promise;
  const issuance = twoFASms.createSmsChallenge(
    prisma,
    { id: state.user.id },
    '+14155551234',
  );
  await new Promise((resolve) => setImmediate(resolve));
  allowDelete.resolve();
  await deletion;

  await assert.rejects(issuance, (error) => error?.code === 'ACCOUNT_INACTIVE');
  assert.deepEqual(state.challenges, []);
});
