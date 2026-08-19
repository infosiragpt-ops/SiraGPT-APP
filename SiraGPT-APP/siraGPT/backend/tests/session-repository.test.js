'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionRepository } = require('../src/repositories/SessionRepository');

const passthroughRetry = (fn) => fn();
const silentLogger = { warn: () => {}, log: () => {}, error: () => {} };

function makePrismaSpy({ createImpl, updateImpl, deleteManyImpl } = {}) {
  const calls = { create: [], update: [], deleteMany: [] };
  return {
    session: {
      create: (arg) => {
        calls.create.push(arg);
        return createImpl
          ? createImpl(arg, calls.create.length)
          : Promise.resolve({ id: `s${calls.create.length}`, ...arg.data });
      },
      update: (arg) => {
        calls.update.push(arg);
        return updateImpl
          ? updateImpl(arg, calls.update.length)
          : Promise.resolve({ id: `s${calls.update.length}`, ...arg.data });
      },
      deleteMany: (arg) => {
        calls.deleteMany.push(arg);
        return deleteManyImpl
          ? deleteManyImpl(arg, calls.deleteMany.length)
          : Promise.resolve({ count: 1 });
      },
    },
    _calls: calls,
  };
}

test('SessionRepository: constructor validates deps', () => {
  assert.throws(() => new SessionRepository({ withRetry: passthroughRetry }), /prisma is required/);
  assert.throws(() => new SessionRepository({ prisma: {} }), /withRetry must be a function/);
});

test('create: writes fingerprint when supplied', async () => {
  const prisma = makePrismaSpy();
  const repo = new SessionRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });
  await repo.create({ userId: 'u1', token: 'tok', expiresAt: new Date(0), fingerprint: 'fp1' });
  assert.deepEqual(prisma._calls.create[0].data, {
    userId: 'u1', token: 'tok', expiresAt: new Date(0), fingerprint: 'fp1',
  });
});

test('create: omits fingerprint key when not supplied (does not insert null)', async () => {
  const prisma = makePrismaSpy();
  const repo = new SessionRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });
  await repo.create({ userId: 'u1', token: 'tok', expiresAt: new Date(0) });
  assert.deepEqual(prisma._calls.create[0].data, {
    userId: 'u1', token: 'tok', expiresAt: new Date(0),
  });
  assert.equal('fingerprint' in prisma._calls.create[0].data, false);
});

test('create: retries without fingerprint when legacy schema rejects column', async () => {
  let attempt = 0;
  const prisma = makePrismaSpy({
    createImpl: (arg) => {
      attempt += 1;
      if (attempt === 1) {
        const err = new Error('Unknown arg `fingerprint` in data');
        return Promise.reject(err);
      }
      return Promise.resolve({ id: 's1', ...arg.data });
    },
  });
  const repo = new SessionRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });
  await repo.create({ userId: 'u1', token: 'tok', expiresAt: new Date(0), fingerprint: 'fp1' });
  assert.equal(prisma._calls.create.length, 2);
  // First attempt had fingerprint, second did not.
  assert.equal(prisma._calls.create[0].data.fingerprint, 'fp1');
  assert.equal('fingerprint' in prisma._calls.create[1].data, false);
});

test('create: does NOT retry on unrelated errors (propagates)', async () => {
  const prisma = makePrismaSpy({
    createImpl: () => Promise.reject(new Error('connection refused')),
  });
  const repo = new SessionRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });
  await assert.rejects(
    () => repo.create({ userId: 'u1', token: 'tok', expiresAt: new Date(0), fingerprint: 'fp1' }),
    /connection refused/
  );
  assert.equal(prisma._calls.create.length, 1);
});

test('create: does NOT retry when fingerprint was not supplied (no false fallback)', async () => {
  const prisma = makePrismaSpy({
    createImpl: () => Promise.reject(new Error('fingerprint not found anywhere')),
  });
  const repo = new SessionRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });
  await assert.rejects(
    () => repo.create({ userId: 'u1', token: 'tok', expiresAt: new Date(0) }),
    /fingerprint not found/
  );
  assert.equal(prisma._calls.create.length, 1);
});

test('deleteByToken: forwards token to deleteMany (idempotent)', async () => {
  const prisma = makePrismaSpy();
  const repo = new SessionRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });
  await repo.deleteByToken('tok');
  assert.deepEqual(prisma._calls.deleteMany[0], { where: { token: 'tok' } });
});

test('updateByToken: writes new token + fingerprint', async () => {
  const prisma = makePrismaSpy();
  const repo = new SessionRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });
  await repo.updateByToken('old', { newToken: 'new', expiresAt: new Date(0), fingerprint: 'fp2' });
  assert.deepEqual(prisma._calls.update[0], {
    where: { token: 'old' },
    data: { token: 'new', expiresAt: new Date(0), fingerprint: 'fp2' },
  });
});

