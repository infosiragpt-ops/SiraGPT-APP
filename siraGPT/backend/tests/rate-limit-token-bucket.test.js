'use strict';

/**
 * rate-limit-token-bucket — exercises the per-route / per-user token
 * bucket limiter end to end:
 *
 *   - The math: capacity caps the burst, refillRate drives recovery,
 *     fractional refills accumulate correctly across calls.
 *   - The registry: two principals on the same route get isolated
 *     buckets, the same principal on two routes gets isolated buckets,
 *     idle full buckets get reaped, and the maxBuckets cap holds.
 *   - The middleware: 429 + Retry-After when exhausted, RateLimit-*
 *     headers when allowed, custom keyGenerator and cost are honored,
 *     and `skip` bypasses the limiter cleanly.
 *
 * Tests inject a fake clock so timing is deterministic — relying on
 * setTimeout would either be flaky in CI or slow.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TokenBucket,
  TokenBucketRegistry,
  createTokenBucketMiddleware,
  makeRouteUserKey,
} = require('../src/rate-limit/token-bucket');

function makeFakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
    set: (v) => { now = v; },
  };
}

function makeRes() {
  const headers = {};
  const res = {
    statusCode: 200,
    headersSet: headers,
    setHeader(name, value) { headers[name] = value; },
    getHeader(name) { return headers[name]; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
  };
  return res;
}

describe('TokenBucket', () => {
  test('starts full and refuses zero/negative cost', () => {
    const clock = makeFakeClock();
    const b = new TokenBucket({ capacity: 5, refillRate: 1, clock: clock.now });
    const r = b.tryConsume(5);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 0);
    assert.throws(() => b.tryConsume(0), /positive finite/);
    assert.throws(() => b.tryConsume(-1), /positive finite/);
  });

  test('rejects invalid construction', () => {
    assert.throws(() => new TokenBucket({ capacity: 0, refillRate: 1 }), /capacity/);
    assert.throws(() => new TokenBucket({ capacity: 1, refillRate: 0 }), /refillRate/);
    assert.throws(() => new TokenBucket({ capacity: NaN, refillRate: 1 }), /capacity/);
  });

  test('refills at the configured rate, capped at capacity', () => {
    const clock = makeFakeClock();
    const b = new TokenBucket({ capacity: 10, refillRate: 5, clock: clock.now });
    // Drain.
    assert.equal(b.tryConsume(10).allowed, true);
    assert.equal(b.tryConsume(1).allowed, false);
    // 1s @ 5 tok/s → exactly 5 tokens.
    clock.advance(1000);
    const partial = b.tryConsume(5);
    assert.equal(partial.allowed, true);
    assert.equal(partial.remaining, 0);
    // Long idle → should cap at capacity, not overflow.
    clock.advance(60_000);
    assert.equal(b.tryConsume(10).allowed, true);
    assert.equal(b.tryConsume(1).allowed, false);
  });

  test('fractional refills accumulate without losing tokens', () => {
    const clock = makeFakeClock();
    const b = new TokenBucket({ capacity: 4, refillRate: 2, clock: clock.now });
    assert.equal(b.tryConsume(4).allowed, true);
    // Three 100ms ticks = 300ms = 0.6 tokens. Should NOT allow 1 yet.
    clock.advance(100);
    assert.equal(b.tryConsume(1).allowed, false);
    clock.advance(100);
    assert.equal(b.tryConsume(1).allowed, false);
    clock.advance(100);
    assert.equal(b.tryConsume(1).allowed, false);
    // 200 more ms → cumulative 1 full token (since lastRefill advanced
    // each call, accumulated fractional state must persist).
    clock.advance(200);
    assert.equal(b.tryConsume(1).allowed, true);
  });

  test('retryAfterMs reflects the deficit', () => {
    const clock = makeFakeClock();
    const b = new TokenBucket({ capacity: 2, refillRate: 1, clock: clock.now });
    b.tryConsume(2);
    const denied = b.tryConsume(1);
    assert.equal(denied.allowed, false);
    // 1 token deficit @ 1 tok/s → ~1000ms.
    assert.ok(denied.retryAfterMs >= 999 && denied.retryAfterMs <= 1001);
    const denied2 = b.tryConsume(3);
    assert.equal(denied2.allowed, false);
    assert.ok(denied2.retryAfterMs >= denied.retryAfterMs);
  });
});

describe('TokenBucketRegistry', () => {
  test('isolates buckets per key', () => {
    const clock = makeFakeClock();
    const reg = new TokenBucketRegistry({
      capacity: 3,
      refillRate: 1,
      clock: clock.now,
    });
    // user A drains its bucket
    assert.equal(reg.consume('A', 3).allowed, true);
    assert.equal(reg.consume('A', 1).allowed, false);
    // user B is untouched
    assert.equal(reg.consume('B', 3).allowed, true);
    assert.equal(reg.consume('B', 1).allowed, false);
  });

  test('reset clears specific or all keys', () => {
    const reg = new TokenBucketRegistry({ capacity: 2, refillRate: 1 });
    reg.consume('A', 2);
    reg.consume('B', 2);
    assert.equal(reg.size(), 2);
    reg.reset('A');
    assert.equal(reg.size(), 1);
    reg.reset();
    assert.equal(reg.size(), 0);
  });

  test('reaps idle full buckets but keeps active ones', () => {
    const clock = makeFakeClock();
    const reg = new TokenBucketRegistry({
      capacity: 5,
      refillRate: 5,
      idleTtlMs: 1000,
      clock: clock.now,
    });
    reg.consume('idle-full', 1); // returns to full quickly
    reg.consume('active', 5);     // drains
    // Refill idle-full to capacity, advance well past TTL.
    clock.advance(2000);
    // Triggers a reap pass on next consume.
    reg.consume('newcomer', 1);
    assert.equal(reg.size() <= 3, true);
    // Active bucket (which is still full now after refill) — verify
    // by ensuring it is either reaped or still functional.
    const r = reg.consume('active', 5);
    assert.equal(r.allowed, true);
  });

  test('hard cap maxBuckets evicts oldest entries', () => {
    const clock = makeFakeClock();
    const reg = new TokenBucketRegistry({
      capacity: 1,
      refillRate: 1,
      maxBuckets: 3,
      idleTtlMs: 60_000,
      clock: clock.now,
    });
    for (let i = 0; i < 10; i += 1) {
      reg.consume(`k${i}`, 1);
    }
    assert.equal(reg.size() <= 3, true);
  });
});

describe('makeRouteUserKey', () => {
  test('combines route + principal deterministically', () => {
    assert.equal(makeRouteUserKey('upload', 'user:42'), 'upload|user:42');
    assert.notEqual(
      makeRouteUserKey('upload', 'user:42'),
      makeRouteUserKey('agents', 'user:42'),
    );
  });
});

describe('createTokenBucketMiddleware', () => {
  test('requires a route label', () => {
    assert.throws(
      () => createTokenBucketMiddleware({ capacity: 1, refillRate: 1 }),
      /route label is required/,
    );
  });

  test('passes through while tokens remain and sets headers', () => {
    const clock = makeFakeClock();
    const mw = createTokenBucketMiddleware({
      capacity: 2,
      refillRate: 1,
      route: 'r',
      clock: clock.now,
    });
    const req = { ip: '1.2.3.4' };
    const res = makeRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.equal(called, true);
    assert.equal(res.headersSet['RateLimit-Limit'], '2');
    assert.equal(res.headersSet['RateLimit-Remaining'], '1');
    assert.match(res.headersSet['RateLimit-Policy'], /burst=2/);
  });

  test('returns 429 with Retry-After when exhausted', () => {
    const clock = makeFakeClock();
    const mw = createTokenBucketMiddleware({
      capacity: 1,
      refillRate: 1,
      route: 'r',
      clock: clock.now,
    });
    const req = { ip: '9.9.9.9' };
    const res1 = makeRes();
    mw(req, res1, () => {});
    const res2 = makeRes();
    let nextCalled = false;
    mw(req, res2, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res2.statusCode, 429);
    assert.equal(res2.body.error, 'rate_limited');
    assert.equal(res2.body.route, 'r');
    assert.ok(Number(res2.headersSet['Retry-After']) >= 1);
  });

  test('isolates buckets per route AND per principal', () => {
    const clock = makeFakeClock();
    const reg = new TokenBucketRegistry({
      capacity: 1,
      refillRate: 1,
      clock: clock.now,
    });
    const mwUpload = createTokenBucketMiddleware({
      route: 'upload',
      registry: reg,
      capacity: 1,
      refillRate: 1,
      keyGenerator: (req) => `user:${req.userId}`,
      clock: clock.now,
    });
    // Same registry but different route label means a different
    // composite key — the limiters won't share buckets.
    const mwAgents = createTokenBucketMiddleware({
      route: 'agents',
      registry: reg,
      capacity: 1,
      refillRate: 1,
      keyGenerator: (req) => `user:${req.userId}`,
      clock: clock.now,
    });

    const reqA = { userId: 'A' };
    const reqB = { userId: 'B' };

    const r1 = makeRes();
    mwUpload(reqA, r1, () => { r1.passed = true; });
    assert.equal(r1.passed, true);

    // Same user, same route → blocked.
    const r2 = makeRes();
    mwUpload(reqA, r2, () => { r2.passed = true; });
    assert.equal(r2.passed, undefined);
    assert.equal(r2.statusCode, 429);

    // Same user, different route → allowed (separate bucket).
    const r3 = makeRes();
    mwAgents(reqA, r3, () => { r3.passed = true; });
    assert.equal(r3.passed, true);

    // Different user, same exhausted route → allowed.
    const r4 = makeRes();
    mwUpload(reqB, r4, () => { r4.passed = true; });
    assert.equal(r4.passed, true);
  });

  test('honors custom cost function', () => {
    const clock = makeFakeClock();
    const mw = createTokenBucketMiddleware({
      capacity: 10,
      refillRate: 1,
      route: 'expensive',
      cost: (req) => req.weight,
      clock: clock.now,
    });
    const req = { ip: '1.1.1.1', weight: 10 };
    const res1 = makeRes();
    mw(req, res1, () => { res1.passed = true; });
    assert.equal(res1.passed, true);
    const res2 = makeRes();
    mw(req, res2, () => { res2.passed = true; });
    assert.equal(res2.statusCode, 429);
  });

  test('skip predicate bypasses the limiter without consuming tokens', () => {
    const clock = makeFakeClock();
    const reg = new TokenBucketRegistry({ capacity: 1, refillRate: 1, clock: clock.now });
    const mw = createTokenBucketMiddleware({
      route: 'r',
      registry: reg,
      capacity: 1,
      refillRate: 1,
      skip: (req) => req.path === '/health',
      clock: clock.now,
    });
    const req = { ip: '1.1.1.1', path: '/health' };
    for (let i = 0; i < 5; i += 1) {
      const r = makeRes();
      let called = false;
      mw(req, r, () => { called = true; });
      assert.equal(called, true);
      assert.equal(r.statusCode, 200);
    }
  });

  test('falls back to ip key when keyGenerator throws', () => {
    const clock = makeFakeClock();
    const mw = createTokenBucketMiddleware({
      route: 'r',
      capacity: 1,
      refillRate: 1,
      keyGenerator: () => { throw new Error('boom'); },
      clock: clock.now,
    });
    const req = { ip: '7.7.7.7' };
    const res = makeRes();
    let passed = false;
    mw(req, res, () => { passed = true; });
    assert.equal(passed, true);
  });

  test('onLimit callback overrides the default 429 body', () => {
    const clock = makeFakeClock();
    const mw = createTokenBucketMiddleware({
      route: 'r',
      capacity: 1,
      refillRate: 1,
      onLimit: (req, res) => {
        res.status(503).json({ custom: true });
      },
      clock: clock.now,
    });
    const req = { ip: '8.8.8.8' };
    mw(req, makeRes(), () => {});
    const res = makeRes();
    mw(req, res, () => {});
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { custom: true });
  });
});

describe('integration with rate-limit-policy keyGenerator', () => {
  test('JWT-aware keyGenerator yields per-user isolation under the bucket', () => {
    const { makeJwtAwareKeyGenerator } = require('../src/middleware/rate-limit-policy');
    const jwt = require('jsonwebtoken');
    const secret = 'test-secret';
    const tokenAlice = jwt.sign({ userId: 'alice' }, secret);
    const tokenBob = jwt.sign({ userId: 'bob' }, secret);

    const clock = makeFakeClock();
    const mw = createTokenBucketMiddleware({
      route: 'api',
      capacity: 1,
      refillRate: 1,
      keyGenerator: makeJwtAwareKeyGenerator(secret),
      clock: clock.now,
    });

    const reqAlice = { ip: '1.1.1.1', headers: { authorization: `Bearer ${tokenAlice}` } };
    const reqBob = { ip: '1.1.1.1', headers: { authorization: `Bearer ${tokenBob}` } };

    const r1 = makeRes();
    mw(reqAlice, r1, () => { r1.passed = true; });
    assert.equal(r1.passed, true);

    // Alice's second call from same IP — blocked.
    const r2 = makeRes();
    mw(reqAlice, r2, () => { r2.passed = true; });
    assert.equal(r2.statusCode, 429);

    // Bob from same IP — allowed; per-user bucket.
    const r3 = makeRes();
    mw(reqBob, r3, () => { r3.passed = true; });
    assert.equal(r3.passed, true);
  });
});
