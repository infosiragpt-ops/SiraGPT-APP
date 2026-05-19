'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dispatcher = require('../src/services/webhook-dispatcher');

test.beforeEach(() => dispatcher.resetStore({ size: 100 }));

test('signPayload + verifySignature roundtrip', () => {
  const sig = dispatcher.signPayload('s3cret', { hello: 'world' }, 1700000000);
  // ratchet 45 task 2: outbound header carries BOTH v1 and v2 segments.
  // ratchet 45 task 2: outbound header now also includes an `n=<hex>`
  // nonce segment bound into the v2 base string.
  assert.match(sig, /^t=1700000000,n=[0-9a-f]{32},v1=[0-9a-f]{64},v2=[0-9a-f]{64}$/);
  const ok = dispatcher.verifySignature('s3cret', { hello: 'world' }, sig, {
    now: 1700000000,
    toleranceSeconds: 60,
  });
  assert.equal(ok, true);
});

// ── ratchet 45 task 2: dual v1/v2 algorithm ─────────────────────────
test('signPayload includeV2:false still emits v1-only for legacy mode', () => {
  const sig = dispatcher.signPayload('s', 'body', 1700000000, { includeV2: false });
  assert.match(sig, /^t=1700000000,v1=[0-9a-f]{64}$/);
  assert.equal(sig.includes('v2='), false);
});

test('verifySignature accepts a v1-only header (legacy consumers)', () => {
  const sig = dispatcher.signPayload('s', 'body', 1700000000, { includeV2: false });
  const ok = dispatcher.verifySignature('s', 'body', sig, {
    now: 1700000000, toleranceSeconds: 60,
  });
  assert.equal(ok, true);
});

test('verifySignature accepts a v2-only header (new consumers)', () => {
  // Hand-craft a v2-only header to simulate a consumer that strips v1.
  const crypto = require('crypto');
  const ts = 1700000000;
  const v2 = crypto.createHmac('sha256', 's').update(`v2:${ts}.body`).digest('hex');
  const header = `t=${ts},v2=${v2}`;
  const ok = dispatcher.verifySignature('s', 'body', header, {
    now: ts, toleranceSeconds: 60,
  });
  assert.equal(ok, true);
});

test('verifySignature rejects v1 digest replayed in v2 slot (domain sep)', () => {
  const crypto = require('crypto');
  const ts = 1700000000;
  const v1 = crypto.createHmac('sha256', 's').update(`${ts}.body`).digest('hex');
  // Place the v1 digest in the v2 slot — must fail because v2 uses a
  // distinct, domain-separated base string.
  const header = `t=${ts},v2=${v1}`;
  const ok = dispatcher.verifySignature('s', 'body', header, {
    now: ts, toleranceSeconds: 60,
  });
  assert.equal(ok, false);
});

// ── ratchet 45 task 1: rotate-secret grace window verification ──────
test('verifySignature accepts EITHER current or previous secret (rotation grace)', () => {
  const sigOld = dispatcher.signPayload('old', 'body', 1700000000);
  const sigNew = dispatcher.signPayload('new', 'body', 1700000000);
  // Caller (e.g. inbound webhook handler) passes both secrets during
  // the grace window. Either signature must verify.
  assert.equal(
    dispatcher.verifySignature(['new', 'old'], 'body', sigOld, {
      now: 1700000000, toleranceSeconds: 60,
    }),
    true,
  );
  assert.equal(
    dispatcher.verifySignature(['new', 'old'], 'body', sigNew, {
      now: 1700000000, toleranceSeconds: 60,
    }),
    true,
  );
  // A foreign secret must still reject.
  assert.equal(
    dispatcher.verifySignature(['new', 'old'], 'body', dispatcher.signPayload('other', 'body', 1700000000), {
      now: 1700000000, toleranceSeconds: 60,
    }),
    false,
  );
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
  assert.match(captured.headers[dispatcher.SIGNATURE_HEADER], /^t=\d+,n=[0-9a-f]+,v1=/);
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

// ── ratchet 45 task 2: per-delivery nonce ───────────────────────────
test('signPayload emits unique nonces across consecutive calls', () => {
  const a = dispatcher.signPayload('s', 'body', 1700000000);
  const b = dispatcher.signPayload('s', 'body', 1700000000);
  const na = a.match(/n=([0-9a-f]+)/)[1];
  const nb = b.match(/n=([0-9a-f]+)/)[1];
  assert.notEqual(na, nb, 'nonces must differ across signatures');
  assert.equal(na.length, 32);
});

test('verifySignature with nonceCache rejects same nonce twice (replay)', () => {
  const cache = dispatcher.createNonceCache();
  const sig = dispatcher.signPayload('s', 'body', 1700000000);
  const first = dispatcher.verifySignature('s', 'body', sig, {
    now: 1700000000, toleranceSeconds: 60, nonceCache: cache,
  });
  const second = dispatcher.verifySignature('s', 'body', sig, {
    now: 1700000000, toleranceSeconds: 60, nonceCache: cache,
  });
  assert.equal(first, true);
  assert.equal(second, false, 'replayed nonce must reject');
});

test('verifySignature without nonceCache accepts the same header twice (back-compat)', () => {
  const sig = dispatcher.signPayload('s', 'body', 1700000000);
  const a = dispatcher.verifySignature('s', 'body', sig, { now: 1700000000, toleranceSeconds: 60 });
  const b = dispatcher.verifySignature('s', 'body', sig, { now: 1700000000, toleranceSeconds: 60 });
  assert.equal(a, true);
  assert.equal(b, true);
});

test('verifySignature still accepts legacy v2 headers without an n= segment', () => {
  const crypto = require('crypto');
  const ts = 1700000000;
  const v2 = crypto.createHmac('sha256', 's').update(`v2:${ts}.body`).digest('hex');
  const header = `t=${ts},v2=${v2}`;
  assert.equal(
    dispatcher.verifySignature('s', 'body', header, { now: ts, toleranceSeconds: 60 }),
    true,
  );
});

test('tampered nonce in header fails verification', () => {
  const sig = dispatcher.signPayload('s', 'body', 1700000000);
  const swapped = sig.replace(/n=[0-9a-f]+/, 'n=' + '0'.repeat(32));
  // v1 still matches (no nonce binding) so verification passes only on
  // the v1 path. Strip v1 to force v2-only and confirm the nonce binding
  // detects tampering.
  const v2Only = swapped.replace(/,v1=[0-9a-f]+/, '');
  assert.equal(
    dispatcher.verifySignature('s', 'body', v2Only, { now: 1700000000, toleranceSeconds: 60 }),
    false,
  );
});

test('createNonceCache evicts oldest entries past maxSize', () => {
  const cache = dispatcher.createNonceCache({ maxSize: 2 });
  cache.seenOrRemember('a', 1700000000, 60);
  cache.seenOrRemember('b', 1700000000, 60);
  // 'b' is still present (within capacity).
  assert.equal(cache.seenOrRemember('b', 1700000000, 60), true);
  cache.seenOrRemember('c', 1700000000, 60);
  // Adding 'c' evicted the oldest ('a') → fresh again.
  assert.equal(cache.seenOrRemember('a', 1700000000, 60), false);
});
