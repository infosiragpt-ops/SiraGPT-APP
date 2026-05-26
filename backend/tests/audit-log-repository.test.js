'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuditLogRepository } = require('../src/repositories/AuditLogRepository');

const silentLogger = { warn: () => {}, error: () => {}, log: () => {} };
const passthroughRetry = (fn) => fn();

function makePrismaSpy({ throwOnCreate = false, throwOnFind = false } = {}) {
  const calls = { create: [], findMany: [] };
  return {
    _calls: calls,
    auditLog: {
      async create(args)   {
        calls.create.push(args);
        if (throwOnCreate) throw new Error('db down');
        return { id: 'a1', ...args.data };
      },
      async findMany(args) {
        calls.findMany.push(args);
        if (throwOnFind) throw new Error('db down');
        return [{ id: 'a1', createdAt: new Date(), metadata: { ip: '1.2.3.4' } }];
      },
    },
  };
}

test('AuditLogRepository: constructor validates deps', () => {
  assert.throws(() => new AuditLogRepository({ withRetry: passthroughRetry }), /prisma is required/);
  assert.throws(() => new AuditLogRepository({ prisma: {} }), /withRetry must be a function/);
});

test('AuditLogRepository.safeCreate: returns null when auditLog model absent', async () => {
  const repo = new AuditLogRepository({ prisma: {}, withRetry: passthroughRetry, logger: silentLogger });
  const r = await repo.safeCreate({ action: 'login' });
  assert.equal(r, null);
});

test('AuditLogRepository.safeCreate: persists and returns row on success', async () => {
  const prisma = makePrismaSpy();
  const repo = new AuditLogRepository({ prisma, withRetry: passthroughRetry });
  const row = await repo.safeCreate({ action: 'login', actorType: 'user', resourceType: 'user' });
  assert.equal(row.id, 'a1');
  assert.equal(row.action, 'login');
  assert.deepEqual(prisma._calls.create[0].data.action, 'login');
});

test('AuditLogRepository.safeCreate: swallows errors and returns null', async () => {
  const prisma = makePrismaSpy({ throwOnCreate: true });
  let errLogged = false;
  const repo = new AuditLogRepository({
    prisma,
    withRetry: passthroughRetry,
    logger: { error: (m) => { if (String(m).includes('[AUDIT]')) errLogged = true; } },
  });
  const r = await repo.safeCreate({ action: 'login' });
  assert.equal(r, null);
  assert.equal(errLogged, true);
});

test('AuditLogRepository.findRecentForActor: returns [] when model absent', async () => {
  const repo = new AuditLogRepository({ prisma: {}, withRetry: passthroughRetry });
  assert.deepEqual(await repo.findRecentForActor({ actorId: 'u1' }), []);
});

test('AuditLogRepository.findRecentForActor: forwards where/orderBy/take/select', async () => {
  const prisma = makePrismaSpy();
  const repo = new AuditLogRepository({ prisma, withRetry: passthroughRetry });
  const rows = await repo.findRecentForActor({
    actorId: 'u1',
    actions: ['login', 'register'],
    take: 25,
    select: { createdAt: true, metadata: true },
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(prisma._calls.findMany[0], {
    where: { actorId: 'u1', action: { in: ['login', 'register'] } },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: { createdAt: true, metadata: true },
  });
});

test('AuditLogRepository.findRecentForActor: omits action filter when not supplied, swallows errors', async () => {
  const prisma = makePrismaSpy({ throwOnFind: true });
  const repo = new AuditLogRepository({ prisma, withRetry: passthroughRetry, logger: silentLogger });
  const rows = await repo.findRecentForActor({ actorId: 'u1' });
  assert.deepEqual(rows, []);
});

test('AuditLogRepository: routes through withRetry with stable labels', async () => {
  const prisma = makePrismaSpy();
  const labels = [];
  const repo = new AuditLogRepository({
    prisma,
    withRetry: (fn, opts) => { labels.push(opts?.label); return fn(); },
  });
  await repo.safeCreate({ action: 'login' });
  await repo.findRecentForActor({ actorId: 'u1', actions: ['login'] });
  assert.deepEqual(labels, [
    'audit-log-repo.safeCreate',
    'audit-log-repo.findRecentForActor',
  ]);
});
