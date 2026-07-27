'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let billingRateLimit;
let loadError;
try {
  billingRateLimit = require('../src/middleware/billing-rate-limit');
} catch (error) {
  loadError = error;
}

test('billing rate-limit middleware exposes a dedicated factory', () => {
  assert.ifError(loadError);
  assert.equal(typeof billingRateLimit.makeBillingRateLimit, 'function');
});

test('billing limiter exposes its action namespace for route inventory checks', () => {
  const middleware = billingRateLimit.makeBillingRateLimit({
    name: 'checkout-stripe',
    limit: 1,
    ipLimit: 10,
    windowMs: 1000,
    store: { consumeMany: async () => ({ allowed: true, remaining: 0, resetAt: new Date() }) },
    env: { NODE_ENV: 'test', RATE_LIMIT_SENSITIVE_POLICY: 'memory' },
  });
  assert.equal(middleware.rateLimitAction, 'checkout-stripe');
  assert.equal(middleware.rateLimitUserLimit, 1);
  assert.equal(middleware.rateLimitIpLimit, 10);
});

test('billing IP normalization groups IPv6 /64 networks and canonicalizes IPv4', () => {
  assert.equal(typeof billingRateLimit.normalizeBillingIp, 'function');
  assert.equal(
    billingRateLimit.normalizeBillingIp('2001:0db8:abcd:0012::1'),
    '2001:db8:abcd:12::/64',
  );
  assert.equal(
    billingRateLimit.normalizeBillingIp('2001:db8:abcd:12:ffff::99'),
    '2001:db8:abcd:12::/64',
  );
  assert.equal(
    billingRateLimit.normalizeBillingIp('2001:db8:abcd:13::1'),
    '2001:db8:abcd:13::/64',
  );
  assert.equal(billingRateLimit.normalizeBillingIp('::ffff:203.0.113.5'), '203.0.113.5');
  assert.equal(billingRateLimit.normalizeBillingIp('203.0.113.5'), '203.0.113.5');
  assert.equal(billingRateLimit.normalizeBillingIp('203.000.113.005'), 'unknown');
  assert.equal(billingRateLimit.normalizeBillingIp('not-an-ip'), 'unknown');
});

