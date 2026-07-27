'use strict';

/**
 * issueCsrfToken — helper shared by /api/csrf-token, /api/auth/login,
 * and /api/auth/register. Pins that:
 *   • a fresh self-signed token (`<nonce>.<ts>.<sig>`) is returned,
 *   • the public + secret cookies are both set on the response,
 *   • the secret cookie value matches `hashToken(token)`,
 *   • the token validates statelessly (cookieless iframe fallback),
 *   • repeated calls rotate the token (no caching).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  issueCsrfToken,
  hashToken,
  verifyStatelessToken,
} = require('../src/middleware/csrf');

// Self-signed token shape: 32-byte-hex nonce, base36 timestamp, HMAC-hex sig.
const STATELESS_TOKEN_RE = /^[0-9a-f]{64}\.[0-9a-z]+\.[0-9a-f]{64}$/;

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

test('issueCsrfToken returns a fresh self-signed token and sets both cookies', () => {
  const res = mockRes();
  const token = issueCsrfToken(res);
  assert.equal(typeof token, 'string');
  assert.match(token, STATELESS_TOKEN_RE);
  assert.ok(res.cookies.csrf_token);
  assert.ok(res.cookies._csrf_secret);
  assert.equal(res.cookies.csrf_token.opts.httpOnly, false);
  assert.equal(res.cookies._csrf_secret.opts.httpOnly, true);
  assert.equal(res.cookies._csrf_secret.value, hashToken(token));
});

test('issued token validates statelessly (cookieless iframe fallback)', () => {
  const token = issueCsrfToken(mockRes());
  assert.equal(verifyStatelessToken(token), true);
});

test('issued stateless token is bound to the provided session id', () => {
  const token = issueCsrfToken(mockRes(), { sessionID: 'session-a' });
  assert.equal(verifyStatelessToken(token, undefined, 'session-a'), true);
  assert.equal(verifyStatelessToken(token, undefined, 'session-b'), false);
  assert.equal(verifyStatelessToken(token), false);
});

test('issueCsrfToken rotates the token on every call', () => {
  const a = issueCsrfToken(mockRes());
  const b = issueCsrfToken(mockRes());
  assert.notEqual(a, b);
});

// Forge a correctly-signed token with an arbitrary embedded timestamp.
function signTokenAt(epochMs) {
  const crypto = require('crypto');
  const nonce = crypto.randomBytes(32).toString('hex');
  const ts = Math.floor(epochMs).toString(36);
  return `${nonce}.${ts}.${hashToken(`${nonce}.${ts}`)}`;
}

test('verifyStatelessToken rejects a validly-signed token with a far-future timestamp', () => {
  // Even with a correct HMAC, a token "issued" well beyond clock skew is
  // treated as malformed/forged — a legitimate token can never come from the future.
  const future = signTokenAt(Date.now() + 60 * 60 * 1000); // +1h
  assert.equal(verifyStatelessToken(future), false);
});

test('verifyStatelessToken rejects a validly-signed but expired token', () => {
  const expired = signTokenAt(Date.now() - 25 * 60 * 60 * 1000); // 25h old, > 24h max age
  assert.equal(verifyStatelessToken(expired), false);
});

test('verifyStatelessToken accepts a freshly-signed token within the valid window', () => {
  assert.equal(verifyStatelessToken(signTokenAt(Date.now())), true);
});
