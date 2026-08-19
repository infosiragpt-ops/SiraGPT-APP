'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PartialSessionRepository } = require('../src/repositories/PartialSessionRepository');

function makePrismaSpy() {
  const calls = { create: [], findUnique: [], updateMany: [], count: [], deleteMany: [] };
  return {
    _calls: calls,
    partialSession: {
      async create(args)     { calls.create.push(args);     return { id: 'p1', ...args.data }; },
      async findUnique(args) { calls.findUnique.push(args); return { id: 'p1', token: args.where.token }; },
      async updateMany(args) { calls.updateMany.push(args); return { count: 1 }; },
      async count(args)      { calls.count.push(args);      return 7; },
      async deleteMany(args) { calls.deleteMany.push(args); return { count: 3 }; },
    },
  };
}
const passthroughRetry = (fn) => fn();

test('PartialSessionRepository: constructor validates deps', () => {
  assert.throws(() => new PartialSessionRepository({ withRetry: passthroughRetry }), /prisma is required/);
  assert.throws(() => new PartialSessionRepository({ prisma: {} }), /withRetry must be a function/);
});

test('PartialSessionRepository.create: writes token/userId/expiresAt', async () => {
  const prisma = makePrismaSpy();
  const repo = new PartialSessionRepository({ prisma, withRetry: passthroughRetry });
  const exp = new Date('2026-06-01T00:00:00Z');
  await repo.create({ token: 'abc', userId: 'u1', expiresAt: exp });
  assert.deepEqual(prisma._calls.create[0], { data: { token: 'abc', userId: 'u1', expiresAt: exp } });
});

test('PartialSessionRepository.create: serializes active-user check and partial issuance', async () => {
  const calls = [];
  const tx = {
    async $queryRawUnsafe(sql) {
      calls.push(/pg_advisory_xact_lock/i.test(sql) ? 'lock' : 'timeout');
      return [{ locked: true }];
    },
    user: {
      async findUnique() {
        calls.push('user.read');
        return { id: 'u1', deletedAt: null };
      },
    },
    partialSession: {
      async create({ data }) {
        calls.push('partial.create');
        return { id: 'p1', ...data };
      },
    },
  };
  const prisma = {
    user: { findUnique() {} },
    partialSession: { create() {} },
    async $queryRawUnsafe() {},
    async $transaction(callback) {
      const result = await callback(tx);
      calls.push('transaction.commit');
      return result;
    },
  };
  const repo = new PartialSessionRepository({ prisma, withRetry: passthroughRetry });

  await repo.create({ token: 'abc', userId: 'u1', expiresAt: new Date(0) });

  assert.ok(calls.indexOf('lock') < calls.indexOf('user.read'));
  assert.ok(calls.indexOf('user.read') < calls.indexOf('partial.create'));
  assert.ok(calls.indexOf('partial.create') < calls.indexOf('transaction.commit'));
});

test('PartialSessionRepository.findByToken: forwards token in where', async () => {
  const prisma = makePrismaSpy();
  const repo = new PartialSessionRepository({ prisma, withRetry: passthroughRetry });
  const row = await repo.findByToken('abc');
  assert.deepEqual(prisma._calls.findUnique[0], { where: { token: 'abc' } });
  assert.equal(row.token, 'abc');
});

test('PartialSessionRepository.consumeByToken: atomic predicate + returns BatchPayload', async () => {
  const prisma = makePrismaSpy();
  const repo = new PartialSessionRepository({ prisma, withRetry: passthroughRetry });
  const fixedNow = new Date('2026-06-01T00:00:00Z');
  const res = await repo.consumeByToken('abc', { now: fixedNow });
  assert.deepEqual(prisma._calls.updateMany[0], {
    where: { token: 'abc', consumedAt: null },
    data: { consumedAt: fixedNow },
  });
  assert.equal(res.count, 1);
});

test('PartialSessionRepository.count + deleteMany: forward where unchanged', async () => {
  const prisma = makePrismaSpy();
  const repo = new PartialSessionRepository({ prisma, withRetry: passthroughRetry });
  const where = { expiresAt: { lt: new Date() } };
  assert.equal(await repo.count(where), 7);
  const res = await repo.deleteMany(where);
  assert.equal(res.count, 3);
  assert.deepEqual(prisma._calls.count[0], { where });
  assert.deepEqual(prisma._calls.deleteMany[0], { where });
});

test('PartialSessionRepository: every method routes through withRetry with stable labels', async () => {
  const prisma = makePrismaSpy();
  const labels = [];
  const repo = new PartialSessionRepository({
    prisma,
    withRetry: (fn, opts) => { labels.push(opts?.label); return fn(); },
  });
  await repo.create({ token: 't', userId: 'u', expiresAt: new Date() });
  await repo.findByToken('t');
  await repo.consumeByToken('t');
  await repo.count({});
  await repo.deleteMany({});
  assert.deepEqual(labels, [
    'partial-session-repo.create',
    'partial-session-repo.findByToken',
    'partial-session-repo.consumeByToken',
    'partial-session-repo.count',
    'partial-session-repo.deleteMany',
  ]);
});
