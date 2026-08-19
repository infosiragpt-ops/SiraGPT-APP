'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the rate-limit-store BEFORE requiring rate-limit-auth so consume()
// can be controlled per test.
const storePath = require.resolve('../src/middleware/rate-limit-store');
const realStore = require('../src/middleware/rate-limit-store');
let consumeStub = null;
require.cache[storePath].exports = {
  ...realStore,
  consume: (...args) => consumeStub(...args),
};

const {
  makeAuthRateLimit,
  _pickIp,
  _pickEmail,
  _resolveKey,
  _normalizeKeySegment,
  _normalizeLimitName,
  _normalizeResetAt,
} = require('../src/middleware/rate-limit-auth');

function makeRes() {
  const captured = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { captured.statusCode = code; return this; },
    json(body) { captured.body = body; return this; },
    set(nameOrObj, value) {
      if (typeof nameOrObj === 'object') Object.assign(captured.headers, nameOrObj);
      else captured.headers[nameOrObj] = value;
      return this;
    },
  };
  return { res, captured };
}

function makeNext() {
  const calls = [];
  return { next: () => calls.push(true), calls };
}

test('exports makeAuthRateLimit + internal helpers', () => {
  assert.equal(typeof makeAuthRateLimit, 'function');
  assert.equal(typeof _pickIp, 'function');
  assert.equal(typeof _pickEmail, 'function');
  assert.equal(typeof _resolveKey, 'function');
  assert.equal(typeof _normalizeKeySegment, 'function');
  assert.equal(typeof _normalizeLimitName, 'function');
  assert.equal(typeof _normalizeResetAt, 'function');
});

test('_pickIp uses Express req.ip then socket address and never raw X-Forwarded-For', () => {
  assert.equal(_pickIp({ ip: '1.2.3.4' }), '1.2.3.4');
  assert.equal(
    _pickIp({
      headers: { 'x-forwarded-for': '5.6.7.8, 9.9.9.9' },
      socket: { remoteAddress: '10.0.0.2' },
    }),
    '10.0.0.2',
  );
  assert.equal(_pickIp({ connection: { remoteAddress: '10.0.0.1' } }), 'unknown');
  assert.equal(_pickIp({}), 'unknown');
});

test('_pickIp ignores forwarded headers and unsafe direct values', () => {
  assert.equal(_pickIp({ headers: { 'x-forwarded-for': '1.2.3.4' } }), 'unknown');
  assert.equal(
    _pickIp({
      ip: ' '.repeat(200),
      socket: { remoteAddress: '10.0.0.2' },
      connection: { remoteAddress: '198.51.100.9' },
    }),
    '10.0.0.2',
  );
});

test('_pickEmail lowercases, trims, and caps at 254 chars', () => {
  assert.equal(_pickEmail({ body: { email: '  Alice@Example.COM  ' } }), 'alice@example.com');
  assert.equal(_pickEmail({ body: { username: 'BOB@x.io' } }), 'bob@x.io');
  assert.equal(_pickEmail({ body: {} }), '');
  assert.equal(_pickEmail({}), '');
  assert.equal(_pickEmail({ body: { email: 123 } }), '');
  const long = 'a'.repeat(500) + '@x.io';
  assert.equal(_pickEmail({ body: { email: long } }).length, 254);
});

test('_resolveKey defaults to ip key with the configured name prefix', () => {
  assert.equal(_resolveKey({ ip: '1.2.3.4' }, 'ip', 'login'), 'authrl:login:1.2.3.4');
});

test('_resolveKey ip+email composes both segments', () => {
  const req = { ip: '1.1.1.1', body: { email: 'A@B.com' } };
  const key = _resolveKey(req, 'ip+email', 'login');
  assert.match(key, /^authrl:login:1\.1\.1\.1:email_[a-f0-9]{32}$/);
  assert.equal(key.includes('a@b.com'), false);
});

test('_resolveKey ip+email falls back to "noemail" segment when body lacks email', () => {
  assert.equal(_resolveKey({ ip: '1.1.1.1' }, 'ip+email', 'login'), 'authrl:login:1.1.1.1:noemail');
});

test('_resolveKey accepts a custom keyBy function and prefixes its output', () => {
  const keyFn = (req) => `userid:${req.user.id}`;
  const k = _resolveKey({ user: { id: 'u1' } }, keyFn, 'reset');
  assert.equal(k, 'authrl:reset:userid:u1');
});

