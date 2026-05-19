'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dispatcher = require('../src/services/webhook-dispatcher');

test.beforeEach(() => dispatcher.resetStore({ size: 100 }));

test('signPayload + verifySignature roundtrip', () => {
  const sig = dispatcher.signPayload('s3cret', { hello: 'world' }, 1700000000);
  assert.match(sig, /^t=1700000000,v1=[0-9a-f]{64}$/);
  const ok = dispatcher.verifySignature('s3cret', { hello: 'world' }, sig, {
    now: 1700000000,
    toleranceSeconds: 60,
  });
  assert.equal(ok, true);
});

test('verifySignature rejects stale or wrong secret', () => {
  const sig = dispatcher.signPayload('s3cret', 'body', 1700000000);
  assert.equal(
    dispatcher.verifySignature('s3cret', 'body', sig, { now: 1700001000, toleranceSeconds: 60 }),
    false,
    'stale timestamp must reject'
  );
  assert.equal(
    dispatcher.verifySignature('other', 'body', sig, { now: 1700000000, toleranceSeconds: 60 }),
    false,
    'wrong secret must reject'
  );
});

test('dispatch succeeds on first try and signs the request', async () => {
  let captured;
  const deliverFn = async (req) => {
    captured = req;
    return { status: 200, ok: true };
  };
  const result = await dispatcher.dispatch({
    url: 'https://example.com/hook',
    event: 'user.created',
    payload: { id: 'u1' },
    secret: 'topsecret',
    deliverFn,
    maxRetries: 0,
  });
  assert.equal(result.status, 'delivered');
  assert.equal(result.attempts, 1);
  assert.equal(captured.headers['X-SiraGPT-Event'], 'user.created');
  assert.match(captured.headers[dispatcher.SIGNATURE_HEADER], /^t=\d+,v1=/);
});

test('dispatch retries on 5xx then succeeds', async () => {
  let calls = 0;
  const deliverFn = async () => {
    calls += 1;
    if (calls < 2) return { status: 503, ok: false };
    return { status: 200, ok: true };
  };
  const result = await dispatcher.dispatch({
    url: 'https://example.com/hook',
    event: 'test',
    payload: {},
    deliverFn,
    maxRetries: 3,
    baseDelayMs: 1,
    maxDelayMs: 2,
  });
  assert.equal(result.status, 'delivered');
  assert.equal(calls, 2);
});

test('dispatch records a failed delivery when all retries exhausted', async () => {
  const deliverFn = async () => ({ status: 500, ok: false });
  const result = await dispatcher.dispatch({
    url: 'https://example.com/hook',
    event: 'test',
    payload: {},
    deliverFn,
    maxRetries: 1,
    baseDelayMs: 1,
    maxDelayMs: 2,
  });
  assert.equal(result.status, 'failed');
  const list = dispatcher.listDeliveries({});
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'failed');
});

test('retryFailed re-dispatches only failed entries', async () => {
  // Seed one failure.
  await dispatcher.dispatch({
    url: 'u',
    event: 'e',
    payload: {},
    deliverFn: async () => ({ status: 500, ok: false }),
    maxRetries: 0,
    baseDelayMs: 1,
  });
  // Seed one success.
  await dispatcher.dispatch({
    url: 'u',
    event: 'e2',
    payload: {},
    deliverFn: async () => ({ status: 200, ok: true }),
    maxRetries: 0,
  });

  const result = await dispatcher.retryFailed({
    deliverFn: async () => ({ status: 200, ok: true }),
  });
  assert.equal(result.candidates, 1);
  assert.equal(result.retried, 1);
  assert.equal(result.recovered, 1);
});

test('dispatch requires url and event', async () => {
  await assert.rejects(() => dispatcher.dispatch({ event: 'x' }), /url/);
  await assert.rejects(() => dispatcher.dispatch({ url: 'x' }), /event/);
});

// ── health snapshot (ratchet 45) ───────────────────────────────────
test('health returns zeroed snapshot when buffer is empty', () => {
  const h = dispatcher.health();
  assert.equal(h.delivered24h, 0);
  assert.equal(h.failed24h, 0);
  assert.equal(h.failureRate, 0);
  assert.equal(h.p95DurationMs, 0);
  assert.equal(h.retryingNow, 0);
});

test('health aggregates delivered + failed counts and failure rate', async () => {
  // 2 successes, 1 failure → 33% failure rate.
  await dispatcher.dispatch({
    url: 'u', event: 'ok', payload: {},
    deliverFn: async () => ({ status: 200, ok: true }), maxRetries: 0,
  });
  await dispatcher.dispatch({
    url: 'u', event: 'ok', payload: {},
    deliverFn: async () => ({ status: 200, ok: true }), maxRetries: 0,
  });
  await dispatcher.dispatch({
    url: 'u', event: 'bad', payload: {},
    deliverFn: async () => ({ status: 500, ok: false }), maxRetries: 0,
    baseDelayMs: 1, maxDelayMs: 1,
  });
  const h = dispatcher.health();
  assert.equal(h.delivered24h, 2);
  assert.equal(h.failed24h, 1);
  assert.equal(h.totalTerminal24h, 3);
  // 1/3 = 0.3333
  assert.ok(Math.abs(h.failureRate - 0.3333) < 0.001);
  // p95 has a finite value once we've recorded durations.
  assert.ok(h.p95DurationMs >= 0);
});