function makeReq(overrides = {}) {
  return {
    method: 'POST',
    ip: '203.0.113.5',
    headers: {},
    user: { id: 'user_1' },
    requestId: 'req_billing_1',
    ...overrides,
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    getHeader(name) { return this.headers[name]; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('billing limiter consumes independent user and IP buckets with distributed production semantics', async () => {
  const calls = [];
  const env = {
    NODE_ENV: 'production',
    REDIS_URL: 'redis://redis.internal:6379',
  };
  const store = {
    async consumeMany(keys, limit, windowMs, options) {
      calls.push({ keys, limit, windowMs, options });
      return {
        allowed: true,
        remaining: 2,
        resetAt: new Date(Date.now() + 60_000),
      };
    },
  };
  const middleware = billingRateLimit.makeBillingRateLimit({
    name: 'checkout',
    limit: 3,
    ipLimit: 30,
    windowMs: 60_000,
    store,
    env,
  });
  const res = makeRes();
  let nextCalls = 0;

  await middleware(makeReq(), res, () => { nextCalls += 1; });

  assert.equal(nextCalls, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].keys, [
    'billingrl:checkout:user:user_1',
    'billingrl:checkout:ip:203.0.113.5',
  ]);
  assert.equal(calls[0].limit, 3);
  assert.equal(calls[0].windowMs, 60_000);
  assert.deepEqual(calls[0].options.limits, [3, 30]);
  assert.equal(calls[0].options.requireDistributed, true);
  assert.equal(calls[0].options.env, env);
  assert.equal(res.getHeader('RateLimit-Limit'), '3');
  assert.equal(res.getHeader('RateLimit-Remaining'), '2');
});

test('billing limiter returns a no-store 429 when either user or IP budget is exhausted', async () => {
  let calls = 0;
  const store = {
    async consumeMany() {
      calls += 1;
      return { allowed: false, remaining: 0, resetAt: new Date(Date.now() + 20_000) };
    },
  };
  const middleware = billingRateLimit.makeBillingRateLimit({
    name: 'plan-change',
    limit: 2,
    windowMs: 60_000,
    store,
    env: {
      NODE_ENV: 'test',
      RATE_LIMIT_STORE: 'memory',
      RATE_LIMIT_SENSITIVE_POLICY: 'memory',
    },
  });
  const res = makeRes();
  let nextCalls = 0;

  await middleware(makeReq(), res, () => { nextCalls += 1; });

  assert.equal(nextCalls, 0);
  assert.equal(calls, 1);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'billing_rate_limited');
  assert.equal(res.getHeader('Cache-Control'), 'no-store');
  assert.equal(res.getHeader('X-Content-Type-Options'), 'nosniff');
  assert.ok(Number(res.getHeader('Retry-After')) >= 1);
});

test('billing limiter returns a value-free no-store 503 when the production store fails', async () => {
  const store = {
    async consumeMany() {
      throw new Error('redis://user:secret@redis.internal unavailable');
    },
  };
  const middleware = billingRateLimit.makeBillingRateLimit({
    name: 'refund',
    limit: 2,
    windowMs: 60_000,
    store,
    env: {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://user:secret@redis.internal:6379',
    },
  });
  const res = makeRes();
  let nextCalls = 0;

  await middleware(makeReq(), res, () => { nextCalls += 1; });

  assert.equal(nextCalls, 0);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'RATE_LIMIT_STORE_UNAVAILABLE');
  assert.equal(res.body.requestId, 'req_billing_1');
  assert.equal(res.getHeader('Cache-Control'), 'no-store');
  assert.equal(res.getHeader('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.getHeader('Retry-After'), '5');
  assert.doesNotMatch(JSON.stringify(res.body), /user|secret|redis\.internal/i);
});

test('billing limiter preserves explicit local memory mode', async () => {
  const calls = [];
  const store = {
    async consumeMany(_keys, _limit, _windowMs, options) {
      calls.push(options);
      return {
        allowed: true,
        remaining: 1,
        resetAt: new Date(Date.now() + 60_000),
      };
    },
  };
  const middleware = billingRateLimit.makeBillingRateLimit({
    name: 'verify',
    limit: 2,
    windowMs: 60_000,
    store,
    env: {
      NODE_ENV: 'test',
      RATE_LIMIT_STORE: 'memory',
      RATE_LIMIT_SENSITIVE_POLICY: 'memory',
    },
  });
  let nextCalls = 0;

  await middleware(makeReq(), makeRes(), () => { nextCalls += 1; });

  assert.equal(nextCalls, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls.every((options) => options.requireDistributed === false), true);
  assert.equal(calls.every((options) => options.env.RATE_LIMIT_STORE === 'memory'), true);
});

test('billing limiter does not partially burn the user bucket when the IP bucket is denied', async () => {
  const env = {
    NODE_ENV: 'test',
    RATE_LIMIT_STORE: 'memory',
    RATE_LIMIT_SENSITIVE_POLICY: 'memory',
  };
  const sharedStore = require('../src/middleware/rate-limit-store');
  sharedStore._resetForTests();
  await sharedStore.consume('billingrl:atomic:ip:203.0.113.5', 1, 60_000, { env });
  const middleware = billingRateLimit.makeBillingRateLimit({
    name: 'atomic',
    limit: 1,
    ipLimit: 1,
    windowMs: 60_000,
    store: sharedStore,
    env,
  });
  const res = makeRes();

  await middleware(makeReq(), res, () => assert.fail('full IP bucket must deny'));

  assert.equal(res.statusCode, 429);
  const userAfterDenial = await sharedStore.consume(
    'billingrl:atomic:user:user_1',
    1,
    60_000,
    { env },
  );
  assert.equal(userAfterDenial.allowed, true);
});

test('billing limiter uses the store breaker Retry-After in literal production', async () => {
  const store = {
    async consumeMany() {
      const error = new Error('private store detail');
      error.retryAfterSeconds = 29;
      throw error;
    },
  };
  const middleware = billingRateLimit.makeBillingRateLimit({
    name: 'refund',
    limit: 2,
    windowMs: 60_000,
    store,
    env: {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://mock',
      RATE_LIMIT_STORE_RETRY_AFTER_SECONDS: '5',
    },
  });
  const res = makeRes();

  await middleware(makeReq(), res, () => assert.fail('must fail closed'));

  assert.equal(res.statusCode, 503);
  assert.equal(res.getHeader('Retry-After'), '29');
  assert.equal(res.body.retryAfterSec, 29);
});

test('billing limiter permits many users behind one shared IP up to the higher IP ceiling', async () => {
  const env = {
    NODE_ENV: 'test',
    RATE_LIMIT_STORE: 'memory',
    RATE_LIMIT_SENSITIVE_POLICY: 'memory',
  };
  const sharedStore = require('../src/middleware/rate-limit-store');
  sharedStore._resetForTests();
  const middleware = billingRateLimit.makeBillingRateLimit({
    name: 'nat-safe',
    limit: 1,
    ipLimit: 5,
    windowMs: 60_000,
    store: sharedStore,
    env,
  });

  for (let index = 1; index <= 5; index += 1) {
    let nextCalls = 0;
    const res = makeRes();
    await middleware(makeReq({
      user: { id: `shared_user_${index}` },
      ip: '198.51.100.9',
    }), res, () => { nextCalls += 1; });
    assert.equal(nextCalls, 1, `user ${index} should not inherit another user's tight quota`);
    assert.equal(res.statusCode, 200);
  }

  const denied = makeRes();
  await middleware(makeReq({
    user: { id: 'shared_user_6' },
    ip: '198.51.100.9',
  }), denied, () => assert.fail('shared IP ceiling must eventually deny'));
  assert.equal(denied.statusCode, 429);
});

test('billing limiter maps different IPv6 hosts in one /64 to the same IP bucket', async () => {
  const calls = [];
  const middleware = billingRateLimit.makeBillingRateLimit({
    name: 'ipv6',
    limit: 2,
    ipLimit: 20,
    windowMs: 60_000,
    store: {
      async consumeMany(keys) {
        calls.push(keys);
        return { allowed: true, remaining: 1, resetAt: new Date(Date.now() + 60_000) };
      },
    },
    env: {
      NODE_ENV: 'test',
      RATE_LIMIT_STORE: 'memory',
      RATE_LIMIT_SENSITIVE_POLICY: 'memory',
    },
  });

  await middleware(makeReq({
    user: { id: 'ipv6-user-1' },
    ip: '2001:db8:4:5::1',
  }), makeRes(), () => {});
  await middleware(makeReq({
    user: { id: 'ipv6-user-2' },
    ip: '2001:db8:4:5:ffff::2',
  }), makeRes(), () => {});

  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], calls[1][1]);
  assert.match(calls[0][1], /^billingrl:ipv6:ip:/);
});