test('_resolveKey hashes unsafe or long custom key segments', () => {
  const k = _resolveKey({}, () => 'x'.repeat(300), 'reset');
  assert.match(k, /^authrl:reset:custom_[a-f0-9]{32}$/);
});

test('_normalizeLimitName keeps Redis key namespaces bounded and readable', () => {
  assert.equal(_normalizeLimitName('Forgot Password!'), 'forgot-password-');
  assert.equal(_normalizeLimitName(''), 'generic');
});

test('_normalizeResetAt falls back when store result is invalid', () => {
  const before = Date.now();
  const resetAt = _normalizeResetAt('not-a-date', 60_000);
  assert.ok(resetAt.getTime() >= before + 59_000);
});

test('_resolveKey falls back when custom keyBy throws or returns garbage', () => {
  assert.equal(_resolveKey({ ip: '1.2.3.4' }, () => { throw new Error(); }, 'r'), 'authrl:r:1.2.3.4');
  assert.equal(_resolveKey({ ip: '1.2.3.4' }, () => '', 'r'), 'authrl:r:1.2.3.4');
  assert.equal(_resolveKey({ ip: '1.2.3.4' }, () => 42, 'r'), 'authrl:r:1.2.3.4');
});

test('makeAuthRateLimit throws TypeError when limit or windowMs is invalid', () => {
  assert.throws(() => makeAuthRateLimit({ limit: 0, windowMs: 1000 }), TypeError);
  assert.throws(() => makeAuthRateLimit({ limit: 10, windowMs: -1 }), TypeError);
  assert.throws(() => makeAuthRateLimit({ limit: 'a', windowMs: 1000 }), TypeError);
  assert.throws(() => makeAuthRateLimit({ limit: 10, windowMs: 'b' }), TypeError);
});

test('middleware calls next() and sets RateLimit-* headers when consume allows the call', async () => {
  consumeStub = async () => ({ allowed: true, remaining: 4, resetAt: new Date(Date.now() + 60_000) });
  const mw = makeAuthRateLimit({ name: 'login', limit: 5, windowMs: 60_000 });
  const req = { ip: '1.1.1.1' };
  const { res, captured } = makeRes();
  const { next, calls } = makeNext();

  await mw(req, res, next);

  assert.equal(calls.length, 1, 'next() must be called when allowed');
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.headers['RateLimit-Limit'], '5');
  assert.equal(captured.headers['RateLimit-Remaining'], '4');
  assert.ok(captured.headers['RateLimit-Reset']);
});

test('middleware blocks with 429 and proper headers when consume denies', async () => {
  const resetAt = new Date(Date.now() + 30_000);
  consumeStub = async () => ({ allowed: false, remaining: 0, resetAt });
  const mw = makeAuthRateLimit({ name: 'login', limit: 5, windowMs: 60_000 });
  const req = { ip: '1.1.1.1', requestId: 'req_rate_limited_1' };
  const { res, captured } = makeRes();
  const { next, calls } = makeNext();

  await mw(req, res, next);

  assert.equal(calls.length, 0, 'next() must NOT be called when blocking');
  assert.equal(captured.statusCode, 429);
  assert.equal(captured.body.ok, false);
  assert.equal(captured.body.code, 'rate_limited');
  assert.equal(captured.body.requestId, 'req_rate_limited_1');
  assert.match(captured.body.error, /too many login attempts/i);
  assert.ok(typeof captured.body.retryAfterMs === 'number');
  assert.ok(typeof captured.body.retryAfterSec === 'number');
  assert.ok(captured.body.retryAfterMs >= 0);
  assert.ok(typeof captured.headers['Retry-After'] === 'string');
  assert.equal(captured.headers['RateLimit-Limit'], '5');
  assert.equal(captured.headers['RateLimit-Remaining'], '0');
  assert.equal(captured.headers['Cache-Control'], 'no-store');
  assert.equal(captured.headers['X-Content-Type-Options'], 'nosniff');
});

