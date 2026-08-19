'use strict';

/**
 * issueCsrfToken — helper shared by /api/csrf-token, /api/auth/login,
 * and /api/auth/register. Pins that:
 *   • a fresh 64-hex-char token is returned,
 *   • the public + secret cookies are both set on the response,
 *   • the secret cookie value matches `hashToken(token)`,
 *   • repeated calls rotate the token (no caching).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  issueCsrfToken,
  hashToken,
} = require('../src/middleware/csrf');

function mockRes() {
  const headers = {};
  const res = { cookies: {}, headers };
  res.setHeader = (k, v) => { headers[String(k).toLowerCase()] = v; return res; };
  res.getHeader = (k) => headers[String(k).toLowerCase()];
  res.cookie = (name, value, opts) => {
    res.cookies[name] = { value, opts };
    return res;
  };
  return res;
}

test('issueCsrfToken returns a fresh 64-hex token and sets both cookies', () => {
  const res = mockRes();
  const token = issueCsrfToken(res);
  assert.equal(typeof token, 'string');
  assert.equal(token.length, 64);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(res.cookies.csrf_token);
  assert.ok(res.cookies._csrf_secret);
  assert.equal(res.cookies.csrf_token.opts.httpOnly, false);
  assert.equal(res.cookies._csrf_secret.opts.httpOnly, true);
  assert.equal(res.cookies._csrf_secret.value, hashToken(token));
});

test('issueCsrfToken rotates the token on every call', () => {
  const a = issueCsrfToken(mockRes());
  const b = issueCsrfToken(mockRes());
  assert.notEqual(a, b);
});
