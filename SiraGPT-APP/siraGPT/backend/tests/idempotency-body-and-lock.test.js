/**
 * idempotency-body-and-lock — pins the two Stripe-equivalent
 * properties that the original idempotency.test.js does not cover:
 *
 *   1. Body-hash mismatch.
 *      Same key, different body → 409. Replaying the wrong response
 *      to a mutated payload would silently corrupt state, so the
 *      conflict has to surface.
 *
 *   2. In-flight lock.
 *      Two concurrent requests with the same key + same body must
 *      not both run the handler. The first one acquires the slot,
 *      the second either waits for the final response and replays
 *      it, or fast-fails 409 if the lock cannot be acquired in time.
 *      A concurrent request with the same key but a DIFFERENT body
 *      is rejected as a mismatch immediately — never queued.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  idempotencyMiddleware,
  createInMemoryIdempotencyStore,
  computeBodyHash,
  stableStringify,
  REPLAY_HEADER,
  REPLAY_KEY_HEADER,
} = require('../src/middleware/idempotency');

function fakeRes() {
  const headers = {};
  let payload = null;
  let endCalled = false;
  const listeners = { close: [], finish: [] };
  const res = {
    statusCode: 200,
    setHeader(name, value) { headers[name] = value; },
    getHeader(name) { return headers[name]; },
    status(code) { res.statusCode = code; return res; },
    json(body) {
      payload = body;
      endCalled = true;
      return res;
    },
    on(event, fn) {
      if (listeners[event]) listeners[event].push(fn);
      return res;
    },
    _emit(event) {
      for (const fn of (listeners[event] || [])) fn();
    },
    _state() { return { headers, statusCode: res.statusCode, payload, endCalled }; },
  };
  return res;
}

function fakeNext() {
  let calls = 0;
  function next() { calls += 1; }
  next.calls = () => calls;
  return next;
}

function fakeReq({ method = 'POST', headers = {}, user = null, ip = '203.0.113.5', body = undefined } = {}) {
  return { method, headers, user, ip, body };
}

describe('stableStringify — order-independent', () => {
  test('object key order does not change the serialization', () => {
    assert.equal(
      stableStringify({ a: 1, b: 2, c: 3 }),
      stableStringify({ c: 3, b: 2, a: 1 }),
    );
  });

  test('nested objects are also canonicalized', () => {
    const left = stableStringify({ outer: { z: 1, a: 2 }, list: [{ y: 1, x: 2 }] });
    const right = stableStringify({ list: [{ x: 2, y: 1 }], outer: { a: 2, z: 1 } });
    assert.equal(left, right);
  });

  test('arrays preserve order — order is meaningful', () => {
    assert.notEqual(stableStringify([1, 2, 3]), stableStringify([3, 2, 1]));
  });
});

describe('computeBodyHash', () => {
  test('undefined body yields null hash (back-compat for tests w/o body)', () => {
    assert.equal(computeBodyHash(undefined), null);
  });

  test('same payload → same hash regardless of key order', () => {
    assert.equal(
      computeBodyHash({ goal: 'x', model: 'y' }),
      computeBodyHash({ model: 'y', goal: 'x' }),
    );
  });

  test('different payload → different hash', () => {
    assert.notEqual(
      computeBodyHash({ goal: 'x' }),
      computeBodyHash({ goal: 'y' }),
    );
  });
});

describe('middleware — body fingerprint', () => {
  test('replay with SAME key + SAME body returns the cached 2xx', async () => {
    const store = createInMemoryIdempotencyStore();
    const mw = idempotencyMiddleware({ store, env: { IDEMPOTENCY_ENABLED: 'true' } });

    const body = { goal: 'analyze X', model: 'gpt-4o' };
    const req1 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-1' }, body });
    const res1 = fakeRes();
    await mw(req1, res1, fakeNext());
    res1.status(200).json({ taskId: 't-1' });

    const req2 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-1' }, body: { ...body } });
    const res2 = fakeRes();
    const next2 = fakeNext();
    await mw(req2, res2, next2);

    assert.equal(next2.calls(), 0);
    assert.equal(res2._state().headers[REPLAY_HEADER], 'true');
    assert.deepEqual(res2._state().payload, { taskId: 't-1' });
  });

  test('replay with SAME key + DIFFERENT body returns 409 mismatch', async () => {
    const store = createInMemoryIdempotencyStore();
    const mw = idempotencyMiddleware({ store, env: { IDEMPOTENCY_ENABLED: 'true' } });

    const req1 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-2' }, body: { goal: 'first' } });
    const res1 = fakeRes();
    await mw(req1, res1, fakeNext());
    res1.status(200).json({ taskId: 't-A' });

    const req2 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-2' }, body: { goal: 'second' } });
    const res2 = fakeRes();
    const next2 = fakeNext();
    await mw(req2, res2, next2);

    assert.equal(next2.calls(), 0, 'mismatch must NOT run the handler');
    assert.equal(res2._state().statusCode, 409);
    assert.equal(res2._state().payload.error, 'idempotency-key-mismatch');
    assert.equal(res2._state().headers[REPLAY_HEADER], 'mismatch');
    assert.equal(res2._state().headers[REPLAY_KEY_HEADER], 'op-2');
  });

  test('object key reordering does NOT trigger a 409 — stable hashing', async () => {
    const store = createInMemoryIdempotencyStore();
    const mw = idempotencyMiddleware({ store, env: { IDEMPOTENCY_ENABLED: 'true' } });

    const req1 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-3' }, body: { a: 1, b: 2 } });
    const res1 = fakeRes();
    await mw(req1, res1, fakeNext());
    res1.status(200).json({ ok: true });

    const req2 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-3' }, body: { b: 2, a: 1 } });
    const res2 = fakeRes();
    await mw(req2, res2, fakeNext());

    assert.equal(res2._state().statusCode, 200);
    assert.equal(res2._state().headers[REPLAY_HEADER], 'true');
  });
});

describe('middleware — in-flight lock', () => {
  test('two concurrent requests: first acquires, second waits and replays', async () => {
    const store = createInMemoryIdempotencyStore();
    const mw = idempotencyMiddleware({
      store,
      env: { IDEMPOTENCY_ENABLED: 'true' },
      lockTimeoutMs: 2_000,
      lockPollMs: 5,
    });

    const body = { goal: 'concurrent' };
    const req1 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-c' }, body });
    const res1 = fakeRes();
    const next1 = fakeNext();

    const req2 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-c' }, body: { ...body } });
    const res2 = fakeRes();
    const next2 = fakeNext();

    // Fire both concurrently. The first will acquire the lock and
    // call next() (which is a noop in the test); the second will
    // poll until the first's res.json finalizes the slot.
    const p1 = mw(req1, res1, next1);
    const p2 = mw(req2, res2, next2);

    await p1;
    assert.equal(next1.calls(), 1, 'first request must run the handler');

    // Simulate the handler completing.
    setTimeout(() => res1.status(200).json({ taskId: 't-conc' }), 20);

    await p2;
    assert.equal(next2.calls(), 0, 'second request must NOT run the handler');
    assert.equal(res2._state().statusCode, 200);
    assert.equal(res2._state().headers[REPLAY_HEADER], 'true');
    assert.deepEqual(res2._state().payload, { taskId: 't-conc' });
  });

  test('concurrent request with DIFFERENT body fails fast with 409 mismatch', async () => {
    const store = createInMemoryIdempotencyStore();
    const mw = idempotencyMiddleware({
      store,
      env: { IDEMPOTENCY_ENABLED: 'true' },
      lockTimeoutMs: 2_000,
      lockPollMs: 5,
    });

    const req1 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-cm' }, body: { goal: 'A' } });
    const res1 = fakeRes();
    await mw(req1, res1, fakeNext());
    // do NOT call res1.status().json() yet — slot remains pending

    const req2 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-cm' }, body: { goal: 'B' } });
    const res2 = fakeRes();
    const next2 = fakeNext();
    await mw(req2, res2, next2);

    assert.equal(next2.calls(), 0);
    assert.equal(res2._state().statusCode, 409);
    assert.equal(res2._state().payload.error, 'idempotency-key-mismatch');

    // Cleanup: finalize the first one so the lock test isn't leaky.
    res1.status(200).json({ taskId: 't' });
  });

  test('lock timeout while in-flight returns 409 in-progress', async () => {
    const store = createInMemoryIdempotencyStore();
    const mw = idempotencyMiddleware({
      store,
      env: { IDEMPOTENCY_ENABLED: 'true' },
      lockTimeoutMs: 80,
      lockHoldMs: 5_000, // pending lock survives long enough that the wait deadline trips first
      lockPollMs: 10,
    });

    const body = { goal: 'long-running' };
    const req1 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-lt' }, body });
    const res1 = fakeRes();
    await mw(req1, res1, fakeNext());
    // first request never finalizes within the second's lock window

    const req2 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-lt' }, body: { ...body } });
    const res2 = fakeRes();
    const next2 = fakeNext();
    await mw(req2, res2, next2);

    assert.equal(next2.calls(), 0);
    assert.equal(res2._state().statusCode, 409);
    assert.equal(res2._state().payload.error, 'idempotency-key-in-progress');
    assert.equal(res2._state().headers[REPLAY_HEADER], 'in-progress');
  });

  test('non-2xx releases the lock so the next retry runs fresh', async () => {
    const store = createInMemoryIdempotencyStore();
    const mw = idempotencyMiddleware({
      store,
      env: { IDEMPOTENCY_ENABLED: 'true' },
      lockTimeoutMs: 1_000,
      lockPollMs: 5,
    });

    const body = { goal: 'flaky' };
    const req1 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-rel' }, body });
    const res1 = fakeRes();
    await mw(req1, res1, fakeNext());
    res1.status(500).json({ error: 'boom' });

    const req2 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-rel' }, body: { ...body } });
    const res2 = fakeRes();
    const next2 = fakeNext();
    await mw(req2, res2, next2);

    assert.equal(next2.calls(), 1, 'a 500 must release the slot for the next retry');
    assert.equal(res2._state().headers[REPLAY_HEADER], 'fresh');
  });

  test('handler that closes without res.json releases the lock via close event', async () => {
    const store = createInMemoryIdempotencyStore();
    const mw = idempotencyMiddleware({
      store,
      env: { IDEMPOTENCY_ENABLED: 'true' },
      lockTimeoutMs: 1_000,
      lockPollMs: 5,
    });

    const body = { goal: 'streamy' };
    const req1 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-cl' }, body });
    const res1 = fakeRes();
    await mw(req1, res1, fakeNext());
    // simulate connection close without body capture
    res1._emit('close');

    const req2 = fakeReq({ user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-cl' }, body: { ...body } });
    const res2 = fakeRes();
    const next2 = fakeNext();
    await mw(req2, res2, next2);

    assert.equal(next2.calls(), 1);
    assert.equal(res2._state().headers[REPLAY_HEADER], 'fresh');
  });
});

describe('middleware — store contract for tryAcquire/release', () => {
  test('createInMemoryIdempotencyStore exposes tryAcquire + release', async () => {
    const store = createInMemoryIdempotencyStore({ ttlSeconds: 60 });
    const a = await store.tryAcquire('k', 'h1', 1000);
    assert.equal(a.acquired, true);
    const b = await store.tryAcquire('k', 'h1', 1000);
    assert.equal(b.acquired, false);
    assert.equal(b.existing.state, 'pending');
    assert.equal(b.existing.bodyHash, 'h1');
    await store.release('k');
    const c = await store.tryAcquire('k', 'h2', 1000);
    assert.equal(c.acquired, true);
  });

  test('release does NOT delete final entries — only pending locks', async () => {
    const store = createInMemoryIdempotencyStore({ ttlSeconds: 60 });
    await store.put('k', { state: 'final', status: 200, body: { ok: 1 }, headers: {}, bodyHash: null });
    await store.release('k');
    const got = await store.get('k');
    assert.equal(got.state, 'final');
  });
});