test('billing limiter ignores an untrusted raw X-Forwarded-For value', async () => {
  const calls = [];
  const middleware = billingRateLimit.makeBillingRateLimit({
    name: 'proxy-safe',
    limit: 2,
    windowMs: 60_000,
    store: {
      async consumeMany(keys) {
        calls.push(keys);
        return { allowed: true, remaining: 1, resetAt: new Date(Date.now() + 60_000) };
      },
    },
    env: {
      NODE_ENV: 'test',
      RATE_LIMIT_STORE: 'memory',
      RATE_LIMIT_SENSITIVE_POLICY: 'memory',
    },
  });

  await middleware(makeReq({
    ip: undefined,
    socket: { remoteAddress: '10.0.0.5' },
    headers: { 'x-forwarded-for': '198.51.100.77' },
  }), makeRes(), () => {});

  assert.deepEqual(calls[0], [
    'billingrl:proxy-safe:user:user_1',
    'billingrl:proxy-safe:ip:10.0.0.5',
  ]);
});

test('billing limiter rejects invalid factory configuration', () => {
  assert.throws(
    () => billingRateLimit.makeBillingRateLimit({ name: 'x', limit: 0, windowMs: 1 }),
    /limit/,
  );
  assert.throws(
    () => billingRateLimit.makeBillingRateLimit({ name: 'x', limit: 1, windowMs: 0 }),
    /windowMs/,
  );
  assert.throws(
    () => billingRateLimit.makeBillingRateLimit({
      name: 'x',
      limit: 2,
      ipLimit: 1,
      windowMs: 1000,
    }),
    /ipLimit/,
  );
});
