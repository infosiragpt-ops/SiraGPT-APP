'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AUTH_USER_LOCK_SQL,
  acquireAuthUserLock,
  authUserLockKey,
  runAuthUserTransaction,
} = require('../src/services/auth/auth-user-lock');

test('per-user auth lock is deterministic, parameterized, bounded, and resets lock_timeout', async () => {
  assert.equal(typeof acquireAuthUserLock, 'function');
  const calls = [];
  const tx = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return [{ locked: true }];
    },
  };

  await acquireAuthUserLock(tx, 'user-sensitive-id', { timeoutMs: 75 });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].params, ['75ms']);
  assert.equal(calls[1].sql, AUTH_USER_LOCK_SQL);
  assert.deepEqual(calls[1].params, [authUserLockKey('user-sensitive-id')]);
  assert.equal(calls[1].sql.includes('user-sensitive-id'), false);
  assert.deepEqual(calls[2].params, ['0']);
  assert.equal(authUserLockKey('user-sensitive-id'), authUserLockKey('user-sensitive-id'));
  assert.notEqual(authUserLockKey('user-sensitive-id'), authUserLockKey('different-user'));
});

test('auth transaction re-reads the user after locking and denies inactive issuance', async () => {
  assert.equal(typeof runAuthUserTransaction, 'function');
  const calls = [];
  const tx = {
    async $queryRawUnsafe(sql) {
      calls.push(/pg_advisory_xact_lock/i.test(sql) ? 'lock' : 'timeout');
      return [{ locked: true }];
    },
    user: {
      async findUnique() {
        calls.push('user.read');
        return { id: 'deleted-user', deletedAt: new Date() };
      },
    },
  };
  const prisma = {
    async $transaction(callback) {
      return callback(tx);
    },
  };
  let wrote = false;

  await assert.rejects(
    runAuthUserTransaction(prisma, 'deleted-user', async () => {
      wrote = true;
    }),
    (error) => error?.code === 'ACCOUNT_INACTIVE',
  );

  assert.equal(wrote, false);
  assert.ok(calls.indexOf('lock') < calls.indexOf('user.read'));
});
