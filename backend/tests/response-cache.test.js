'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  responseCache,
  LRUCache,
  clearCache,
} = require('../src/middleware/response-cache');

function makeReq(opts = {}) {
  return {
    method: opts.method || 'GET',
    url: opts.url || '/test',
    originalUrl: opts.originalUrl || opts.url || '/test',
    headers: opts.headers || {},
    user: opts.user,
  };
}

function makeRes() {
  const headers = {};
  const state = { statusCode: 200, ended: false, body: null };
  const res = {
    get statusCode() { return state.statusCode; },
    set statusCode(v) { state.statusCode = v; },
    setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return headers[String(name).toLowerCase()]; },
    removeHeader(name) { delete headers[String(name).toLowerCase()]; },
    status(code) { state.statusCode = code; return res; },
    json(obj) {
      if (!headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8';
      const str = JSON.stringify(obj);
      return res.end(str);
    },
    send(body) {
      return res.end(body);
    },
    end(chunk) {
      if (chunk != null) state.body = chunk;
      state.ended = true;
      return res;
    },
    get _headers() { return headers; },
    get _body() { return state.body; },
    get _ended() { return state.ended; },
  };
  return res;
}

function runMw(mw, req, res, handler) {
  return new Promise((resolve) => {
    mw(req, res, () => {
      if (handler) handler(req, res);
      // Give async paths a tick
      setImmediate(() => resolve());
    });
    // If middleware short-circuits (HIT), it never calls next; resolve when ended.
    const tick = setInterval(() => {
      if (res._ended) { clearInterval(tick); resolve(); }
    }, 1);
    setTimeout(() => { clearInterval(tick); resolve(); }, 200);
  });
}

test('responseCache: MISS then HIT for same user', async () => {
  const cache = new LRUCache(10);
  const mw = responseCache({ cache, ttlMs: 60_000, namespace: 'test1' });
  const req1 = makeReq({ user: { id: 'u1' } });
  const res1 = makeRes();
  await runMw(mw, req1, res1, (_q, r) => r.status(200).json({ a: 1 }));
  assert.equal(res1._headers['x-cache'], 'MISS');

  const req2 = makeReq({ user: { id: 'u1' } });
  const res2 = makeRes();
  let handlerCalled = false;
  await runMw(mw, req2, res2, () => { handlerCalled = true; });
  assert.equal(res2._headers['x-cache'], 'HIT');
  assert.equal(handlerCalled, false, 'handler should not run on HIT');
  assert.equal(res2._body, JSON.stringify({ a: 1 }));
});

test('responseCache: per-user isolation', async () => {
  const cache = new LRUCache(10);
  const mw = responseCache({ cache, ttlMs: 60_000, namespace: 'iso' });

  const r1 = makeReq({ user: { id: 'alice' } });
  const s1 = makeRes();
  await runMw(mw, r1, s1, (_q, r) => r.status(200).json({ user: 'alice' }));

  const r2 = makeReq({ user: { id: 'bob' } });
  const s2 = makeRes();
  let bobHandled = false;
  await runMw(mw, r2, s2, (_q, r) => { bobHandled = true; r.status(200).json({ user: 'bob' }); });
  assert.equal(s2._headers['x-cache'], 'MISS');
  assert.equal(bobHandled, true);

  const r3 = makeReq({ user: { id: 'alice' } });
  const s3 = makeRes();
  await runMw(mw, r3, s3);
  assert.equal(s3._headers['x-cache'], 'HIT');
  assert.equal(s3._body, JSON.stringify({ user: 'alice' }));
});

test('responseCache: TTL expiry serves MISS again', async () => {
  const cache = new LRUCache(10);
  let t = 1000;
  const mw = responseCache({ cache, ttlMs: 100, namespace: 'ttl', now: () => t });
  const req1 = makeReq({ user: { id: 'u' } });
  const res1 = makeRes();
  await runMw(mw, req1, res1, (_q, r) => r.status(200).json({ ok: true }));
  assert.equal(res1._headers['x-cache'], 'MISS');

  // Within TTL
  t = 1050;
  const res2 = makeRes();
  await runMw(mw, makeReq({ user: { id: 'u' } }), res2);
  assert.equal(res2._headers['x-cache'], 'HIT');

  // After TTL
  t = 2000;
  const res3 = makeRes();
  let handled = false;
  await runMw(mw, makeReq({ user: { id: 'u' } }), res3, (_q, r) => { handled = true; r.status(200).json({ ok: true }); });
  assert.equal(res3._headers['x-cache'], 'MISS');
  assert.equal(handled, true);
});

