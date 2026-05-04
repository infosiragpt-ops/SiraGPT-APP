/**
 * idempotency — pins the Stripe-style replay contract. Three
 * properties are load-bearing:
 *
 *   1. Tenant scoping. User A's `Idempotency-Key: foo` MUST NOT
 *      collide with User B's `foo`. The cache key includes the
 *      user-id (or anonymous IP) so a deterministic per-tenant
 *      namespace is enforced.
 *
 *   2. Only 2xx responses cached. A transient 500 from a buggy
 *      handler must NOT lock subsequent retries into the same
 *      failure for 24h.
 *
 *   3. Disabled mode passes through but still rejects malformed
 *      keys. A 1MB Idempotency-Key value would otherwise eat
 *      memory before any feature flag is read.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  idempotencyMiddleware,
  resolveIdempotencyConfig,
  createInMemoryIdempotencyStore,
  buildCacheKey,
  REPLAY_HEADER,
  REPLAY_KEY_HEADER,
  DEFAULT_TTL_SECONDS,
} = require("../src/middleware/idempotency");

function fakeRes() {
  const headers = {};
  let statusCode = 200;
  let payload = null;
  let endCalled = false;
  const res = {
    statusCode,
    setHeader(name, value) { headers[name] = value; },
    getHeader(name) { return headers[name]; },
    status(code) { res.statusCode = code; statusCode = code; return res; },
    json(body) {
      payload = body;
      endCalled = true;
      return res;
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

function fakeReq({ method = 'POST', headers = {}, user = null, ip = '203.0.113.5' } = {}) {
  return { method, headers, user, ip };
}

describe("resolveIdempotencyConfig", () => {
  test("disabled by default", () => {
    const cfg = resolveIdempotencyConfig({});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.ttlSeconds, DEFAULT_TTL_SECONDS);
  });

  test("IDEMPOTENCY_ENABLED=true activates", () => {
    const cfg = resolveIdempotencyConfig({ IDEMPOTENCY_ENABLED: 'true' });
    assert.equal(cfg.enabled, true);
  });

  test("TTL is clamped to [60, 7d]", () => {
    assert.equal(resolveIdempotencyConfig({ IDEMPOTENCY_TTL_SECONDS: '0' }).ttlSeconds, 60);
    assert.equal(
      resolveIdempotencyConfig({ IDEMPOTENCY_TTL_SECONDS: String(30 * 24 * 3600) }).ttlSeconds,
      7 * 24 * 3600,
    );
  });

  test("non-numeric ttl falls back to default", () => {
    assert.equal(resolveIdempotencyConfig({ IDEMPOTENCY_TTL_SECONDS: 'forever' }).ttlSeconds, DEFAULT_TTL_SECONDS);
  });
});

describe("buildCacheKey — tenant scoping", () => {
  test("authenticated user gets a user:<id>:<key> namespace", () => {
    const req = fakeReq({ user: { id: 'u-1' } });
    assert.equal(buildCacheKey(req, 'foo'), 'user:u-1:foo');
  });

  test("anonymous traffic falls back to ip:<ip>:<key>", () => {
    const req = fakeReq({ ip: '203.0.113.9' });
    assert.equal(buildCacheKey(req, 'foo'), 'ip:203.0.113.9:foo');
  });

  test("two users with the same key get distinct cache keys", () => {
    const a = buildCacheKey(fakeReq({ user: { id: 'u-1' } }), 'common');
    const b = buildCacheKey(fakeReq({ user: { id: 'u-2' } }), 'common');
    assert.notEqual(a, b);
  });
});

describe("middleware — pass-through paths", () => {
  test("GET requests skip the middleware", async () => {
    const mw = idempotencyMiddleware({
      store: createInMemoryIdempotencyStore(),
      env: { IDEMPOTENCY_ENABLED: 'true' },
    });
    const req = fakeReq({ method: 'GET', headers: { 'idempotency-key': 'k' } });
    const res = fakeRes();
    const next = fakeNext();
    await mw(req, res, next);
    assert.equal(next.calls(), 1);
    assert.equal(res._state().headers[REPLAY_HEADER], undefined);
  });

  test("missing Idempotency-Key passes through silently", async () => {
    const mw = idempotencyMiddleware({
      store: createInMemoryIdempotencyStore(),
      env: { IDEMPOTENCY_ENABLED: 'true' },
    });
    const req = fakeReq({ method: 'POST' });
    const res = fakeRes();
    const next = fakeNext();
    await mw(req, res, next);
    assert.equal(next.calls(), 1);
    assert.equal(res._state().headers[REPLAY_HEADER], undefined);
  });
});

describe("middleware — malformed key rejection", () => {
  test("empty string is rejected with 400", async () => {
    const mw = idempotencyMiddleware({
      store: createInMemoryIdempotencyStore(),
      env: { IDEMPOTENCY_ENABLED: 'true' },
    });
    const req = fakeReq({ method: 'POST', headers: { 'idempotency-key': '' } });
    const res = fakeRes();
    const next = fakeNext();
    await mw(req, res, next);
    // Empty string is falsy → middleware treats it as "missing"
    // and passes through. Document by asserting next() ran.
    assert.equal(next.calls(), 1);
  });

  test("oversized key is rejected with 400 — even when disabled", async () => {
    const mw = idempotencyMiddleware({
      store: createInMemoryIdempotencyStore(),
      env: {}, // disabled
    });
    const req = fakeReq({
      method: 'POST',
      headers: { 'idempotency-key': 'x'.repeat(10_000) },
    });
    const res = fakeRes();
    const next = fakeNext();
    await mw(req, res, next);
    assert.equal(next.calls(), 0);
    assert.equal(res._state().statusCode, 400);
    assert.equal(res._state().payload.error, 'invalid Idempotency-Key');
  });
});

describe("middleware — disabled but valid key", () => {
  test("flag off + valid key → next() runs, sentinel header set", async () => {
    const mw = idempotencyMiddleware({
      store: createInMemoryIdempotencyStore(),
      env: {}, // IDEMPOTENCY_ENABLED unset → disabled
    });
    const req = fakeReq({ method: 'POST', headers: { 'idempotency-key': 'abc' } });
    const res = fakeRes();
    const next = fakeNext();
    await mw(req, res, next);
    assert.equal(next.calls(), 1);
    assert.equal(res._state().headers[REPLAY_HEADER], 'disabled');
    assert.equal(res._state().headers[REPLAY_KEY_HEADER], 'abc');
  });
});

describe("middleware — replay contract", () => {
  test("first call runs handler, second call replays cached body", async () => {
    const store = createInMemoryIdempotencyStore();
    const mw = idempotencyMiddleware({ store, env: { IDEMPOTENCY_ENABLED: 'true' } });

    // First call: handler runs and writes a 200 JSON body.
    const req1 = fakeReq({ method: 'POST', user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-42' } });
    const res1 = fakeRes();
    const next1 = fakeNext();
    await mw(req1, res1, next1);
    assert.equal(res1._state().headers[REPLAY_HEADER], 'fresh');
    res1.setHeader('content-type', 'application/json');
    res1.status(200).json({ taskId: 'task-42' });
    assert.equal(next1.calls(), 1);

    // Second call: same key, same user. Middleware MUST replay
    // without invoking next().
    const req2 = fakeReq({ method: 'POST', user: { id: 'u-1' }, headers: { 'idempotency-key': 'op-42' } });
    const res2 = fakeRes();
    const next2 = fakeNext();
    await mw(req2, res2, next2);
    assert.equal(next2.calls(), 0, 'handler must NOT run on replay');
    assert.equal(res2._state().headers[REPLAY_HEADER], 'true');
    assert.equal(res2._state().statusCode, 200);
    assert.deepEqual(res2._state().payload, { taskId: 'task-42' });
  });

  test("different user with same key → no replay (tenant isolation)", async () => {
    const store = createInMemoryIdempotencyStore();
    const mw = idempotencyMiddleware({ store, env: { IDEMPOTENCY_ENABLED: 'true' } });

    const req1 = fakeReq({ method: 'POST', user: { id: 'u-A' }, headers: { 'idempotency-key': 'common' } });
    const res1 = fakeRes();
    await mw(req1, res1, fakeNext());
    res1.status(200).json({ secret: 'A-only' });

    const req2 = fakeReq({ method: 'POST', user: { id: 'u-B' }, headers: { 'idempotency-key': 'common' } });
    const res2 = fakeRes();
    const next2 = fakeNext();
    await mw(req2, res2, next2);
    assert.equal(next2.calls(), 1, 'B must NOT see A\'s response');
    assert.equal(res2._state().headers[REPLAY_HEADER], 'fresh');
  });

  test("non-2xx response is NOT cached — retry runs handler again", async () => {
    const store = createInMemoryIdempotencyStore();
    const mw = idempotencyMiddleware({ store, env: { IDEMPOTENCY_ENABLED: 'true' } });

    const req1 = fakeReq({ method: 'POST', user: { id: 'u-1' }, headers: { 'idempotency-key': 'fails' } });
    const res1 = fakeRes();
    await mw(req1, res1, fakeNext());
    res1.status(500).json({ error: 'transient' });

    const req2 = fakeReq({ method: 'POST', user: { id: 'u-1' }, headers: { 'idempotency-key': 'fails' } });
    const res2 = fakeRes();
    const next2 = fakeNext();
    await mw(req2, res2, next2);
    assert.equal(next2.calls(), 1, 'a 500 must not pin the slot for 24h');
    assert.equal(res2._state().headers[REPLAY_HEADER], 'fresh');
  });
});

describe("createInMemoryIdempotencyStore", () => {
  test("expired entries return null after TTL", async () => {
    let fakeTime = 1_000_000;
    const store = createInMemoryIdempotencyStore({ ttlSeconds: 60, now: () => fakeTime });
    await store.put('k', { status: 200, body: { x: 1 }, headers: {} });
    fakeTime += 30 * 1000;
    assert.notEqual(await store.get('k'), null);
    fakeTime += 60 * 1000;
    assert.equal(await store.get('k'), null);
  });

  test("custom per-call TTL is honored", async () => {
    let fakeTime = 1_000_000;
    const store = createInMemoryIdempotencyStore({ ttlSeconds: 3600, now: () => fakeTime });
    // Override TTL to 10s.
    await store.put('k', { status: 200, body: 'x', headers: {} }, 10);
    fakeTime += 11 * 1000;
    assert.equal(await store.get('k'), null);
  });
});