test('updateByToken: does NOT retry on unrelated errors (propagates)', async () => {
  const prisma = makePrismaSpy({
    updateImpl: () => Promise.reject(new Error('connection refused')),
  });
  const repo = new SessionRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });
  await assert.rejects(
    () => repo.updateByToken('old', { newToken: 'new', expiresAt: new Date(0), fingerprint: 'fp' }),
    /connection refused/
  );
  assert.equal(prisma._calls.update.length, 1);
});

test('updateByToken: does NOT retry when fingerprint absent (no false fallback)', async () => {
  const prisma = makePrismaSpy({
    updateImpl: () => Promise.reject(new Error('fingerprint mentioned')),
  });
  const repo = new SessionRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });
  await assert.rejects(
    () => repo.updateByToken('old', { newToken: 'new', expiresAt: new Date(0) }),
    /fingerprint mentioned/
  );
  assert.equal(prisma._calls.update.length, 1);
});

test('updateByToken: omits fingerprint key when not supplied', async () => {
  const prisma = makePrismaSpy();
  const repo = new SessionRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });
  await repo.updateByToken('old', { newToken: 'new', expiresAt: new Date(0) });
  assert.equal('fingerprint' in prisma._calls.update[0].data, false);
});

test('findById: forwards id + select to prisma.findUnique', async () => {
  const calls = [];
  const prisma = {
    session: {
      findUnique: (arg) => { calls.push(arg); return Promise.resolve({ id: arg.where.id }); },
    },
  };
  const repo = new SessionRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });
  const out = await repo.findById('s1', { select: { id: true, userId: true, token: true } });
  assert.equal(out.id, 's1');
  assert.deepEqual(calls[0], {
    where: { id: 's1' },
    select: { id: true, userId: true, token: true },
  });
});

test('deleteById + countActiveByUser + findActiveByUserPaged + deleteAllForUserExceptToken: smoke', async () => {
  let countCalls = 0;
  const prisma = {
    session: {
      delete: () => Promise.resolve({ id: 'x' }),
      deleteMany: (arg) => Promise.resolve({ count: 7, _arg: arg }),
      count: (arg) => { countCalls += 1; return Promise.resolve(3); },
      findMany: (arg) => Promise.resolve([{ id: 's1', _arg: arg }]),
      findUnique: () => Promise.resolve({ id: 's1' }),
    },
  };
  const repo = new SessionRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });

  assert.equal((await repo.deleteById('s1')).id, 'x');
  assert.equal(await repo.countActiveByUser({ userId: 'u1', now: new Date() }), 3);
  assert.equal(countCalls, 1);
  const rows = await repo.findActiveByUserPaged({ userId: 'u1', now: new Date(), page: 2, limit: 5 });
  assert.equal(rows[0]._arg.skip, 5);
  assert.equal(rows[0]._arg.take, 5);
  const del = await repo.deleteAllForUserExceptToken('u1', 'keep-tok');
  assert.equal(del.count, 7);
  assert.deepEqual(del._arg.where.NOT, { token: 'keep-tok' });
});

test('countActiveByUser: returns null when prisma lacks count() (legacy test mocks)', async () => {
  const prisma = { session: { /* no count */ } };
  const repo = new SessionRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });
  assert.equal(await repo.countActiveByUser({ userId: 'u1', now: new Date() }), null);
});

test('updateByToken: legacy-schema fallback drops fingerprint', async () => {
  let attempt = 0;
  const prisma = makePrismaSpy({
    updateImpl: (arg) => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('fingerprint column missing'));
      return Promise.resolve({ id: 's1', ...arg.data });
    },
  });
  const repo = new SessionRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });
  await repo.updateByToken('old', { newToken: 'new', expiresAt: new Date(0), fingerprint: 'fp2' });
  assert.equal(prisma._calls.update.length, 2);
  assert.equal(prisma._calls.update[1].data.fingerprint, undefined);
  assert.equal(prisma._calls.update[1].data.token, 'new');
});

test('routes calls through withRetry with stable labels', async () => {
  const prisma = makePrismaSpy();
  const labels = [];
  const repo = new SessionRepository({
    prisma,
    withRetry: (fn, opts) => { labels.push(opts?.label); return fn(); },
    logger: silentLogger,
  });
  await repo.create({ userId: 'u1', token: 't', expiresAt: new Date(0) });
  await repo.deleteByToken('t');
  await repo.updateByToken('t', { newToken: 't2', expiresAt: new Date(0) });
  assert.deepEqual(labels, [
    'session-repo.create',
    'session-repo.deleteByToken',
    'session-repo.updateByToken',
  ]);
});
