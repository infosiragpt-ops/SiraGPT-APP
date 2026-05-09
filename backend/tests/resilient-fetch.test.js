'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createResilientFetch,
  isRetryableResponse,
  isRetryableError,
} = require('../src/utils/resilient-fetch');

function fakeRes(status, body, headers = {}) {
  return {
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('isRetryableResponse / isRetryableError', () => {
  test('5xx + 429/408/425 are retryable', () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) {
      assert.equal(isRetryableResponse({ status: s }), true);
    }
  });
  test('2xx / 4xx (non-retryable) are not', () => {
    for (const s of [200, 201, 400, 401, 403, 404]) {
      assert.equal(isRetryableResponse({ status: s }), false);
    }
  });
  test('AbortError + ETIMEDOUT-style codes retryable', () => {
    assert.equal(isRetryableError({ name: 'AbortError' }), true);
    assert.equal(isRetryableError({ code: 'ETIMEDOUT' }), true);
    assert.equal(isRetryableError({ code: 'ECONNRESET' }), true);
    assert.equal(isRetryableError({ name: 'TypeError', message: 'fetch failed' }), true);
    assert.equal(isRetryableError(null), false);
    assert.equal(isRetryableError({}), false);
  });
});

describe('createResilientFetch — happy path', () => {
  test('first 200 returns the response', async () => {
    let calls = 0;
    const r = createResilientFetch({
      fetch: async () => { calls += 1; return fakeRes(200, { ok: true }); },
      backoff: { next: () => 0 },
    });
    const res = await r.send('http://x');
    assert.equal(res.status, 200);
    assert.equal(calls, 1);
  });

  test('json() helper returns parsed body', async () => {
    const r = createResilientFetch({
      fetch: async () => fakeRes(200, { hello: 'world' }),
      backoff: { next: () => 0 },
    });
    const body = await r.json('http://x');
    assert.deepEqual(body, { hello: 'world' });
  });
});

describe('createResilientFetch — retries', () => {
  test('5xx then 200 succeeds within deadline', async () => {
    let n = 0;
    const r = createResilientFetch({
      fetch: async () => { n += 1; return n < 3 ? fakeRes(503) : fakeRes(200, { ok: true }); },
      backoff: { next: () => 1 },
      deadlineMs: 60_000,
    });
    const res = await r.send('http://x');
    assert.equal(res.status, 200);
    assert.equal(n, 3);
  });

  test('exhausts attempts → returns last 5xx response (not synthetic error)', async () => {
    let n = 0;
    const r = createResilientFetch({
      fetch: async () => { n += 1; return fakeRes(503); },
      backoff: { next: () => 1 },
      maxAttempts: 2,
      deadlineMs: 100,
    });
    const res = await r.send('http://x');
    assert.equal(res.status, 503);
    assert.ok(n <= 3);
  });

  test('non-retryable 4xx returned immediately, no retry', async () => {
    let n = 0;
    const r = createResilientFetch({
      fetch: async () => { n += 1; return fakeRes(401); },
      backoff: { next: () => 1 },
    });
    const res = await r.send('http://x');
    assert.equal(res.status, 401);
    assert.equal(n, 1);
  });

  test('Retry-After header honored', async () => {
    const seenWaits = [];
    let n = 0;
    const r = createResilientFetch({
      fetch: async () => { n += 1; return n < 2 ? fakeRes(429, null, { 'retry-after': '0.05' }) : fakeRes(200, {}); },
      backoff: { next: ({ retryAfter }) => { seenWaits.push(retryAfter); return 1; } },
      deadlineMs: 60_000,
    });
    await r.send('http://x');
    assert.equal(seenWaits[0], 0.05);
  });
});

describe('createResilientFetch — trace context injection', () => {
  test('traceparent header is added when context provided', async () => {
    let seen = null;
    const r = createResilientFetch({
      fetch: async (_url, init) => { seen = init.headers; return fakeRes(200, {}); },
      traceContext: {
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        flags: 1,
      },
    });
    await r.send('http://x');
    assert.match(seen.traceparent, /00-4bf92f3577b34da6a3ce929d0e0e4736-/);
  });

  test('default headers merged with init headers', async () => {
    let seen = null;
    const r = createResilientFetch({
      fetch: async (_url, init) => { seen = init.headers; return fakeRes(200, {}); },
      headers: { 'x-default': 'A' },
    });
    await r.send('http://x', { headers: { 'x-extra': 'B' } });
    assert.equal(seen['x-default'], 'A');
    assert.equal(seen['x-extra'], 'B');
  });
});

describe('createResilientFetch — guards', () => {
  test('rejects when no fetch implementation available', () => {
    const orig = globalThis.fetch;
    delete globalThis.fetch;
    try {
      assert.throws(() => createResilientFetch({}), TypeError);
    } finally {
      if (orig) globalThis.fetch = orig;
    }
  });

  test('json throws on response without .json()', async () => {
    const r = createResilientFetch({
      fetch: async () => ({ status: 200, headers: { get: () => null } }),
      backoff: { next: () => 0 },
    });
    await assert.rejects(r.json('http://x'), /no \.json\(\)/);
  });
});