test('middleware keeps the explicit nonproduction fail-open policy on store errors', async () => {
  consumeStub = async () => { throw new Error('redis down'); };
  const mw = makeAuthRateLimit({
    name: 'login',
    limit: 5,
    windowMs: 60_000,
    env: {
      NODE_ENV: 'test',
      RATE_LIMIT_SENSITIVE_POLICY: 'fail-open',
      REDIS_URL: 'redis://mock',
    },
  });
  const req = { ip: '1.1.1.1' };
  const { res, captured } = makeRes();
  const { next, calls } = makeNext();

  await mw(req, res, next);

  assert.equal(calls.length, 1);
  assert.equal(captured.statusCode, 200);
});

test('middleware fails closed with a no-store 503 when the production distributed store is unavailable', async () => {
  let consumeOptions;
  consumeStub = async (_key, _limit, _windowMs, opts) => {
    consumeOptions = opts;
    throw new Error('redis://user:secret@redis.internal unavailable');
  };
  const env = {
    NODE_ENV: 'production',
    REDIS_URL: 'redis://user:secret@redis.internal:6379',
  };
  const mw = makeAuthRateLimit({
    name: 'login',
    limit: 5,
    windowMs: 60_000,
    env,
  });
  const req = { ip: '1.1.1.1', requestId: 'req_store_down_1' };
  const { res, captured } = makeRes();
  const { next, calls } = makeNext();

  await mw(req, res, next);

  assert.equal(calls.length, 0);
  assert.equal(consumeOptions.requireDistributed, true);
  assert.equal(consumeOptions.env, env);
  assert.equal(captured.statusCode, 503);
  assert.equal(captured.body.code, 'RATE_LIMIT_STORE_UNAVAILABLE');
  assert.equal(captured.body.requestId, 'req_store_down_1');
  assert.equal(captured.headers['Cache-Control'], 'no-store');
  assert.equal(captured.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(captured.headers['Retry-After'], '5');
  assert.doesNotMatch(JSON.stringify(captured.body), /user|secret|redis\.internal/i);
});

test('middleware uses the active breaker Retry-After in literal production', async () => {
  consumeStub = async () => {
    const error = new Error('private store detail');
    error.code = 'RATE_LIMIT_STORE_UNAVAILABLE';
    error.retryAfterSeconds = 19;
    throw error;
  };
  const mw = makeAuthRateLimit({
    name: 'login-breaker',
    limit: 5,
    windowMs: 60_000,
    env: {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://mock',
      RATE_LIMIT_STORE_RETRY_AFTER_SECONDS: '5',
    },
  });
  const { res, captured } = makeRes();
  const { next, calls } = makeNext();

  await mw({ ip: '1.1.1.1' }, res, next);

  assert.equal(calls.length, 0);
  assert.equal(captured.statusCode, 503);
  assert.equal(captured.headers['Retry-After'], '19');
  assert.equal(captured.body.retryAfterSec, 19);
});

test('middleware keeps explicit test memory mode usable without requiring Redis', async () => {
  let consumeOptions;
  consumeStub = async (_key, _limit, _windowMs, opts) => {
    consumeOptions = opts;
    return { allowed: true, remaining: 4, resetAt: new Date(Date.now() + 60_000) };
  };
  const env = {
    NODE_ENV: 'test',
    RATE_LIMIT_STORE: 'memory',
    RATE_LIMIT_SENSITIVE_POLICY: 'memory',
  };
  const mw = makeAuthRateLimit({
    name: 'login',
    limit: 5,
    windowMs: 60_000,
    env,
  });
  const { res } = makeRes();
  const { next, calls } = makeNext();

  await mw({ ip: '127.0.0.1' }, res, next);

  assert.equal(calls.length, 1);
  assert.equal(consumeOptions.requireDistributed, false);
  assert.equal(consumeOptions.env.RATE_LIMIT_STORE, 'memory');
});

test('middleware uses ip+email key composition when keyBy is set', async () => {
  let observedKey = null;
  consumeStub = async (key) => { observedKey = key; return { allowed: true, remaining: 1, resetAt: new Date(Date.now() + 60_000) }; };
  const mw = makeAuthRateLimit({ name: 'login', limit: 2, windowMs: 60_000, keyBy: 'ip+email' });
  const req = { ip: '9.9.9.9', body: { email: 'foo@bar.io' } };
  await mw(req, makeRes().res, () => {});
  assert.match(observedKey, /^authrl:login:9\.9\.9\.9:email_[a-f0-9]{32}$/);
  assert.equal(observedKey.includes('foo@bar.io'), false);
});
