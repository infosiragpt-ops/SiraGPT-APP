'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const { createRawCreditPrisma } = require('./helpers/raw-credit-ledger-prisma');
const {
  completeLedgerTransactionWithoutResponse,
} = require('../src/services/credit-ledger');

const fakePrisma = createRawCreditPrisma({ balances: { u1: 100n, u2: 100n } });
let cerebrasEnabled = false;
const originalRequire = Module.prototype.require;
Module.prototype.require = function requireWithCreditStubs(specifier) {
  if (specifier === '../config/database') return fakePrisma;
  if (specifier === '../services/ai/cerebras-client') {
    return {
      getCerebrasConfig: () => ({
        enabled: cerebrasEnabled,
        apiKey: cerebrasEnabled ? 'must-never-leak' : '',
        baseURL: 'https://internal.example/v1',
        provider: 'Cerebras',
        model: 'free-test-model',
        displayName: 'Free IA',
        reason: cerebrasEnabled ? 'ok' : 'no_api_key',
      }),
      buildFreeIaModelDescriptor: () => ({
        provider: 'Cerebras',
        name: 'free-test-model',
      }),
    };
  }
  return originalRequire.apply(this, arguments);
};

const chargeCredits = require('../src/middleware/charge-credits');
Module.prototype.require = originalRequire;

const {
  cacheIdempotentResponse,
  deriveRequestHash,
  deriveRequestFingerprint,
  failIdempotentOperation,
  refundCharge,
  spendCredits,
  startIdempotencyLeaseHeartbeat,
} = chargeCredits;

test.beforeEach(() => {
  fakePrisma.reset();
  cerebrasEnabled = false;
});

function middlewareContext({
  userId = 'u1',
  body = { text: 'rewrite me', language: 'en' },
  idempotencyKey = 'client-key',
  method = 'POST',
  baseUrl = '/api/paraphrase',
  routePath = '/',
  path = '/',
  params = {},
  query = {},
} = {}) {
  let statusCode = 200;
  let responseBody;
  let nextCalls = 0;
  const headers = {};
  const req = {
    id: `request-${userId}`,
    method,
    baseUrl,
    route: { path: routePath },
    path,
    params,
    query,
    user: { id: userId },
    body,
    get(name) {
      return String(name).toLowerCase() === 'idempotency-key'
        ? idempotencyKey
        : undefined;
    },
  };
  const res = {
    headersSent: false,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = String(value);
    },
    status(value) {
      statusCode = value;
      return this;
    },
    json(value) {
      responseBody = value;
      return this;
    },
  };
  return {
    req,
    res,
    next() { nextCalls += 1; },
    snapshot() {
      return { statusCode, responseBody, nextCalls, headers };
    },
  };
}

test('deriveRequestHash is canonical and excludes the top-level idempotency key', () => {
  const first = deriveRequestHash({
    text: 'same',
    language: 'es',
    nested: { idempotencyKey: 'content', keep: true },
    idempotencyKey: 'one',
  });
  const second = deriveRequestHash({
    nested: { keep: true, idempotencyKey: 'content' },
    idempotencyKey: 'two',
    language: 'es',
    text: 'same',
  });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
});

test('request fingerprint includes method, route params, query, and body', () => {
  const base = {
    method: 'POST',
    baseUrl: '/api/images',
    route: { path: '/:id/variations' },
    path: '/parent-a/variations',
    params: { id: 'parent-a' },
    query: { style: 'natural' },
    body: { n: 2, idempotencyKey: 'one' },
  };
  const same = deriveRequestFingerprint({
    ...base,
    body: { idempotencyKey: 'two', n: 2 },
  });
  assert.equal(deriveRequestFingerprint(base), same);
  assert.notEqual(
    same,
    deriveRequestFingerprint({ ...base, params: { id: 'parent-b' } }),
  );
  assert.notEqual(
    same,
    deriveRequestFingerprint({ ...base, query: { style: 'vivid' } }),
  );
  assert.notEqual(
    same,
    deriveRequestFingerprint({ ...base, method: 'PUT' }),
  );
  assert.notEqual(
    same,
    deriveRequestFingerprint({
      ...base,
      route: { path: '/:id/upscale' },
      path: '/parent-a/upscale',
    }),
  );
});