test('responseCache: Cache-Control: no-cache bypasses', async () => {
  const cache = new LRUCache(10);
  const mw = responseCache({ cache, ttlMs: 60_000, namespace: 'nc' });

  // Seed cache
  await runMw(mw, makeReq({ user: { id: 'u' } }), makeRes(),
    (_q, r) => r.status(200).json({ v: 1 }));

  // Subsequent no-cache request bypasses cache; handler must run.
  const res2 = makeRes();
  let handled = false;
  await runMw(mw,
    makeReq({ user: { id: 'u' }, headers: { 'cache-control': 'no-cache' } }),
    res2,
    (_q, r) => { handled = true; r.status(200).json({ v: 2 }); }
  );
  assert.equal(res2._headers['x-cache'], 'MISS');
  assert.equal(handled, true);
});

test('responseCache: oversized entries are not cached', async () => {
  const cache = new LRUCache(10);
  const mw = responseCache({ cache, ttlMs: 60_000, namespace: 'big', maxEntryBytes: 64 });
  const big = 'x'.repeat(200);
  await runMw(mw, makeReq({ user: { id: 'u' } }), makeRes(),
    (_q, r) => r.status(200).json({ s: big }));

  const res2 = makeRes();
  let handled = false;
  await runMw(mw, makeReq({ user: { id: 'u' } }), res2,
    (_q, r) => { handled = true; r.status(200).json({ s: big }); });
  assert.equal(res2._headers['x-cache'], 'MISS');
  assert.equal(handled, true, 'oversized entries should re-execute');
});

test('responseCache: LRU evicts oldest beyond max', async () => {
  const cache = new LRUCache(2);
  const mw = responseCache({ cache, ttlMs: 60_000, namespace: 'lru' });

  // Use three distinct paths
  for (const p of ['/a', '/b', '/c']) {
    await runMw(mw,
      makeReq({ user: { id: 'u' }, url: p, originalUrl: p }),
      makeRes(),
      (_q, r) => r.status(200).json({ p })
    );
  }
  assert.equal(cache.size, 2);
  assert.ok(cache.stats.evictions >= 1);

  // /a should have been evicted → MISS again
  const res = makeRes();
  let handled = false;
  await runMw(mw,
    makeReq({ user: { id: 'u' }, url: '/a', originalUrl: '/a' }),
    res,
    (_q, r) => { handled = true; r.status(200).json({ p: '/a' }); }
  );
  assert.equal(handled, true);
  assert.equal(res._headers['x-cache'], 'MISS');
});

test('responseCache: non-200 responses are not cached', async () => {
  const cache = new LRUCache(10);
  const mw = responseCache({ cache, ttlMs: 60_000, namespace: 'err' });

  await runMw(mw, makeReq({ user: { id: 'u' } }), makeRes(),
    (_q, r) => r.status(500).json({ error: 'boom' }));

  const res2 = makeRes();
  let handled = false;
  await runMw(mw, makeReq({ user: { id: 'u' } }), res2,
    (_q, r) => { handled = true; r.status(200).json({ ok: true }); });
  assert.equal(res2._headers['x-cache'], 'MISS');
  assert.equal(handled, true);
});

test('responseCache: non-GET requests bypass entirely', async () => {
  const cache = new LRUCache(10);
  const mw = responseCache({ cache, ttlMs: 60_000, namespace: 'mut' });
  const req = makeReq({ method: 'POST', user: { id: 'u' } });
  const res = makeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.getHeader('x-cache'), undefined);
});

test('clearCache wipes entries', async () => {
  const cache = new LRUCache(10);
  const mw = responseCache({ cache, ttlMs: 60_000, namespace: 'clr' });
  await runMw(mw, makeReq({ user: { id: 'u' } }), makeRes(),
    (_q, r) => r.status(200).json({ v: 1 }));
  assert.equal(cache.size, 1);
  clearCache(cache);
  assert.equal(cache.size, 0);
});
