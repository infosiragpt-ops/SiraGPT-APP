'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RateLimiter,
  defaultLimiter,
  getUserLimiter,
  getEndpointLimiter,
  rateLimitMiddleware,
  ENDPOINT_LIMITS,
} = require('../src/services/rate-limiter');

test('exports the documented surface', () => {
  assert.equal(typeof RateLimiter, 'function');
  assert.ok(defaultLimiter instanceof RateLimiter);
  assert.equal(typeof getUserLimiter, 'function');
  assert.equal(typeof getEndpointLimiter, 'function');
  assert.equal(typeof rateLimitMiddleware, 'function');
  assert.equal(typeof ENDPOINT_LIMITS, 'object');
  assert.ok(Object.keys(ENDPOINT_LIMITS).length > 0);
});

test('RateLimiter allows requests under the limit and returns the remaining count', () => {
  const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 3 });
  const r1 = limiter.check('user-1');
  const r2 = limiter.check('user-1');
  const r3 = limiter.check('user-1');
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 2);
  assert.equal(r2.remaining, 1);
  assert.equal(r3.remaining, 0);
});

test('RateLimiter blocks the request that exceeds the limit', () => {
  const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 2 });
  limiter.check('u');
  limiter.check('u');
  const blocked = limiter.check('u');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterMs > 0);
});

test('RateLimiter isolates buckets per identifier', () => {
  const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 1 });
  const a = limiter.check('user-a');
  const b = limiter.check('user-b');
  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true, 'user-b must not share user-a\'s bucket');
});

test('RateLimiter rolls the window after windowMs elapses', () => {
  const realNow = Date.now;
  try {
    let t = 1_000_000;
    Date.now = () => t;
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    const first = limiter.check('u');
    assert.equal(first.allowed, true);
    const blocked = limiter.check('u');
    assert.equal(blocked.allowed, false);
    t += 1500; // advance past the window
    const recovered = limiter.check('u');
    assert.equal(recovered.allowed, true, 'window should reset and allow the request');
  } finally {
    Date.now = realNow;
  }
});

test('RateLimiter.reset clears the bucket for the identifier', () => {
  const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 1 });
  limiter.check('u');
  const blocked = limiter.check('u');
  assert.equal(blocked.allowed, false);
  limiter.reset('u');
  const recovered = limiter.check('u');
  assert.equal(recovered.allowed, true);
});

test('RateLimiter.getStats reports current bucket state', () => {
  const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 2 });
  assert.deepEqual(limiter.getStats('absent'), { count: 0, blocked: 0, windowStart: null });
  limiter.check('u');
  limiter.check('u');
  limiter.check('u'); // 3rd is blocked
  const s = limiter.getStats('u');
  assert.equal(s.count, 3);
  assert.equal(s.blocked, 1);
  assert.equal(typeof s.windowStart, 'number');
});

test('RateLimiter.cleanup evicts buckets past 2x the window', () => {
  const realNow = Date.now;
  try {
    let t = 1_000_000;
    Date.now = () => t;
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 5 });
    limiter.check('u');
    t += 2500; // past 2x the window
    const cleaned = limiter.cleanup();
    assert.ok(cleaned >= 1);
    assert.deepEqual(limiter.getStats('u'), { count: 0, blocked: 0, windowStart: null });
  } finally {
    Date.now = realNow;
  }
});

test('getUserLimiter returns a per-user singleton', () => {
  const a = getUserLimiter('user-1');
  const b = getUserLimiter('user-1');
  const c = getUserLimiter('user-2');
  assert.equal(a, b, 'same user must return same limiter');
  assert.notEqual(a, c, 'different users must have different limiters');
});

test('getEndpointLimiter returns null for unknown endpoints', () => {
  assert.equal(getEndpointLimiter('/api/nope'), null);
});

test('getEndpointLimiter returns a limiter for endpoints in ENDPOINT_LIMITS', () => {
  const limiter = getEndpointLimiter('/api/ai/generate');
  assert.ok(limiter instanceof RateLimiter);
  // Subsequent calls return the same instance
  assert.equal(getEndpointLimiter('/api/ai/generate'), limiter);
});

test('rateLimitMiddleware sets X-RateLimit-* headers and forwards to next() when allowed', () => {
  const mw = rateLimitMiddleware({ windowMs: 60_000, maxRequests: 5 });
  const req = { user: { id: 'u' } };
  const headers = {};
  const res = {
    setHeader(name, value) { headers[name] = value; },
    status() { return this; },
    json() { return this; },
  };
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(headers['X-RateLimit-Limit'], '5');
  assert.equal(headers['X-RateLimit-Remaining'], '4');
  assert.ok(headers['X-RateLimit-Reset']);
});

test('rateLimitMiddleware emits 429 + retryAfterMs body when over the limit', () => {
  const mw = rateLimitMiddleware({ windowMs: 60_000, maxRequests: 1 });
  const req = { user: { id: 'u' } };
  const makeRes = () => {
    const headers = {};
    let statusCode = 200, body = null;
    return {
      headers, get statusCode() { return statusCode; }, get body() { return body; },
      setHeader(n, v) { headers[n] = v; },
      status(c) { statusCode = c; return this; },
      json(b) { body = b; return this; },
    };
  };
  // First request allowed
  mw(req, makeRes(), () => {});
  const res = makeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, 'rate_limit_exceeded');
  assert.ok(res.body.retryAfterMs > 0);
  assert.ok(res.headers['Retry-After']);
  assert.equal(nextCalled, false);
});

test('rateLimitMiddleware falls back to req.ip when there is no user, then to "anonymous"', () => {
  const mw = rateLimitMiddleware({ windowMs: 60_000, maxRequests: 100 });
  // No user, but has ip → bucket key includes ip
  const res = { setHeader() {}, status() { return this; }, json() { return this; } };
  let nextCalled = 0;
  mw({ ip: '1.2.3.4' }, res, () => { nextCalled++; });
  mw({}, res, () => { nextCalled++; });
  assert.equal(nextCalled, 2, 'both requests must pass (different bucket keys)');
});
