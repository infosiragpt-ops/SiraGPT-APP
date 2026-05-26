'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE_MS,
  getSessionCookieOptions,
  getClearSessionCookieOptions,
  setSessionCookie,
  clearSessionCookie,
} = require('../src/utils/session-cookie');

function makeRes() {
  const calls = [];
  return {
    calls,
    cookie(name, value, opts) {
      calls.push({ type: 'cookie', name, value, opts });
      return this;
    },
    clearCookie(name, opts) {
      calls.push({ type: 'clearCookie', name, opts });
      return this;
    },
  };
}

test('default session cookie options match existing auth behavior plus path', () => {
  assert.deepEqual(getSessionCookieOptions({ NODE_ENV: 'development' }), {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
  });
});

test('production and cross-site modes force Secure cookies', () => {
  assert.equal(getSessionCookieOptions({ NODE_ENV: 'production' }).secure, true);
  assert.deepEqual(getSessionCookieOptions({ CROSS_ORIGIN_AUTH_COOKIES: '1' }), {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
  });
});

test('SESSION_COOKIE_SAME_SITE accepts only known values', () => {
  assert.equal(getSessionCookieOptions({ SESSION_COOKIE_SAME_SITE: 'strict' }).sameSite, 'strict');
  assert.equal(getSessionCookieOptions({ SESSION_COOKIE_SAME_SITE: 'bogus' }).sameSite, 'lax');
});

test('clear options omit maxAge but keep flags aligned', () => {
  assert.deepEqual(getClearSessionCookieOptions({ NODE_ENV: 'production' }), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });
});

test('setSessionCookie and clearSessionCookie call Express response consistently', () => {
  const res = makeRes();
  setSessionCookie(res, 'jwt-token', { NODE_ENV: 'development' });
  clearSessionCookie(res, { NODE_ENV: 'development' });

  assert.equal(res.calls[0].type, 'cookie');
  assert.equal(res.calls[0].name, SESSION_COOKIE_NAME);
  assert.equal(res.calls[0].value, 'jwt-token');
  assert.equal(res.calls[0].opts.httpOnly, true);
  assert.equal(res.calls[1].type, 'clearCookie');
  assert.equal(res.calls[1].name, SESSION_COOKIE_NAME);
  assert.equal('maxAge' in res.calls[1].opts, false);
});
