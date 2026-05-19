'use strict';

/**
 * Ratchet 45 — verify-email rate-limit wiring.
 *
 * Cycle 93 shipped `GET /api/auth/verify-email/:token` without an
 * IP-scoped limiter; cycle 45 adds a 30/15min cap to make brute-force
 * grinding hopeless. This test pokes the auth router's middleware
 * stack (no live DB / Express bind) and asserts the verify-email
 * layer is guarded by a rate-limit middleware tagged `verify-email`
 * with the expected limit + window.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-vrl-jwt-secret-at-least-32-chars!!!!';

// Capture every call to makeAuthRateLimit so we can introspect what
// the auth router asked for. The middleware itself is a pass-through
// here — we only care about the *config*, not the runtime behaviour.
const rateLimitPath = path.resolve(__dirname, '../src/middleware/rate-limit-auth.js');
const calls = [];
require.cache[rateLimitPath] = {
  id: rateLimitPath,
  filename: rateLimitPath,
  loaded: true,
  exports: {
    makeAuthRateLimit: (opts) => {
      calls.push(opts);
      const mw = (_req, _res, next) => next();
      mw.__authRateLimitName = opts && opts.name;
      mw.__authRateLimitOpts = opts;
      return mw;
    },
  },
};

// Force a clean re-load of the auth router so it picks up the mock.
const authRoutePath = path.resolve(__dirname, '../src/routes/auth.js');
delete require.cache[authRoutePath];
const authRouter = require(authRoutePath);

function findLayer(method, pathPattern) {
  for (const layer of authRouter.stack || []) {
    if (!layer.route) continue;
    if (!layer.route.methods || !layer.route.methods[method]) continue;
    if (layer.route.path === pathPattern) return layer;
  }
  return null;
}

test('makeAuthRateLimit called with verify-email config', () => {
  const cfg = calls.find((c) => c && c.name === 'verify-email');
  assert.ok(cfg, 'expected a rate-limit named "verify-email"');
  assert.equal(cfg.limit, 30);
  assert.equal(cfg.windowMs, 15 * 60 * 1000);
  assert.equal(cfg.keyBy, 'ip');
});

test('GET /verify-email/:token route has the verify-email limiter mounted', () => {
  const layer = findLayer('get', '/verify-email/:token');
  assert.ok(layer, 'expected GET /verify-email/:token to be registered');
  const stack = layer.route.stack || [];
  const limiter = stack.find((s) => s.handle && s.handle.__authRateLimitName === 'verify-email');
  assert.ok(limiter, 'expected the verify-email limiter to be mounted on /verify-email/:token');
});
