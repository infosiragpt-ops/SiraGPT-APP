'use strict';

/**
 * The anti-bruteforce bucket on /api/auth must only count credential
 * attempts. Routine session traffic (/me, /csrf-token, /refresh, /logout,
 * /sessions) rides the general API limiter — otherwise one office IP with a
 * couple of tabs locks everybody out («Too many auth attempts»).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isAuthSessionMaintenancePath } = require('../src/middleware/rate-limit-policy');

test('session-maintenance paths are recognised with or without the /api/auth prefix and query strings', () => {
  for (const p of ['/me', '/api/auth/me', '/api/auth/me?x=1', '/csrf-token', '/api/auth/refresh', '/logout', '/sessions', '/api/auth/sessions/revoke-all']) {
    assert.equal(isAuthSessionMaintenancePath(p), true, p);
  }
});

test('credential endpoints stay under the strict bucket', () => {
  for (const p of ['/login', '/api/auth/login', '/register', '/forgot-password', '/reset-password', '/oauth/google/callback', '/verify-email', '/me-not', '/mesa', '', null]) {
    assert.equal(isAuthSessionMaintenancePath(p), false, String(p));
  }
});

test('index.js: auth limiter skips maintenance paths and the api limiter picks them up', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /skip: \(req\) => skipForSuperAdmin\(req\) \|\| isAuthSessionMaintenancePath\(req\.path\),/);
  assert.match(src, /if \(req\.originalUrl\.startsWith\('\/api\/auth'\)\) return !isAuthSessionMaintenancePath\(req\.originalUrl\);/);
});
