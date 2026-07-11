'use strict';

// F2 PR7 — Unit tests for the credits router. Verifies Zod schemas,
// serializers (BigInt → string transport), and router shape without
// requiring a live Prisma client.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const origRequire = Module.prototype.require;
const stubs = new Map();
stubs.set('../middleware/auth', {
  authenticateToken: (_req, _res, next) => next(),
  optionalAuth: (_req, _res, next) => next(),
});
stubs.set('../config/database', {
  credit: { async findUnique() { return null; }, async create({ data }) { return data; }, async update({ data }) { return data; } },
  creditTransaction: { async findUnique() { return null; }, async findMany() { return []; }, async create({ data }) { return data; } },
  async $executeRawUnsafe() { return 1; },
});

Module.prototype.require = function (spec) {
  if (stubs.has(spec)) return stubs.get(spec);
  return origRequire.apply(this, arguments);
};

const credits = require('../src/routes/credits');
const {
  adminRouter,
  atomicGrant,
  atomicSpend,
  ensureCreditRow,
  getCreditRow,
  persistWriteResponse,
  SpendSchema,
  GrantSchema,
  RefundSchema,
  serializeCredits,
  serializeTransaction,
} = credits;

Module.prototype.require = origRequire;

test('credits routers: default export is the user-facing Router', () => {
  assert.equal(typeof credits, 'function');
  const methods = new Set();
  for (const layer of credits.stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) methods.add(m);
  }
  assert.ok(methods.has('get'), 'missing GET handler (me / me/transactions)');
  assert.ok(methods.has('post'), 'missing POST handler (spend)');
});

test('credits routers: adminRouter exposes grant/refund/users:userId', () => {
  const paths = new Set();
  for (const layer of adminRouter.stack) {
    if (!layer.route) continue;
    paths.add(layer.route.path);
  }
  assert.ok(paths.has('/grant'), 'admin /grant missing');
  assert.ok(paths.has('/refund'), 'admin /refund missing');
  assert.ok(paths.has('/users/:userId'), 'admin /users/:userId missing');
});

test('SpendSchema: accepts positive number + numeric string', () => {
  assert.equal(
    SpendSchema.safeParse({ userId: 'u1', amount: 10, feature: 'paraphrase' }).success,
    true,
  );
  assert.equal(
    SpendSchema.safeParse({ userId: 'u1', amount: '500', feature: 'image_gen' }).success,
    true,
  );
});

test('SpendSchema: rejects zero, negative, and decimal amounts', () => {
  assert.equal(
    SpendSchema.safeParse({ userId: 'u1', amount: 0, feature: 'x' }).success,
    false,
  );
  assert.equal(
    SpendSchema.safeParse({ userId: 'u1', amount: -5, feature: 'x' }).success,
    false,
  );
  assert.equal(
    SpendSchema.safeParse({ userId: 'u1', amount: 1.5, feature: 'x' }).success,
    false,
  );
});

test('GrantSchema: requires a reason', () => {
  assert.equal(
    GrantSchema.safeParse({ userId: 'u1', amount: 100 }).success,
    false,
  );
  assert.equal(
    GrantSchema.safeParse({ userId: 'u1', amount: 100, reason: 'promo Q3' }).success,
    true,
  );
});

test('RefundSchema: allows amount OR transactionId (handler decides)', () => {
  assert.equal(
    RefundSchema.safeParse({ userId: 'u1', reason: 'wrong charge' }).success,
    true,
  );
});

test('serializeCredits: BigInt fields become strings (safe JSON transport)', () => {
  const out = serializeCredits({
    userId: 'u1',
    orgId: null,
    balance: BigInt('1500'),
    reservedBalance: BigInt(0),
    lifetimeGranted: BigInt('2000'),
    lifetimeSpent: BigInt('500'),
    lastRefillAt: null,
    nextRefillAt: null,
    updatedAt: new Date(),
  });
  assert.equal(out.balance, '1500');
  assert.equal(out.reservedBalance, '0');
  assert.equal(out.lifetimeGranted, '2000');
  assert.equal(out.lifetimeSpent, '500');
});

test('serializeCredits: null row returns null', () => {
  assert.equal(serializeCredits(null), null);
});