test('same idempotency key conflicts across route params and behavior query', async () => {
  const first = middlewareContext({
    idempotencyKey: 'route-fingerprint-key',
    baseUrl: '/api/images',
    routePath: '/:id/variations',
    path: '/parent-a/variations',
    params: { id: 'parent-a' },
    query: { style: 'natural' },
    body: { n: 1 },
  });
  await chargeCredits({ feature: 'image_variation', cost: 5 })(
    first.req,
    first.res,
    first.next,
  );
  assert.equal(first.snapshot().nextCalls, 1);

  const otherParent = middlewareContext({
    idempotencyKey: 'route-fingerprint-key',
    baseUrl: '/api/images',
    routePath: '/:id/variations',
    path: '/parent-b/variations',
    params: { id: 'parent-b' },
    query: { style: 'natural' },
    body: { n: 1 },
  });
  await chargeCredits({ feature: 'image_variation', cost: 5 })(
    otherParent.req,
    otherParent.res,
    otherParent.next,
  );
  assert.equal(otherParent.snapshot().statusCode, 409);
  assert.equal(otherParent.snapshot().responseBody.code, 'IDEMPOTENCY_CONFLICT');

  const otherQuery = middlewareContext({
    idempotencyKey: 'route-fingerprint-key',
    baseUrl: '/api/images',
    routePath: '/:id/variations',
    path: '/parent-a/variations',
    params: { id: 'parent-a' },
    query: { style: 'vivid' },
    body: { n: 1 },
  });
  await chargeCredits({ feature: 'image_variation', cost: 5 })(
    otherQuery.req,
    otherQuery.res,
    otherQuery.next,
  );
  assert.equal(otherQuery.snapshot().statusCode, 409);
  assert.equal(otherQuery.snapshot().responseBody.code, 'IDEMPOTENCY_CONFLICT');

  const otherRoute = middlewareContext({
    idempotencyKey: 'route-fingerprint-key',
    baseUrl: '/api/images',
    routePath: '/:id/upscale',
    path: '/parent-a/upscale',
    params: { id: 'parent-a' },
    query: { style: 'natural' },
    body: { n: 1 },
  });
  await chargeCredits({ feature: 'image_variation', cost: 5 })(
    otherRoute.req,
    otherRoute.res,
    otherRoute.next,
  );
  assert.equal(otherRoute.snapshot().statusCode, 409);
  assert.equal(otherRoute.snapshot().responseBody.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(fakePrisma._state.credits.get('u1').balance, 95n);
});

test('paid charge, response completion, and replay never rerun downstream work', async () => {
  const body = { text: 'same request', language: 'es' };
  const first = middlewareContext({ body, idempotencyKey: 'paid-key' });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    first.req,
    first.res,
    first.next,
  );
  assert.equal(first.snapshot().nextCalls, 1);
  assert.equal(fakePrisma._state.credits.get('u1').balance, 95n);
  assert.equal(first.req._chargedCredits.durableWinner, true);
  assert.equal(first.req._chargedCredits.ownsLease, true);
  assert.match(
    first.req._chargedCredits.idempotencyKeyHash,
    /^credit-idem:v1:[a-f0-9]{64}$/,
  );
  assert.equal(
    first.req._chargedCredits.idempotencyKeyHash.includes('paid-key'),
    false,
  );

  await cacheIdempotentResponse(first.req, {
    statusCode: 200,
    body: { output: 'cached paid response' },
  }, fakePrisma);

  const replay = middlewareContext({ body, idempotencyKey: 'paid-key' });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    replay.req,
    replay.res,
    replay.next,
  );
  assert.equal(replay.snapshot().nextCalls, 0);
  assert.equal(replay.snapshot().statusCode, 200);
  assert.deepEqual(replay.snapshot().responseBody, {
    output: 'cached paid response',
  });
  assert.equal(replay.snapshot().headers['x-sira-idempotent-replay'], 'true');
  assert.equal(fakePrisma._state.credits.get('u1').balance, 95n);
});

