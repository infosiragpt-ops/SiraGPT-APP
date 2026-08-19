/**
 * Task 17 — security email when the backend AUTO-revokes an Appshots
 * session (fingerprint mismatch or expiration detected in
 * authenticateToken), independently of the user-initiated revoke path
 * already covered by appshots-email-notifications.test.js.
 *
 * We exercise the middleware directly with a fake req/res so we don't
 * have to spin up a full express app or stub the entire auth pipeline.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'task17-auto-revoke-secret-32+chars!';

const prisma = require('../src/config/database');
const emailService = require('../src/services/email');
const { authenticateToken } = require('../src/middleware/auth');

function makeAppshotsToken(userId, opts = {}) {
  return jwt.sign(
    { userId, scope: 'appshots:capture', nonce: 'x' },
    process.env.JWT_SECRET,
    { expiresIn: opts.expiresIn || '1h' },
  );
}

function makeReq(token, { allowScope = 'appshots:capture' } = {}) {
  return {
    headers: { authorization: `Bearer ${token}` },
    cookies: {},
    ip: '203.0.113.7',
    socket: { remoteAddress: '203.0.113.7' },
    // Scoped tokens are gated by authenticateToken — production callers
    // (see routes/appshots.js requireAppshotsScope) opt-in via this flag.
    _allowScopedToken: allowScope,
    get(h) { return this.headers[(h || '').toLowerCase()]; },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('Task 17 — authenticateToken auto-revoke email', () => {
  let calls;
  let origAuto;
  let origFindUnique;
  let origDeleteMany;
  let origUserFindUnique;

  const user = { id: 'task17-user', email: 'task17@example.com', name: 'Task 17 Tester' };

  beforeEach(() => {
    calls = [];
    origAuto = emailService.sendAppshotsDeviceAutoRevoked;
    emailService.sendAppshotsDeviceAutoRevoked = async (u, info) => {
      calls.push({ user: u, info });
      return true;
    };
    origFindUnique = prisma.session.findUnique;
    origDeleteMany = prisma.session.deleteMany;
    origUserFindUnique = prisma.user.findUnique;
    prisma.session.deleteMany = async () => ({ count: 1 });
    prisma.user.findUnique = async () => user;
  });

  afterEach(() => {
    emailService.sendAppshotsDeviceAutoRevoked = origAuto;
    prisma.session.findUnique = origFindUnique;
    prisma.session.deleteMany = origDeleteMany;
    prisma.user.findUnique = origUserFindUnique;
  });

  it('emits auto-revoke email on fingerprint mismatch for an appshots session', async () => {
    const token = makeAppshotsToken(user.id);
    prisma.session.findUnique = async () => ({
      id: 'sess-fp',
      token,
      userId: user.id,
      user,
      expiresAt: new Date(Date.now() + 60_000),
      fingerprint: 'a-totally-different-fingerprint',
    });

    const req = makeReq(token);
    const res = makeRes();
    let nextCalled = false;
    await authenticateToken(req, res, () => { nextCalled = true; });

    assert.equal(res.statusCode, 401);
    assert.equal(res.body?.reason, 'fingerprint_mismatch');
    assert.equal(nextCalled, false);
    // The email is fire-and-forget — await a microtask flush.
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].user.email, user.email);
    assert.equal(calls[0].info.reason, 'fingerprint_mismatch');
    assert.ok(calls[0].info.when instanceof Date);
  });

  it('emits auto-revoke email when the appshots session row has expired', async () => {
    const token = makeAppshotsToken(user.id);
    prisma.session.findUnique = async () => ({
      id: 'sess-exp',
      token,
      userId: user.id,
      user,
      expiresAt: new Date(Date.now() - 60_000),
      fingerprint: null,
    });

    const req = makeReq(token);
    const res = makeRes();
    await authenticateToken(req, res, () => {});

    assert.equal(res.statusCode, 401);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].info.reason, 'token_expired');
  });

  it('does NOT emit when the revoked session is a regular (non-appshots) one', async () => {
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    prisma.session.findUnique = async () => ({
      id: 'sess-reg',
      token,
      userId: user.id,
      user,
      expiresAt: new Date(Date.now() + 60_000),
      fingerprint: 'mismatch',
    });

    const req = makeReq(token);
    const res = makeRes();
    await authenticateToken(req, res, () => {});

    assert.equal(res.statusCode, 401);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 0);
  });

  it('emits auto-revoke email when jwt.verify itself raises TokenExpiredError', async () => {
    const token = makeAppshotsToken(user.id, { expiresIn: -1 });
    prisma.session.findUnique = async () => null;

    const req = makeReq(token);
    const res = makeRes();
    await authenticateToken(req, res, () => {});

    assert.equal(res.statusCode, 403);
    // Need two microtask flushes: one for prisma.user.findUnique, one for
    // the email helper chained on top.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].info.reason, 'token_expired');
    assert.equal(calls[0].user.email, user.email);
  });
});
