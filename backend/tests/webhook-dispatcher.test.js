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