test('expired paid lease recovers provider work without a second debit', async () => {
  const first = middlewareContext({ idempotencyKey: 'lease-recovery-key' });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    first.req,
    first.res,
    first.next,
  );
  const durable = fakePrisma._state.rows[0];
  durable.metadata.idempotency.leaseUntil = '2000-01-01T00:00:00.000Z';
  const firstLeaseToken = durable.metadata.idempotency.leaseToken;

  const retry = middlewareContext({ idempotencyKey: 'lease-recovery-key' });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    retry.req,
    retry.res,
    retry.next,
  );
  assert.equal(retry.snapshot().nextCalls, 1);
  assert.equal(retry.req._chargedCredits.recovered, true);
  assert.equal(retry.req._chargedCredits.ownsLease, true);
  assert.equal(retry.req._chargedCredits.txn.id, first.req._chargedCredits.txn.id);
  assert.notEqual(
    retry.req._chargedCredits.txn.metadata.idempotency.leaseToken,
    firstLeaseToken,
  );
  assert.equal(fakePrisma._state.credits.get('u1').balance, 95n);
  assert.equal(fakePrisma._state.rows.length, 1);
});

test('heartbeat keeps an over-lease live request from invoking the provider twice', async () => {
  const first = middlewareContext({ idempotencyKey: 'heartbeat-live-key' });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    first.req,
    first.res,
    first.next,
  );
  const durable = fakePrisma._state.rows[0];
  const now = Date.now();
  durable.metadata.idempotency.startedAt = new Date(now).toISOString();
  durable.metadata.idempotency.leaseUntil = new Date(now + 20).toISOString();
  durable.metadata.idempotency.leaseMs = 20;

  let providerCalls = 1;
  const heartbeat = startIdempotencyLeaseHeartbeat(first.req, {
    prismaClient: fakePrisma,
    intervalMs: 5,
    leaseMs: 5_000,
  });
  try {
    const deadline = Date.now() + 250;
    while (
      !fakePrisma._state.rows[0].metadata.idempotency.heartbeatAt
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(fakePrisma._state.rows[0].metadata.idempotency.heartbeatAt);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const retry = middlewareContext({ idempotencyKey: 'heartbeat-live-key' });
    await chargeCredits({ feature: 'paraphrase', cost: 5 })(
      retry.req,
      retry.res,
      () => {
        providerCalls += 1;
        retry.next();
      },
    );
    assert.equal(retry.snapshot().statusCode, 409);
    assert.equal(retry.snapshot().responseBody.code, 'IDEMPOTENCY_IN_PROGRESS');
    assert.equal(providerCalls, 1);
    assert.equal(fakePrisma._state.credits.get('u1').balance, 95n);
  } finally {
    await heartbeat.stop();
  }
});

test('fallback winner writes the shared zero-amount ledger row before provider work', async () => {
  cerebrasEnabled = true;
  fakePrisma.setBalance('u1', 0n);
  const ctx = middlewareContext({ idempotencyKey: 'fallback-key' });
  await chargeCredits({
    feature: 'paraphrase',
    cost: 5,
    allowFreeIaFallback: true,
  })(ctx.req, ctx.res, ctx.next);

  assert.equal(ctx.snapshot().nextCalls, 1);
  assert.equal(ctx.req._chargedCredits.fallback, 'free_ia');
  assert.equal(ctx.req._chargedCredits.durableWinner, true);
  assert.equal(ctx.req._chargedCredits.ownsLease, true);
  assert.equal(ctx.req._chargedCredits.txn.amount, 0n);
  assert.equal(ctx.req._chargedCredits.txn.metadata.path, 'free_ia');
  assert.equal(ctx.req._chargedCredits.txn.metadata.idempotency.state, 'in_progress');
  assert.equal(ctx.req._chargedCredits.txn.idempotencyKey.includes('fallback-key'), false);
  assert.equal(ctx.req._fallbackToFreeIA.config.apiKey, undefined);
  assert.equal(ctx.req._fallbackToFreeIA.config.baseURL, undefined);
  assert.equal(fakePrisma._state.rows.length, 1);
});

