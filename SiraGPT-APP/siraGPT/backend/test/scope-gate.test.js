const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-scope-gate-tests-only';

const { authenticateToken } = require('../src/middleware/auth');

function makeReqRes(headers, allowScope) {
  const req = {
    headers: { ...headers },
    cookies: {},
    method: 'GET',
    url: '/api/chats',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  };
  if (allowScope) req._allowScopedToken = allowScope;
  let statusCode = null;
  let body = null;
  const res = {
    status(code) { statusCode = code; return res; },
    json(payload) { body = payload; return res; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
  return { req, res, get statusCode() { return statusCode; }, get body() { return body; } };
}

test('scope-gate: rejects scoped JWT on a route that did not opt in', async () => {
  const token = jwt.sign(
    { userId: 'fake', scope: 'appshots:capture' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
  const ctx = makeReqRes({ authorization: `Bearer ${token}` });
  await new Promise((resolve) => {
    authenticateToken(ctx.req, ctx.res, () => resolve('next-called'));
    setTimeout(resolve, 100);
  });
  assert.strictEqual(ctx.statusCode, 403, 'must be 403');
  assert.strictEqual(ctx.body?.code, 'scope_not_allowed');
  assert.strictEqual(ctx.body?.scope, 'appshots:capture');
});

test('scope-gate: accepts scoped JWT when route explicitly opts in', async () => {
  const token = jwt.sign(
    { userId: 'fake', scope: 'appshots:capture' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
  const ctx = makeReqRes({ authorization: `Bearer ${token}` }, 'appshots:capture');
  await new Promise((resolve) => {
    authenticateToken(ctx.req, ctx.res, () => resolve('next-called'));
    setTimeout(resolve, 200);
  });
  // Scope gate passes; falls through to session DB lookup which returns null
  // for our fake userId → 401 "Invalid or expired token". The KEY assertion
  // is "not 403 scope_not_allowed" — the gate did NOT reject.
  assert.notStrictEqual(ctx.body?.code, 'scope_not_allowed',
    'scope gate must let through when route opts in');
});

test('scope-gate: ignores plain JWT (no scope claim)', async () => {
  const token = jwt.sign({ userId: 'fake' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const ctx = makeReqRes({ authorization: `Bearer ${token}` });
  await new Promise((resolve) => {
    authenticateToken(ctx.req, ctx.res, () => resolve('next-called'));
    setTimeout(resolve, 200);
  });
  // Plain JWT must NOT be rejected by the scope gate.
  assert.notStrictEqual(ctx.body?.code, 'scope_not_allowed');
});
