'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const {
  resolveRateLimitConfig,
  makeJwtAwareKeyGenerator,
  makeSuperAdminBypass,
  extractBearerToken,
} = require('../src/middleware/rate-limit-policy');

const SECRET = 'unit-test-secret-do-not-use-in-prod';

// ──────────────────────────────────────────────────────────────────────────
// resolveRateLimitConfig — defaults reflect the production tuning that
// supports a real document-analysis session (multiple uploads + chat
// regen). If these defaults move, downstream services that rely on
// them will see different throttle behavior — fail loudly here.
// ──────────────────────────────────────────────────────────────────────────

test('resolveRateLimitConfig: defaults match production tuning', () => {
  const cfg = resolveRateLimitConfig({});
  assert.equal(cfg.windowMs, 15 * 60 * 1000);
  assert.equal(cfg.auth, 30);
  assert.equal(cfg.expensive, 180);
  assert.equal(cfg.api, 3000);
});

test('resolveRateLimitConfig: env overrides honored', () => {
  const cfg = resolveRateLimitConfig({
    RATE_LIMIT_WINDOW_MS: '60000',
    RATE_LIMIT_AUTH_MAX: '10',
    RATE_LIMIT_EXPENSIVE_MAX: '50',
    RATE_LIMIT_API_MAX: '500',
  });
  assert.equal(cfg.windowMs, 60_000);
  assert.equal(cfg.auth, 10);
  assert.equal(cfg.expensive, 50);
  assert.equal(cfg.api, 500);
});

test('resolveRateLimitConfig: malformed / zero / negative env values fall back to defaults', () => {
  const cfg = resolveRateLimitConfig({
    RATE_LIMIT_WINDOW_MS: '0',
    RATE_LIMIT_AUTH_MAX: '-5',
    RATE_LIMIT_EXPENSIVE_MAX: 'NaN',
    RATE_LIMIT_API_MAX: '',
  });
  assert.equal(cfg.windowMs, 15 * 60 * 1000);
  assert.equal(cfg.auth, 30);
  assert.equal(cfg.expensive, 180);
  assert.equal(cfg.api, 3000);
});

// ──────────────────────────────────────────────────────────────────────────
// makeSuperAdminBypass — the operator's safety net.
// ──────────────────────────────────────────────────────────────────────────

function fakeReq({ token, cookieToken } = {}) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    cookies: cookieToken ? { token: cookieToken } : {},
  };
}

test('makeSuperAdminBypass: missing secret → always returns false', () => {
  const skip = makeSuperAdminBypass(undefined);
  assert.equal(typeof skip, 'function');
  const validToken = jwt.sign({ userId: 'u1', isSuperAdmin: true }, SECRET);
  assert.equal(skip(fakeReq({ token: validToken })), false);
});

test('makeSuperAdminBypass: no token on request → false', () => {
  const skip = makeSuperAdminBypass(SECRET);
  assert.equal(skip(fakeReq()), false);
  assert.equal(skip({ headers: {}, cookies: {} }), false);
});

test('makeSuperAdminBypass: valid super-admin token → true', () => {
  const skip = makeSuperAdminBypass(SECRET);
  const token = jwt.sign({ userId: 'admin-1', isSuperAdmin: true }, SECRET);
  assert.equal(skip(fakeReq({ token })), true);
});

test('makeSuperAdminBypass: valid token without superAdmin claim → false', () => {
  const skip = makeSuperAdminBypass(SECRET);
  const token = jwt.sign({ userId: 'user-1', isSuperAdmin: false }, SECRET);
  assert.equal(skip(fakeReq({ token })), false);
});

test('makeSuperAdminBypass: claim missing entirely → false', () => {
  const skip = makeSuperAdminBypass(SECRET);
  const token = jwt.sign({ userId: 'user-2' }, SECRET);
  assert.equal(skip(fakeReq({ token })), false);
});

test('makeSuperAdminBypass: forged token (wrong secret) → false (never bypass)', () => {
  const skip = makeSuperAdminBypass(SECRET);
  const forged = jwt.sign({ userId: 'attacker', isSuperAdmin: true }, 'wrong-secret');
  assert.equal(skip(fakeReq({ token: forged })), false);
});

test('makeSuperAdminBypass: token in cookie also honored', () => {
  const skip = makeSuperAdminBypass(SECRET);
  const token = jwt.sign({ userId: 'cookie-admin', isSuperAdmin: true }, SECRET);
  assert.equal(skip(fakeReq({ cookieToken: token })), true);
});

test('makeSuperAdminBypass: claim must be EXACTLY true (truthy strings/numbers do NOT bypass)', () => {
  const skip = makeSuperAdminBypass(SECRET);
  for (const claim of ['true', 1, 'yes', {}]) {
    const token = jwt.sign({ userId: 'u', isSuperAdmin: claim }, SECRET);
    assert.equal(skip(fakeReq({ token })), false, `claim ${JSON.stringify(claim)} should NOT bypass`);
  }
});

test('makeSuperAdminBypass: malformed token does not throw', () => {
  const skip = makeSuperAdminBypass(SECRET);
  assert.doesNotThrow(() => skip(fakeReq({ token: 'not.a.jwt' })));
  assert.equal(skip(fakeReq({ token: 'not.a.jwt' })), false);
});

// ──────────────────────────────────────────────────────────────────────────
// extractBearerToken — unchanged behavior, regression-guarded
// ──────────────────────────────────────────────────────────────────────────

test('extractBearerToken: pulls token from Authorization header', () => {
  assert.equal(
    extractBearerToken({ headers: { authorization: 'Bearer abc123' } }),
    'abc123'
  );
});

test('extractBearerToken: case-insensitive scheme', () => {
  assert.equal(
    extractBearerToken({ headers: { authorization: 'bearer abc' } }),
    'abc'
  );
});

test('extractBearerToken: falls back to cookies.token', () => {
  assert.equal(
    extractBearerToken({ headers: {}, cookies: { token: 'cookie-token' } }),
    'cookie-token'
  );
});

test('extractBearerToken: null when no token present', () => {
  assert.equal(extractBearerToken({ headers: {}, cookies: {} }), null);
  assert.equal(extractBearerToken({ headers: {} }), null);
  assert.equal(extractBearerToken({}), null);
});

// ──────────────────────────────────────────────────────────────────────────
// makeJwtAwareKeyGenerator — unchanged contract regression test
// ──────────────────────────────────────────────────────────────────────────

test('makeJwtAwareKeyGenerator: buckets verified users by userId', () => {
  const keyGen = makeJwtAwareKeyGenerator(SECRET);
  const token = jwt.sign({ userId: 'user-xyz' }, SECRET);
  const key = keyGen({ headers: { authorization: `Bearer ${token}` }, ip: '1.1.1.1' });
  assert.equal(key, 'user:user-xyz');
});

test('makeJwtAwareKeyGenerator: forged token falls through to IP bucket', () => {
  const keyGen = makeJwtAwareKeyGenerator(SECRET);
  const forged = jwt.sign({ userId: 'evil' }, 'wrong-secret');
  const key = keyGen({ headers: { authorization: `Bearer ${forged}` }, ip: '2.2.2.2' });
  assert.equal(key, 'ip:2.2.2.2');
});