test('health windowMs excludes entries older than the window', async () => {
  await dispatcher.dispatch({
    url: 'u', event: 'ok', payload: {},
    deliverFn: async () => ({ status: 200, ok: true }), maxRetries: 0,
  });
  // 0ms window → the just-recorded delivery is older than the cutoff.
  const h = dispatcher.health({ windowMs: 0, now: () => Date.now() + 1000 });
  assert.equal(h.delivered24h, 0);
});

test('health p95 reflects observed durations', async () => {
  // A deliverFn that burns wall-clock so durationMs is observable.
  const slow = (ms) => async () => {
    await new Promise((r) => setTimeout(r, ms));
    return { status: 200, ok: true };
  };
  await dispatcher.dispatch({
    url: 'u', event: 'ok', payload: {}, deliverFn: slow(15), maxRetries: 0,
  });
  await dispatcher.dispatch({
    url: 'u', event: 'ok', payload: {}, deliverFn: slow(5), maxRetries: 0,
  });
  const h = dispatcher.health();
  // p95 of {5,15} (nearest-rank) is 15.
  assert.ok(h.p95DurationMs > 0, `expected p95 > 0, got ${h.p95DurationMs}`);
});

// ── DLQ (ratchet 45) ────────────────────────────────────────────────
test('dlq receives a delivery when retries are exhausted', async () => {
  await dispatcher.dispatch({
    url: 'https://example.com/h', event: 'evt', payload: { a: 1 },
    deliverFn: async () => ({ status: 500, ok: false }),
    maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2,
  });
  const items = dispatcher.listDLQ({});
  assert.equal(items.length, 1);
  assert.equal(items[0].event, 'evt');
  assert.equal(items[0].url, 'https://example.com/h');
  assert.ok(items[0].attempts >= 1);
  assert.ok(items[0].error);
  assert.ok(items[0].failedAt);
});

test('dlq does not receive successful deliveries', async () => {
  await dispatcher.dispatch({
    url: 'u', event: 'ok', payload: {},
    deliverFn: async () => ({ status: 200, ok: true }), maxRetries: 0,
  });
  assert.equal(dispatcher.listDLQ({}).length, 0);
});

test('retryDLQItem re-dispatches and removes on success', async () => {
  await dispatcher.dispatch({
    url: 'u', event: 'evt', payload: { x: 1 },
    deliverFn: async () => ({ status: 500, ok: false }),
    maxRetries: 0, baseDelayMs: 1,
  });
  const [item] = dispatcher.listDLQ({});
  assert.ok(item, 'expected DLQ item');

  const result = await dispatcher.retryDLQItem(item.id, {
    deliverFn: async () => ({ status: 200, ok: true }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'delivered');
  assert.equal(dispatcher.listDLQ({}).length, 0, 'DLQ should be empty after success');
});

test('retryDLQItem keeps item when redelivery fails', async () => {
  await dispatcher.dispatch({
    url: 'u', event: 'evt', payload: {},
    deliverFn: async () => ({ status: 500, ok: false }),
    maxRetries: 0, baseDelayMs: 1,
  });
  const [item] = dispatcher.listDLQ({});
  const result = await dispatcher.retryDLQItem(item.id, {
    deliverFn: async () => ({ status: 500, ok: false }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'failed');
  // Manual replay sets _fromDLQ so we don't re-push (would duplicate).
  assert.equal(dispatcher.listDLQ({}).length, 1);
});

test('retryDLQItem returns not_found for unknown id', async () => {
  const result = await dispatcher.retryDLQItem('nope');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
});

test('DLQ mirrors to Redis backend when configured (best-effort)', async () => {
  const calls = [];
  dispatcher.setDLQRedisBackend({
    lpush: async (k, v) => { calls.push({ op: 'lpush', k, v }); return 1; },
    ltrim: async (k, a, b) => { calls.push({ op: 'ltrim', k, a, b }); return 'OK'; },
    lrem: async (k, c, v) => { calls.push({ op: 'lrem', k, c, v }); return 1; },
  });
  try {
    await dispatcher.dispatch({
      url: 'u', event: 'evt', payload: {},
      deliverFn: async () => ({ status: 500, ok: false }),
      maxRetries: 0, baseDelayMs: 1,
    });
    // Give the best-effort .then() a chance to run.
    await new Promise((r) => setImmediate(r));
    assert.ok(calls.some((c) => c.op === 'lpush'), 'lpush should fire');
    assert.equal(dispatcher.dlqStats().redisBacked, true);
  } finally {
    dispatcher.setDLQRedisBackend(null);
  }
});

test('DLQ tolerates a throwing Redis backend without breaking dispatch', async () => {
  dispatcher.setDLQRedisBackend({
    lpush: () => { throw new Error('boom'); },
  });
  try {
    await dispatcher.dispatch({
      url: 'u', event: 'evt', payload: {},
      deliverFn: async () => ({ status: 500, ok: false }),
      maxRetries: 0, baseDelayMs: 1,
    });
    assert.equal(dispatcher.listDLQ({}).length, 1);
  } finally {
    dispatcher.setDLQRedisBackend(null);
  }
});
