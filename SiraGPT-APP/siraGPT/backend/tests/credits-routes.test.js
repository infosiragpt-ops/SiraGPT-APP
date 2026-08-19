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
