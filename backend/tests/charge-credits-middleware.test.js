'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const { createRawCreditPrisma } = require('./helpers/raw-credit-ledger-prisma');

const fakePrisma = createRawCreditPrisma({ balances: { u1: 100n } });
let cerebrasEnabled = false;
const originalRequire = Module.prototype.require;
Module.prototype.require = function requireWithStubs(specifier) {
  if (specifier === '../config/database') return fakePrisma;
  if (specifier === '../services/ai/cerebras-client') {
    return {
      getCerebrasConfig: () => ({
        enabled: cerebrasEnabled,
        provider: 'Cerebras',
        model: 'free-model',
        displayName: 'Free IA',
        reason: cerebrasEnabled ? 'ok' : 'no_api_key',
        apiKey: cerebrasEnabled ? 'never-leak' : '',
        baseURL: 'https://internal.invalid/v1',
      }),
      buildFreeIaModelDescriptor: () => ({
        provider: 'Cerebras',
        name: 'free-model',
      }),
    };
  }
  return originalRequire.apply(this, arguments);
};

const chargeCredits = require('../src/middleware/charge-credits');
Module.prototype.require = originalRequire;

const {
  pickIdempotencyKey,
  refundLastCharge,
  resolveCost,
  spendCredits,
} = chargeCredits;

test.beforeEach(() => {
  fakePrisma.reset();
  cerebrasEnabled = false;
});

function context({
  user = { id: 'u1' },
  body = { text: 'hello world' },
  idempotencyKey = 'middleware-key',
} = {}) {
  let statusCode = 200;
  let responseBody;
  let nextCalls = 0;
  const req = {
    id: 'middleware-request',
    user,
    body,
    get(name) {
      return String(name).toLowerCase() === 'idempotency-key'
        ? idempotencyKey
        : undefined;
    },
  };
  const res = {
    headersSent: false,
    status(code) { statusCode = code; return this; },
    json(bodyValue) { responseBody = bodyValue; return this; },
    setHeader() {},
  };
  return {
    req,
    res,
    next() { nextCalls += 1; },
    snapshot() { return { statusCode, responseBody, nextCalls }; },
  };
}

test('resolveCost rounds positive fractional values up and rejects invalid costs', () => {
  assert.equal(resolveCost(5, {}), 5);
  assert.equal(resolveCost('12', {}), 12);
  assert.equal(resolveCost(() => 1.01, {}), 2);
  for (const value of [0, -1, NaN, Infinity, 'invalid']) {
    assert.equal(resolveCost(value, {}), 0);
  }
});

test('pickIdempotencyKey prefers header and falls back to body', () => {
  assert.equal(pickIdempotencyKey({
    get: () => 'header-key',
    body: { idempotencyKey: 'body-key' },
  }), 'header-key');
  assert.equal(pickIdempotencyKey({
    get: () => undefined,
    body: { idempotencyKey: 'body-key' },
  }), 'body-key');
});

test('middleware requires a feature and authenticated user', async () => {
  assert.throws(() => chargeCredits({}), /feature.*required/i);
  const ctx = context({ user: null });
  await chargeCredits({ feature: 'paraphrase', cost: 1 })(
    ctx.req,
    ctx.res,
    ctx.next,
  );
  assert.equal(ctx.snapshot().statusCode, 401);
  assert.equal(ctx.snapshot().nextCalls, 0);
});

test('zero cost bypasses the ledger while positive cost reserves paid row', async () => {
  const free = context();
  await chargeCredits({ feature: 'free-preview', cost: 0 })(
    free.req,
    free.res,
    free.next,
  );
  assert.equal(free.snapshot().nextCalls, 1);
  assert.equal(fakePrisma._state.rows.length, 0);

  const paid = context({ idempotencyKey: 'paid-key' });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    paid.req,
    paid.res,
    paid.next,
  );
  assert.equal(paid.snapshot().nextCalls, 1);
  assert.equal(fakePrisma._state.credits.get('u1').balance, 95n);
  assert.equal(paid.req._chargedCredits.txn.metadata.path, 'paid');
});

test('fallback defaults off and opted-out routes retain 402', async () => {
  cerebrasEnabled = true;
  fakePrisma.setBalance('u1', 0n);
  const defaultCtx = context();
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    defaultCtx.req,
    defaultCtx.res,
    defaultCtx.next,
  );
  assert.equal(defaultCtx.snapshot().statusCode, 402);
  assert.equal(defaultCtx.req._fallbackToFreeIA, undefined);

  const imageCtx = context({ idempotencyKey: 'image-key' });
  await chargeCredits({
    feature: 'image_generation',
    cost: 5,
    allowFreeIaFallback: false,
  })(imageCtx.req, imageCtx.res, imageCtx.next);
  assert.equal(imageCtx.snapshot().statusCode, 402);
  assert.equal(imageCtx.req._fallbackToFreeIA, undefined);
  assert.equal(fakePrisma._state.rows.length, 0);
});

test('opted-in configured fallback attaches a durable zero row without secrets', async () => {
  cerebrasEnabled = true;
  fakePrisma.setBalance('u1', 0n);
  const ctx = context({ idempotencyKey: 'fallback-key' });
  await chargeCredits({
    feature: 'paraphrase',
    cost: 5,
    allowFreeIaFallback: true,
  })(ctx.req, ctx.res, ctx.next);
  assert.equal(ctx.snapshot().nextCalls, 1);
  assert.equal(ctx.req._fallbackToFreeIA.config.apiKey, undefined);
  assert.equal(ctx.req._fallbackToFreeIA.config.baseURL, undefined);
  assert.equal(ctx.req._chargedCredits.txn.amount, 0n);
  assert.equal(ctx.req._chargedCredits.fallback, 'free_ia');
  assert.equal(ctx.req._chargedCredits.durableWinner, true);
});

test('spendCredits and strict refundLastCharge complete an atomic round trip', async () => {
  const spend = await spendCredits({
    prismaClient: fakePrisma,
    userId: 'u1',
    amount: 7,
    feature: 'paraphrase',
    idempotencyKey: 'round-trip-key',
    requestHash: 'round-trip-hash',
  });
  assert.equal(spend.ok, true);
  assert.equal(fakePrisma._state.credits.get('u1').balance, 93n);
  const req = {
    _chargedCredits: {
      feature: 'paraphrase',
      replay: false,
      txn: spend.txn,
    },
  };
  const refund = await refundLastCharge(req, 'engine_error', {
    strict: true,
    prismaClient: fakePrisma,
  });
  assert.equal(refund.ok, true);
  assert.equal(fakePrisma._state.credits.get('u1').balance, 100n);
  assert.equal(req._refundedCredits.txn.id, refund.txn.id);
});

test('fallback and replay charges are never refunded', async () => {
  assert.equal(await refundLastCharge({
    _chargedCredits: {
      fallback: 'free_ia',
      txn: { id: 'zero-row' },
      replay: false,
    },
  }), null);
  assert.equal(await refundLastCharge({
    _chargedCredits: {
      txn: { id: 'paid-row' },
      replay: true,
    },
  }), null);
});