test('cached fallback replay restores durable fallback headers', async () => {
  cerebrasEnabled = true;
  fakePrisma.setBalance('u1', 0n);
  const first = middlewareContext({ idempotencyKey: 'fallback-header-key' });
  await chargeCredits({
    feature: 'paraphrase',
    cost: 7,
    allowFreeIaFallback: true,
  })(first.req, first.res, first.next);
  await cacheIdempotentResponse(first.req, {
    statusCode: 200,
    body: { output: 'cached free response' },
  }, fakePrisma);

  fakePrisma.setBalance('u1', 100n);
  const replay = middlewareContext({ idempotencyKey: 'fallback-header-key' });
  await chargeCredits({
    feature: 'paraphrase',
    cost: 7,
    allowFreeIaFallback: true,
  })(replay.req, replay.res, replay.next);

  assert.equal(replay.snapshot().statusCode, 200);
  assert.deepEqual(replay.snapshot().responseBody, { output: 'cached free response' });
  assert.equal(replay.snapshot().headers['x-sira-idempotent-replay'], 'true');
  assert.equal(replay.snapshot().headers['x-sira-fallback'], 'free-ia');
  assert.equal(replay.snapshot().headers['x-sira-fallback-feature'], 'paraphrase');
  assert.equal(replay.snapshot().headers['x-sira-fallback-cost'], '7');
  assert.equal(fakePrisma._state.credits.get('u1').balance, 100n);
});

test('completed response_unavailable replay conflicts without rerunning or refunding', async () => {
  const body = { text: 'large successful response', language: 'en' };
  const first = middlewareContext({
    body,
    idempotencyKey: 'response-unavailable-key',
  });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    first.req,
    first.res,
    first.next,
  );
  const completed = await completeLedgerTransactionWithoutResponse({
    prismaClient: fakePrisma,
    transaction: first.req._chargedCredits.txn,
    code: 'IDEMPOTENCY_RESPONSE_TOO_LARGE',
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.txn.metadata.idempotency.state, 'completed');
  assert.equal(completed.txn.metadata.idempotency.response, null);
  assert.equal(
    completed.txn.metadata.idempotency.responseUnavailable.code,
    'IDEMPOTENCY_RESPONSE_TOO_LARGE',
  );

  const replay = middlewareContext({
    body,
    idempotencyKey: 'response-unavailable-key',
  });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    replay.req,
    replay.res,
    replay.next,
  );
  assert.equal(replay.snapshot().nextCalls, 0);
  assert.equal(replay.snapshot().statusCode, 409);
  assert.deepEqual(replay.snapshot().responseBody, {
    error: 'idempotent request completed without a replayable response',
    code: 'IDEMPOTENCY_COMPLETED_WITHOUT_RESPONSE',
    retryable: false,
    retryWithNewIdempotencyKey: true,
  });
  assert.equal(fakePrisma._state.credits.get('u1').balance, 95n);
  assert.equal(fakePrisma._state.rows.length, 1);
});

test('same key cannot switch from fallback to paid after a top-up', async () => {
  cerebrasEnabled = true;
  fakePrisma.setBalance('u1', 0n);
  const first = middlewareContext({ idempotencyKey: 'cross-path-key' });
  await chargeCredits({
    feature: 'paraphrase',
    cost: 5,
    allowFreeIaFallback: true,
  })(first.req, first.res, first.next);
  assert.equal(first.snapshot().nextCalls, 1);

  fakePrisma.setBalance('u1', 100n);
  const replay = middlewareContext({ idempotencyKey: 'cross-path-key' });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    replay.req,
    replay.res,
    replay.next,
  );
  assert.equal(replay.snapshot().statusCode, 409);
  assert.equal(replay.snapshot().responseBody.code, 'IDEMPOTENCY_IN_PROGRESS');
  assert.equal(fakePrisma._state.credits.get('u1').balance, 100n);
  assert.equal(fakePrisma._state.rows.length, 1);
});

test('failed lifecycle replays as stable 409 rather than rerunning provider work', async () => {
  const body = { text: 'will fail', language: 'en' };
  const first = middlewareContext({ body, idempotencyKey: 'failed-key' });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    first.req,
    first.res,
    first.next,
  );
  await failIdempotentOperation(first.req, {
    code: 'UPSTREAM_503',
    statusCode: 502,
  }, fakePrisma);

  const replay = middlewareContext({ body, idempotencyKey: 'failed-key' });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    replay.req,
    replay.res,
    replay.next,
  );
  assert.equal(replay.snapshot().statusCode, 409);
  assert.deepEqual(replay.snapshot().responseBody, {
    error: 'idempotent request cannot be replayed in its current state',
    code: 'IDEMPOTENCY_FAILED',
    retryable: true,
  });
  assert.equal(fakePrisma._state.credits.get('u1').balance, 95n);
});