test('serializeTransaction: BigInt amount + balanceAfter become strings', () => {
  const out = serializeTransaction({
    id: 'tx1',
    userId: 'u1',
    orgId: null,
    type: 'SPEND',
    amount: BigInt('-10'),
    balanceAfter: BigInt('490'),
    reason: 'paraphrase',
    metadata: { feature: 'paraphrase' },
    idempotencyKey: 'key-123',
    createdAt: new Date(),
  });
  assert.equal(out.amount, '-10');
  assert.equal(out.balanceAfter, '490');
  assert.equal(out.metadata.feature, 'paraphrase');
});

test('credits route helpers operate on the raw-SQL surface without Prisma delegates', async () => {
  const { createRawCreditPrisma } = require('./helpers/raw-credit-ledger-prisma');
  const prismaClient = createRawCreditPrisma({ balances: { u1: 20n } });
  assert.equal(typeof ensureCreditRow, 'function');
  assert.equal(typeof getCreditRow, 'function');
  assert.equal(typeof atomicSpend, 'function');
  assert.equal(typeof atomicGrant, 'function');

  const before = await getCreditRow('u1', prismaClient);
  assert.equal(before.balance, 20n);
  const spend = await atomicSpend({
    prismaClient,
    userId: 'u1',
    amount: 5,
    feature: 'paraphrase',
    idempotencyKey: 'route-spend-key',
    requestHash: 'route-spend-hash',
  });
  assert.equal(spend.ok, true);
  assert.equal(spend.txn.balanceAfter, 15n);

  const grant = await atomicGrant({
    prismaClient,
    userId: 'u1',
    amount: 7,
    type: 'ADMIN_ADJUSTMENT',
    reason: 'test grant',
    idempotencyKey: 'route-grant-key',
    requestHash: 'route-grant-hash',
  });
  assert.equal(grant.ok, true);
  assert.equal(grant.txn.balanceAfter, 22n);
  assert.equal(prismaClient._telemetry.rootRawCalls, 0);
});

test('ensureCreditRow safely creates a missing raw-table balance row', async () => {
  const { createRawCreditPrisma } = require('./helpers/raw-credit-ledger-prisma');
  const prismaClient = createRawCreditPrisma({ balances: {} });
  const row = await ensureCreditRow('new-user', prismaClient);
  assert.equal(row.userId, 'new-user');
  assert.equal(row.balance, 0n);
  assert.equal(row.lifetimeGranted, 0n);
  assert.equal(row.lifetimeSpent, 0n);
});

test('recovered spend and grant claims persist completion without repeating balance changes', async () => {
  const { createRawCreditPrisma } = require('./helpers/raw-credit-ledger-prisma');
  const prismaClient = createRawCreditPrisma({ balances: { u1: 20n } });

  const spendInput = {
    prismaClient,
    userId: 'u1',
    amount: 5,
    feature: 'paraphrase',
    idempotencyKey: 'recovered-spend-key',
    requestHash: 'recovered-spend-hash',
  };
  await atomicSpend(spendInput);
  prismaClient._state.rows[0].metadata.idempotency.leaseUntil = '2000-01-01T00:00:00.000Z';
  const recoveredSpend = await atomicSpend(spendInput);
  assert.equal(recoveredSpend.winner, false);
  assert.equal(recoveredSpend.ownsLease, true);
  await persistWriteResponse(
    recoveredSpend,
    201,
    { transaction: { id: recoveredSpend.txn.id }, replay: false },
    prismaClient,
  );
  const spendReplay = await atomicSpend(spendInput);
  assert.equal(spendReplay.replay, true);
  assert.equal(prismaClient._state.credits.get('u1').balance, 15n);

  const grantInput = {
    prismaClient,
    userId: 'u1',
    amount: 7,
    type: 'ADMIN_ADJUSTMENT',
    reason: 'recovered grant',
    idempotencyKey: 'recovered-grant-key',
    requestHash: 'recovered-grant-hash',
  };
  await atomicGrant(grantInput);
  const grantRow = prismaClient._state.rows.find(
    (row) => row.metadata.feature === 'credits:admin_adjustment',
  );
  grantRow.metadata.idempotency.leaseUntil = '2000-01-01T00:00:00.000Z';
  const recoveredGrant = await atomicGrant(grantInput);
  assert.equal(recoveredGrant.winner, false);
  assert.equal(recoveredGrant.ownsLease, true);
  await persistWriteResponse(
    recoveredGrant,
    201,
    { transaction: { id: recoveredGrant.txn.id }, replay: false },
    prismaClient,
  );
  const grantReplay = await atomicGrant(grantInput);
  assert.equal(grantReplay.replay, true);
  assert.equal(prismaClient._state.credits.get('u1').balance, 22n);
});
