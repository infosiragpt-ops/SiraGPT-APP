'use strict';

// F2 PR8 — Unit tests for chargeCredits middleware. Mocks Prisma so
// the SQL path is exercised without a live DB. Verifies:
//   * resolveCost handles function/number/string
//   * pickIdempotencyKey reads header before body
//   * factory validates `feature` is present
//   * middleware skips when amount=0
//   * middleware 401s on missing auth
//   * middleware 402s on insufficient balance
//   * spendCredits + refundCharge happy paths

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const origRequire = Module.prototype.require;
const txnRows = new Map();
let balance = 100n;
let lifetimeSpent = 0n;

const stubs = new Map();
stubs.set('../config/database', {
  creditTransaction: {
    async findUnique({ where }) {
      return txnRows.get(where.idempotencyKey) || null;
    },
    async create({ data }) {
      const row = {
        id: `tx_${txnRows.size + 1}`,
        createdAt: new Date(),
        ...data,
      };
      if (data.idempotencyKey) txnRows.set(data.idempotencyKey, row);
      return row;
    },
  },
  credit: {
    async findUnique() {
      return { userId: 'u1', balance, lifetimeSpent };
    },
    async update({ data }) {
      if (data.balance?.increment) balance += BigInt(data.balance.increment);
      if (data.lifetimeSpent?.decrement) lifetimeSpent -= BigInt(data.lifetimeSpent.decrement);
      return { userId: 'u1', balance, lifetimeSpent };
    },
  },
  async $executeRawUnsafe(_sql, amt, _userId) {
    const a = BigInt(amt);
    if (balance < a) return 0;
    balance -= a;
    lifetimeSpent += a;
    return 1;
  },
});

Module.prototype.require = function (spec) {
  if (stubs.has(spec)) return stubs.get(spec);
  return origRequire.apply(this, arguments);
};

const chargeCredits = require('../src/middleware/charge-credits');
const {
  spendCredits,
  refundCharge,
  refundLastCharge,
  resolveCost,
  pickIdempotencyKey,
} = chargeCredits;

Module.prototype.require = origRequire;

function makeReqRes({ user = { id: 'u1' }, body = {}, headers = {} } = {}) {
  let statusCode = 200;
  let jsonBody = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { jsonBody = payload; resolveDone('json'); return this; },
    get statusCode() { return statusCode; },
    get jsonBody() { return jsonBody; },
  };
  return {
    req: {
      user,
      body,
      get(name) { return headers[name.toLowerCase()]; },
    },
    res,
    done, // resolves on res.json(...) OR when the test calls resolveDone('next')
    nextHook: (cb) => (...args) => { cb && cb(...args); resolveDone('next'); },
  };
}

test('resolveCost: function, number, numeric-string', () => {
  assert.equal(resolveCost(5, {}), 5);
  assert.equal(resolveCost('12', {}), 12);
  assert.equal(resolveCost((req) => req.body.text.length, { body: { text: 'abc' } }), 3);
  assert.equal(resolveCost('not-a-number', {}), 0);
});

test('pickIdempotencyKey: prefers header over body', () => {
  const req = {
    get: (n) => (n.toLowerCase() === 'idempotency-key' ? 'from-header' : undefined),
    body: { idempotencyKey: 'from-body' },
  };
  assert.equal(pickIdempotencyKey(req), 'from-header');
});

test('pickIdempotencyKey: falls back to body field', () => {
  const req = { get: () => undefined, body: { idempotencyKey: 'from-body' } };
  assert.equal(pickIdempotencyKey(req), 'from-body');
});

test('chargeCredits: factory requires { feature }', () => {
  assert.throws(() => chargeCredits({}), /feature.*required/i);
  assert.equal(typeof chargeCredits({ feature: 'x' }), 'function');
});

test('chargeCredits: 401 when no req.user', async () => {
  const ctx = makeReqRes({ user: null });
  chargeCredits({ feature: 'paraphrase', cost: 1 })(ctx.req, ctx.res, ctx.nextHook());
  await ctx.done;
  assert.equal(ctx.res.statusCode, 401);
});

test('chargeCredits: skips charge when cost=0 (calls next without status)', async () => {
  balance = 100n;
  let nextCalled = false;
  const ctx = makeReqRes();
  chargeCredits({ feature: 'free-feature', cost: 0 })(ctx.req, ctx.res, ctx.nextHook(() => { nextCalled = true; }));
  await ctx.done;
  assert.equal(nextCalled, true);
  assert.equal(balance, 100n, 'balance must be unchanged when cost is 0');
});

test('chargeCredits: spends and attaches req._chargedCredits on success', async () => {
  balance = 100n;
  const ctx = makeReqRes({ body: { text: 'hello world' } });
  chargeCredits({ feature: 'paraphrase', cost: 5 })(ctx.req, ctx.res, ctx.nextHook());
  await ctx.done;
  assert.equal(balance, 95n);
  assert.ok(ctx.req._chargedCredits);
  assert.equal(ctx.req._chargedCredits.amount, 5);
  assert.equal(ctx.req._chargedCredits.feature, 'paraphrase');
  assert.ok(ctx.req._chargedCredits.txn);
});

test('chargeCredits: 402 INSUFFICIENT when balance < cost', async () => {
  balance = 3n;
  const ctx = makeReqRes();
  chargeCredits({ feature: 'paraphrase', cost: 5 })(ctx.req, ctx.res, ctx.nextHook());
  await ctx.done;
  assert.equal(ctx.res.statusCode, 402);
  assert.equal(ctx.res.jsonBody.error, 'insufficient credits');
  assert.equal(ctx.res.jsonBody.feature, 'paraphrase');
});

test('refundLastCharge: returns null when no charge recorded', async () => {
  const req = { _chargedCredits: undefined };
  const result = await refundLastCharge(req, 'test');
  assert.equal(result, null);
});

test('refundLastCharge: returns null on idempotent replays (do not double-refund)', async () => {
  const req = { _chargedCredits: { replay: true, txn: { id: 'tx', amount: -5n, userId: 'u1' } } };
  const result = await refundLastCharge(req, 'test');
  assert.equal(result, null);
});

test('spendCredits + refundCharge: round trip leaves balance unchanged', async () => {
  balance = 100n;
  lifetimeSpent = 0n;
  const spend = await spendCredits({ userId: 'u1', amount: 7, feature: 'paraphrase' });
  assert.equal(spend.ok, true);
  assert.equal(balance, 93n);
  await refundCharge({ originalTxn: spend.txn, reason: 'engine_error' });
  assert.equal(balance, 100n, 'balance restored after refund');
});