test('refund_pending replay strictly reconciles the charge before returning', async () => {
  const body = { text: 'needs refund reconciliation', language: 'en' };
  const first = middlewareContext({
    body,
    idempotencyKey: 'refund-pending-key',
  });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    first.req,
    first.res,
    first.next,
  );
  const pending = await failIdempotentOperation(first.req, {
    code: 'REFUND_FAILED',
    statusCode: 503,
    state: 'refund_pending',
  }, fakePrisma);
  assert.equal(pending.ok, true);
  assert.equal(pending.txn.metadata.idempotency.state, 'refund_pending');

  const replay = middlewareContext({
    body,
    idempotencyKey: 'refund-pending-key',
  });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    replay.req,
    replay.res,
    replay.next,
  );
  assert.equal(replay.snapshot().statusCode, 409);
  assert.equal(replay.snapshot().responseBody.code, 'IDEMPOTENCY_REFUNDED');
  assert.equal(replay.snapshot().responseBody.retryable, true);
  assert.equal(fakePrisma._state.credits.get('u1').balance, 100n);
  const original = fakePrisma._state.rows.find(
    (row) => row.id === first.req._chargedCredits.txn.id,
  );
  assert.equal(original.metadata.idempotency.state, 'refunded');
});

test('refund_pending replay remains an explicit retryable 503 when reconciliation fails', async () => {
  const body = { text: 'refund must remain visible', language: 'en' };
  const first = middlewareContext({
    body,
    idempotencyKey: 'refund-pending-retry-key',
  });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    first.req,
    first.res,
    first.next,
  );
  await failIdempotentOperation(first.req, {
    code: 'REFUND_FAILED',
    statusCode: 503,
    state: 'refund_pending',
  }, fakePrisma);
  fakePrisma.setRefundFailure(true);

  const replay = middlewareContext({
    body,
    idempotencyKey: 'refund-pending-retry-key',
  });
  await chargeCredits({ feature: 'paraphrase', cost: 5 })(
    replay.req,
    replay.res,
    replay.next,
  );
  assert.equal(replay.snapshot().statusCode, 503);
  assert.equal(replay.snapshot().responseBody.code, 'IDEMPOTENCY_REFUND_PENDING');
  assert.equal(replay.snapshot().responseBody.retryable, true);
  assert.equal(replay.snapshot().responseBody.transactionId, first.req._chargedCredits.txn.id);
  assert.equal(fakePrisma._state.credits.get('u1').balance, 95n);
  const original = fakePrisma._state.rows.find(
    (row) => row.id === first.req._chargedCredits.txn.id,
  );
  assert.equal(original.metadata.idempotency.state, 'refund_pending');
});

test('refund is atomic, deterministic, idempotent, and leaves original refunded', async () => {
  const charge = await spendCredits({
    prismaClient: fakePrisma,
    userId: 'u1',
    amount: 9,
    feature: 'paraphrase',
    idempotencyKey: 'refund-source-key',
    requestHash: 'refund-source-hash',
  });
  const first = await refundCharge({
    prismaClient: fakePrisma,
    originalTxn: charge.txn,
    reason: 'similarity_gate',
  });
  const replay = await refundCharge({
    prismaClient: fakePrisma,
    originalTxn: charge.txn,
    reason: 'similarity_gate',
  });
  assert.equal(first.ok, true);
  assert.equal(first.winner, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.txn.id, first.txn.id);
  assert.match(first.txn.idempotencyKey, /^credit-idem:v1:[a-f0-9]{64}$/);
  assert.equal(first.txn.idempotencyKey.includes(`refund:${charge.txn.id}`), false);
  assert.equal(fakePrisma._state.credits.get('u1').balance, 100n);
  const original = fakePrisma._state.rows.find((row) => row.id === charge.txn.id);
  assert.equal(original.metadata.idempotency.state, 'refunded');
});

test('same raw key remains independent across users', async () => {
  const input = {
    amount: 5,
    feature: 'paraphrase',
    idempotencyKey: 'shared-user-key',
    requestHash: 'same-body',
    prismaClient: fakePrisma,
  };
  const first = await spendCredits({ ...input, userId: 'u1' });
  const second = await spendCredits({ ...input, userId: 'u2' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.txn.idempotencyKey, second.txn.idempotencyKey);
  assert.equal(fakePrisma._state.rows.length, 2);
});
