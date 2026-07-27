'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRawCreditPrisma } = require('./helpers/raw-credit-ledger-prisma');
const {
  completeFallbackReservation,
  failFallbackReservation,
  requestIdentity,
  reserveFallbackQuota,
  resolveFallbackDailyLimit,
} = require('../src/services/free-ia-fallback-quota');

const NOW = new Date('2026-07-10T12:00:00.000Z');

function input(prismaClient, overrides = {}) {
  return {
    prismaClient,
    userId: 'user-1',
    feature: 'paraphrase',
    amount: 3,
    idempotencyKey: 'fallback-idem-1',
    requestId: 'request-1',
    requestHash: 'fallback-body-hash-1',
    env: { FREE_IA_FALLBACK_DAILY_LIMIT: '2' },
    now: NOW,
    ...overrides,
  };
}

test('fallback limit is bounded and request identity never retains raw keys', () => {
  assert.equal(resolveFallbackDailyLimit({}), 10);
  assert.equal(resolveFallbackDailyLimit({ FREE_IA_FALLBACK_DAILY_LIMIT: '3' }), 3);
  assert.equal(resolveFallbackDailyLimit({ FREE_IA_FALLBACK_DAILY_LIMIT: '5000' }), 1000);
  const identity = requestIdentity(input({}, {
    idempotencyKey: 'raw-secret-client-key',
  }));
  assert.match(identity.idempotencyKeyHash, /^credit-idem:v1:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(identity).includes('raw-secret-client-key'), false);
});

test('reservation creates one zero-amount credit_transactions row with no delegates', async () => {
  const prismaClient = createRawCreditPrisma({ balances: { 'user-1': 0n } });
  const result = await reserveFallbackQuota(input(prismaClient));
  assert.equal(result.ok, true);
  assert.equal(result.winner, true);
  assert.equal(result.replay, false);
  assert.equal(result.txn.amount, 0n);
  assert.equal(result.txn.metadata.path, 'free_ia');
  assert.equal(result.reservation.transaction.id, result.txn.id);
  assert.equal(prismaClient._state.rows.length, 1);
  assert.equal(prismaClient._telemetry.rootRawCalls, 0);
});

test('completed fallback response replays without a second provider reservation', async () => {
  const prismaClient = createRawCreditPrisma({ balances: { 'user-1': 0n } });
  const first = await reserveFallbackQuota(input(prismaClient));
  await completeFallbackReservation({
    prismaClient,
    reservation: first.reservation,
    statusCode: 200,
    body: { output: 'cached fallback response' },
  });
  const replay = await reserveFallbackQuota(input(prismaClient));
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.winner, false);
  assert.deepEqual(replay.cachedResponse, {
    statusCode: 200,
    body: { output: 'cached fallback response' },
  });
  assert.equal(prismaClient._state.rows.length, 1);
});

test('failed fallback and identity mismatch have stable replay semantics', async () => {
  const prismaClient = createRawCreditPrisma({ balances: { 'user-1': 0n } });
  const first = await reserveFallbackQuota(input(prismaClient));
  await failFallbackReservation({
    prismaClient,
    reservation: first.reservation,
    code: 'UPSTREAM_503',
    statusCode: 502,
  });
  const failed = await reserveFallbackQuota(input(prismaClient));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'IDEMPOTENCY_FAILED');
  assert.equal(failed.retryable, true);

  const differentBody = await reserveFallbackQuota(input(prismaClient, {
    requestHash: 'different-body',
  }));
  assert.equal(differentBody.ok, false);
  assert.equal(differentBody.code, 'IDEMPOTENCY_CONFLICT');
});

test('fallback quota is enforced per user and UTC window', async () => {
  const prismaClient = createRawCreditPrisma({
    balances: { 'user-1': 0n, 'user-2': 0n },
  });
  for (let index = 1; index <= 2; index += 1) {
    const result = await reserveFallbackQuota(input(prismaClient, {
      idempotencyKey: `fallback-idem-${index}`,
      requestId: `request-${index}`,
      requestHash: `hash-${index}`,
    }));
    assert.equal(result.ok, true);
  }
  const exhausted = await reserveFallbackQuota(input(prismaClient, {
    idempotencyKey: 'fallback-idem-3',
    requestId: 'request-3',
    requestHash: 'hash-3',
  }));
  assert.deepEqual(exhausted, {
    ok: false,
    code: 'FALLBACK_QUOTA_EXCEEDED',
    limit: 2,
    used: 2,
  });

  const otherUser = await reserveFallbackQuota(input(prismaClient, {
    userId: 'user-2',
    idempotencyKey: 'fallback-idem-3',
    requestId: 'request-3',
    requestHash: 'hash-3',
  }));
  assert.equal(otherUser.ok, true);
});

test('concurrent same-key reservations produce one durable winner', async () => {
  const prismaClient = createRawCreditPrisma({ balances: { 'user-1': 0n } });
  const [first, second] = await Promise.all([
    reserveFallbackQuota(input(prismaClient)),
    reserveFallbackQuota(input(prismaClient)),
  ]);
  assert.equal([first, second].filter((entry) => entry.winner).length, 1);
  assert.equal(
    [first, second].filter((entry) => entry.code === 'IDEMPOTENCY_IN_PROGRESS').length,
    1,
  );
  assert.equal(prismaClient._state.rows.length, 1);
});

test('missing or failed raw storage fails quota enforcement closed', async () => {
  assert.deepEqual(await reserveFallbackQuota(input({})), {
    ok: false,
    code: 'FALLBACK_QUOTA_UNAVAILABLE',
    retryable: true,
  });
  assert.deepEqual(await reserveFallbackQuota(input({
    async $transaction() {
      throw new Error('database unavailable');
    },
  })), {
    ok: false,
    code: 'FALLBACK_QUOTA_UNAVAILABLE',
    retryable: true,
  });
});
