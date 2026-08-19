'use strict';

/**
 * Tests for cycle-45 additions to /api/orgs:
 *   - response-cache `invalidate()` helper
 *   - members-cache invalidation wiring on the orgs router
 *   - GET /:id/usage-trend handler (30-day daily aggregation from
 *     the in-memory cost-tracker, filtered by current org members).
 *
 * Pure unit tests: drive the exported handlers / helpers directly with
 * fakes; no express bind / prisma client required.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const orgsRouter = require('../src/routes/orgs');
const {
  LRUCache,
  responseCache,
  invalidate,
} = require('../src/middleware/response-cache');

// ─── response-cache invalidate() ────────────────────────────────────
test('invalidate({namespace, contains}) removes matching keys only', () => {
  const cache = new LRUCache(10);
  cache.set('org-members::u1::GET::/api/orgs/A/members', { body: '1', expiresAt: Date.now() + 1e9 });
  cache.set('org-members::u2::GET::/api/orgs/A/members', { body: '2', expiresAt: Date.now() + 1e9 });
  cache.set('org-members::u1::GET::/api/orgs/B/members', { body: '3', expiresAt: Date.now() + 1e9 });
  cache.set('other-ns::u1::GET::/api/orgs/A/members', { body: '4', expiresAt: Date.now() + 1e9 });

  const removed = invalidate(
    { namespace: 'org-members', contains: '/orgs/A/members' },
    cache,
  );
  assert.equal(removed, 2);
  assert.equal(cache.size, 2);
  assert.equal(cache.map.has('org-members::u1::GET::/api/orgs/B/members'), true);
  assert.equal(cache.map.has('other-ns::u1::GET::/api/orgs/A/members'), true);
});

test('invalidate(predicate fn) supports custom matching', () => {
  const cache = new LRUCache(10);
  cache.set('a', { expiresAt: Date.now() + 1e9 });
  cache.set('b', { expiresAt: Date.now() + 1e9 });
  cache.set('c', { expiresAt: Date.now() + 1e9 });
  const removed = invalidate((k) => k === 'b', cache);
  assert.equal(removed, 1);
  assert.equal(cache.size, 2);
});

test('invalidate(string) treats argument as substring', () => {
  const cache = new LRUCache(10);
  cache.set('foo-bar', { expiresAt: Date.now() + 1e9 });
  cache.set('baz', { expiresAt: Date.now() + 1e9 });
  const removed = invalidate('bar', cache);
  assert.equal(removed, 1);
  assert.equal(cache.size, 1);
});

test('invalidate ignores invalid matcher safely', () => {
  const cache = new LRUCache(10);
  cache.set('x', { expiresAt: Date.now() + 1e9 });
  assert.equal(invalidate(null, cache), 0);
  assert.equal(invalidate(123, cache), 0);
  assert.equal(cache.size, 1);
});

// ─── members cache: end-to-end through the middleware ──────────────
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
    status(code) { state.statusCode = code; return res; },
    json(obj) {
      if (!headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8';
      return res.end(JSON.stringify(obj));
    },
    send(body) { return res.end(body); },
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
      setImmediate(() => resolve());
    });
    const tick = setInterval(() => {
      if (res._ended) { clearInterval(tick); resolve(); }
    }, 1);
    setTimeout(() => { clearInterval(tick); resolve(); }, 200);
  });
}

test('members cache: MISS → HIT, then invalidate forces MISS', async () => {
  const cache = new LRUCache(50);
  const mw = responseCache({ cache, ttlMs: 15_000, namespace: 'org-members' });
  const url = '/api/orgs/ORG1/members';

  // First call — MISS, handler runs.
  let calls = 0;
  await runMw(mw, makeReq({ user: { id: 'u1' }, url, originalUrl: url }), makeRes(),
    (_q, r) => { calls += 1; r.status(200).json({ items: [] }); });
  assert.equal(calls, 1);

  // Second call — HIT, handler skipped.
  await runMw(mw, makeReq({ user: { id: 'u1' }, url, originalUrl: url }), makeRes(),
    (_q, r) => { calls += 1; r.status(200).json({ items: [] }); });
  assert.equal(calls, 1);

  // Invalidate for ORG1 — affects every user that cached this org.
  const removed = invalidate({ namespace: 'org-members', contains: '/orgs/ORG1/members' }, cache);
  assert.ok(removed >= 1);

  // Third call — MISS again.
  await runMw(mw, makeReq({ user: { id: 'u1' }, url, originalUrl: url }), makeRes(),
    (_q, r) => { calls += 1; r.status(200).json({ items: [] }); });
  assert.equal(calls, 2);
});

test('members cache: invalidation is org-scoped (other orgs survive)', async () => {
  const cache = new LRUCache(50);
  const mw = responseCache({ cache, ttlMs: 15_000, namespace: 'org-members' });

  let callsA = 0;
  let callsB = 0;
  const urlA = '/api/orgs/A/members';
  const urlB = '/api/orgs/B/members';
  await runMw(mw, makeReq({ user: { id: 'u' }, url: urlA, originalUrl: urlA }), makeRes(),
    (_q, r) => { callsA += 1; r.status(200).json({ a: 1 }); });
  await runMw(mw, makeReq({ user: { id: 'u' }, url: urlB, originalUrl: urlB }), makeRes(),
    (_q, r) => { callsB += 1; r.status(200).json({ b: 1 }); });

  invalidate({ namespace: 'org-members', contains: '/orgs/A/members' }, cache);

  // A re-executes, B still HIT.
  await runMw(mw, makeReq({ user: { id: 'u' }, url: urlA, originalUrl: urlA }), makeRes(),
    (_q, r) => { callsA += 1; r.status(200).json({ a: 1 }); });
  await runMw(mw, makeReq({ user: { id: 'u' }, url: urlB, originalUrl: urlB }), makeRes(),
    (_q, r) => { callsB += 1; r.status(200).json({ b: 1 }); });
  assert.equal(callsA, 2);
  assert.equal(callsB, 1);
});

// ─── usage-trend handler ───────────────────────────────────────────
const { usageTrend } = orgsRouter.__handlers;

function fakePrisma({ memberIds = [], assertOk = true } = {}) {
  return {
    orgMembership: {
      findMany: async () => memberIds.map((id) => ({ userId: id })),
      // assertMembership reads from here too — return an OK row when asked.
      findUnique: async () => (assertOk ? { role: 'MEMBER' } : null),
    },
  };
}

function fakeTracker(records) {
  return {
    report: () => ({ records, totals: {}, perUser: [], perModel: [] }),
  };
}

function captureRes() {
  const out = { status: 200, body: null };
  return {
    out,
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
  };
}

test('usage-trend: returns 30 daily buckets with zeros when no records', async () => {
  const req = { user: { id: 'u1' }, params: { id: 'ORG1' } };
  const res = captureRes();
  await usageTrend(req, res, {
    prisma: fakePrisma({ memberIds: ['u1', 'u2'] }),
    costTracker: fakeTracker([]),
  });
  assert.equal(res.out.status, 200);
  assert.equal(res.out.body.orgId, 'ORG1');
  assert.equal(Array.isArray(res.out.body.days), true);
  assert.equal(res.out.body.days.length, 30);
  for (const d of res.out.body.days) {
    assert.equal(typeof d.date, 'string');
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(d.tokens, 0);
    assert.equal(d.costUSD, 0);
    assert.equal(d.requests, 0);
  }
  // Ascending order.
  const sorted = [...res.out.body.days].map((d) => d.date).sort();
  assert.deepEqual(res.out.body.days.map((d) => d.date), sorted);
});

test('usage-trend: only counts records from current org members', async () => {
  const today = new Date();
  const records = [
    // org member — counted
    { ts: today.toISOString(), userId: 'u1', inputTokens: 100, outputTokens: 50, costUSD: 0.01 },
    // non-member — ignored
    { ts: today.toISOString(), userId: 'stranger', inputTokens: 999, outputTokens: 999, costUSD: 9.99 },
    // another member — counted
    { ts: today.toISOString(), userId: 'u2', inputTokens: 20, outputTokens: 10, costUSD: 0.002 },
  ];
  const req = { user: { id: 'u1' }, params: { id: 'ORG1' } };
  const res = captureRes();
  await usageTrend(req, res, {
    prisma: fakePrisma({ memberIds: ['u1', 'u2'] }),
    costTracker: fakeTracker(records),
  });
  const todayKey = res.out.body.days[res.out.body.days.length - 1].date;
  const todayBucket = res.out.body.days.find((d) => d.date === todayKey);
  assert.equal(todayBucket.tokens, 100 + 50 + 20 + 10);
  assert.equal(todayBucket.requests, 2);
  // 0.01 + 0.002 = 0.012 (rounded to 6 decimals)
  assert.ok(Math.abs(todayBucket.costUSD - 0.012) < 1e-9);
});

test('usage-trend: drops records outside the 30-day window', async () => {
  const today = new Date();
  const longAgo = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
  const records = [
    { ts: longAgo.toISOString(), userId: 'u1', inputTokens: 9999, outputTokens: 9999, costUSD: 99.99 },
  ];
  const res = captureRes();
  await usageTrend(
    { user: { id: 'u1' }, params: { id: 'ORG1' } },
    res,
    {
      prisma: fakePrisma({ memberIds: ['u1'] }),
      costTracker: fakeTracker(records),
    },
  );
  for (const d of res.out.body.days) {
    assert.equal(d.tokens, 0);
    assert.equal(d.requests, 0);
    assert.equal(d.costUSD, 0);
  }
});

test('usage-trend: empty member list yields all-zero rows', async () => {
  const res = captureRes();
  await usageTrend(
    { user: { id: 'u1' }, params: { id: 'ORG1' } },
    res,
    {
      prisma: {
        orgMembership: {
          // assertMembership succeeds (user is a viewer), but the listing
          // for trend computation returns no rows.
          findUnique: async () => ({ role: 'MEMBER' }),
          findMany: async () => [],
        },
      },
      costTracker: fakeTracker([
        { ts: new Date().toISOString(), userId: 'u1', inputTokens: 100, outputTokens: 100, costUSD: 1 },
      ]),
    },
  );
  assert.equal(res.out.body.days.length, 30);
  assert.equal(res.out.body.days.every((d) => d.tokens === 0 && d.requests === 0), true);
});

test('usage-trend: non-member caller is rejected', async () => {
  const res = captureRes();
  await usageTrend(
    { user: { id: 'intruder' }, params: { id: 'ORG1' } },
    res,
    {
      prisma: {
        orgMembership: {
          findUnique: async () => null, // no membership row
          findMany: async () => [],
        },
      },
      costTracker: fakeTracker([]),
    },
  );
  // assertMembership throws err.status 403/404; usage-trend forwards it.
  assert.ok(res.out.status >= 400 && res.out.status < 500);
  assert.ok(res.out.body && typeof res.out.body.error === 'string');
});

// ─── exported __invalidateMembersCache helper ──────────────────────
test('__invalidateMembersCache exists and is a function', () => {
  assert.equal(typeof orgsRouter.__invalidateMembersCache, 'function');
  // Calling with empty orgId is a no-op returning 0.
  assert.equal(orgsRouter.__invalidateMembersCache(''), 0);
  assert.equal(orgsRouter.__invalidateMembersCache(null), 0);
});
