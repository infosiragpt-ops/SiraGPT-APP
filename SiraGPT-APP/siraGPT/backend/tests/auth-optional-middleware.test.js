'use strict';

/**
 * Tests for the `optionalAuth` middleware in middleware/auth.js.
 *
 * Contract:
 *  - Always calls next() — never sends a 401 or 403.
 *  - When the request has no token: req.user stays undefined.
 *  - When the token is invalid or expired: req.user stays undefined
 *    (no error surface, no logging spam).
 *  - When the token carries a scope claim (e.g. Appshots): treats it
 *    as anonymous to prevent silent elevation on routes that didn't
 *    opt-in via the scoped-token mechanism.
 *  - When the token is an API key (sk_…): falls through to anonymous
 *    rather than forcing the API-key validator's 401 surface.
 *
 * Heavy DB mocking isn't worth the maintenance burden for a middleware
 * whose happy path delegates to Prisma; the tests focus on the
 * fail-soft guarantees that make optionalAuth distinct from
 * authenticateToken.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { optionalAuth } = require('../src/middleware/auth');

function makeReq(overrides = {}) {
  return {
    headers: {},
    cookies: {},
    ...overrides,
  };
}

function makeRes() {
  const calls = { status: [], json: [], setHeader: [] };
  const res = {
    statusCode: 200,
    status(code) {
      calls.status.push(code);
      res.statusCode = code;
      return res;
    },
    json(body) {
      calls.json.push(body);
      return res;
    },
    setHeader(name, value) {
      calls.setHeader.push([name, value]);
      return res;
    },
    headersSent: false,
    writableEnded: false,
  };
  res.__calls = calls;
  return res;
}

function runOptional(req) {
  return new Promise((resolve) => {
    const res = makeRes();
    let nextCalledWith = '__pending__';
    optionalAuth(req, res, (err) => {
      nextCalledWith = err === undefined ? null : err;
      resolve({ res, nextCalledWith });
    });
  });
}

// ── no token ───────────────────────────────────────────────────────────

test('optionalAuth: no Authorization header AND no cookie → next() anonymous', async () => {
  const req = makeReq();
  const { res, nextCalledWith } = await runOptional(req);
  assert.equal(nextCalledWith, null, 'next() should be called with no error');
  assert.equal(req.user, undefined);
  assert.equal(req.userSession, undefined);
  assert.equal(res.__calls.status.length, 0, 'must not send a status');
  assert.equal(res.__calls.json.length, 0, 'must not send a response body');
});

test('optionalAuth: empty Authorization header → next() anonymous', async () => {
  const req = makeReq({ headers: { authorization: '' } });
  const { res, nextCalledWith } = await runOptional(req);
  assert.equal(nextCalledWith, null);
  assert.equal(req.user, undefined);
  assert.equal(res.__calls.json.length, 0);
});

// ── malformed Authorization header ─────────────────────────────────────

test('optionalAuth: malformed header (no Bearer prefix) → next() anonymous', async () => {
  const req = makeReq({ headers: { authorization: 'not-a-bearer-token' } });
  const { res, nextCalledWith } = await runOptional(req);
  assert.equal(nextCalledWith, null);
  assert.equal(req.user, undefined);
  assert.equal(res.__calls.json.length, 0, 'must not 401 on malformed header');
});

test('optionalAuth: header with control chars → next() anonymous (no leak)', async () => {
  const req = makeReq({ headers: { authorization: 'Bearer xyz\r\nInjected' } });
  const { res, nextCalledWith } = await runOptional(req);
  assert.equal(nextCalledWith, null);
  assert.equal(req.user, undefined);
  assert.equal(res.__calls.json.length, 0);
});

// ── invalid JWT ────────────────────────────────────────────────────────

test('optionalAuth: random garbage Bearer token → next() anonymous', async () => {
  const req = makeReq({
    headers: { authorization: 'Bearer this.is.not.a.jwt' },
  });
  const { res, nextCalledWith } = await runOptional(req);
  assert.equal(nextCalledWith, null);
  assert.equal(req.user, undefined);
  assert.equal(res.__calls.json.length, 0);
});

test('optionalAuth: JWT signed with wrong secret → next() anonymous (no 401)', async () => {
  // jwt.io's "Hello, World" example signed with a different secret.
  const foreignJwt = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ',
    'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  ].join('.');
  const req = makeReq({ headers: { authorization: `Bearer ${foreignJwt}` } });
  const { res, nextCalledWith } = await runOptional(req);
  assert.equal(nextCalledWith, null);
  assert.equal(req.user, undefined);
  assert.equal(res.__calls.json.length, 0);
});

// ── API-key scheme ─────────────────────────────────────────────────────

test('optionalAuth: invalid sk_ API key → next() anonymous (does NOT 401)', async () => {
  const req = makeReq({
    headers: { authorization: 'Bearer sk_fake_does_not_exist_in_db' },
  });
  const { res, nextCalledWith } = await runOptional(req);
  assert.equal(nextCalledWith, null, 'should always next() even with bad API key');
  assert.equal(req.user, undefined);
  assert.equal(res.__calls.json.length, 0, 'must not surface the api-key 401');
});

// ── Cookie auth ────────────────────────────────────────────────────────

test('optionalAuth: garbage cookie token → next() anonymous', async () => {
  const req = makeReq({ cookies: { token: 'not.a.real.jwt' } });
  const { res, nextCalledWith } = await runOptional(req);
  assert.equal(nextCalledWith, null);
  assert.equal(req.user, undefined);
  assert.equal(res.__calls.json.length, 0);
});

test('optionalAuth: empty cookie token → next() anonymous', async () => {
  const req = makeReq({ cookies: { token: '' } });
  const { res, nextCalledWith } = await runOptional(req);
  assert.equal(nextCalledWith, null);
  assert.equal(req.user, undefined);
});

// ── Robustness ─────────────────────────────────────────────────────────

test('optionalAuth: thrown error in extractAccessToken → still calls next()', async () => {
  // Pass an Authorization header whose value is an array — the parser
  // unwraps it with firstHeaderValue, but the overall flow must still
  // be exception-free.
  const req = makeReq({ headers: { authorization: ['Bearer first', 'Bearer second'] } });
  const { res, nextCalledWith } = await runOptional(req);
  assert.equal(nextCalledWith, null);
  assert.equal(req.user, undefined);
  assert.equal(res.__calls.json.length, 0);
});

test('optionalAuth: extremely long token → next() anonymous (length-cap path)', async () => {
  const huge = 'a'.repeat(20_000);
  const req = makeReq({ headers: { authorization: `Bearer ${huge}` } });
  const { res, nextCalledWith } = await runOptional(req);
  assert.equal(nextCalledWith, null);
  assert.equal(req.user, undefined);
  assert.equal(res.__calls.json.length, 0);
});
