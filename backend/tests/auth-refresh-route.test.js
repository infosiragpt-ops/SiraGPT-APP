/**
 * Regression — POST /api/auth/refresh must rotate the session and return 200,
 * never 500.
 *
 * SessionService.refresh() already rotates the session row (token + expiresAt +
 * re-bound fingerprint) via sessions.updateByToken(oldToken, { newToken, … }).
 * The route previously ALSO ran a second inline `prisma.session.update` keyed on
 * `req.token` — but that is the *old* token, which the service just rotated
 * away, so the update matched zero rows and Prisma threw P2025 (record not
 * found). The route's catch only special-cased fingerprint errors, so every
 * refresh fell through to a 500. This test mocks Prisma's update() to throw
 * P2025 on a stale-token where-clause (exactly as the real client does) and
 * asserts the endpoint returns 200 with a freshly rotated token.
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-refresh-route-jwt-secret-at-least-32-chars!!';
process.env.JWT_SECRET = JWT_SECRET;
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
// Keep the auth rate-limit + session lookups on their in-memory fallbacks so
// the test never reaches Redis (which would keep the process alive / flake).
delete process.env.REDIS_URL;
process.env.RATE_LIMIT_STORE = 'memory';

const prisma = require('../src/config/database');
const { buildRouteTestApp, reloadModule } = require('./http-test-utils');

function prismaRecordNotFound() {
  // Mirror PrismaClientKnownRequestError P2025 closely enough for the route's
  // error handling: a non-fingerprint message + the canonical code.
  const err = new Error(
    'An operation failed because it depends on one or more records that were '
    + 'required but not found. No record was found for an update.'
  );
  err.code = 'P2025';
  return err;
}

function installMockPrisma() {
  const store = { users: [], sessions: [] };
  const findUserById = (id) => store.users.find((u) => u.id === id) || null;
  const findSessionByToken = (token) => store.sessions.find((s) => s.token === token) || null;

  prisma.user.findUnique = async ({ where }) => (where && where.id ? findUserById(where.id) : null);

  // authenticateToken loads the session with `include: { user: true }`.
  prisma.session.findUnique = async ({ where }) => {
    const s = findSessionByToken(where.token);
    return s ? { ...s, user: findUserById(s.userId) } : null;
  };

  // Faithful to the real client: update() throws P2025 when the where-clause
  // matches no row. This is precisely what turned the redundant inline update
  // into a 500.
  prisma.session.update = async ({ where, data }) => {
    const s = findSessionByToken(where.token);
    if (!s) throw prismaRecordNotFound();
    Object.assign(s, data);
    return { ...s };
  };

  prisma.session.deleteMany = async ({ where }) => {
    let count = 0;
    for (let i = store.sessions.length - 1; i >= 0; i -= 1) {
      const s = store.sessions[i];
      if (where.token && s.token !== where.token) continue;
      if (where.userId && s.userId !== where.userId) continue;
      store.sessions.splice(i, 1);
      count += 1;
    }
    return { count };
  };

  return store;
}

describe('auth · POST /refresh (no double-update 500)', () => {
  let app;
  let token;
  let store;

  beforeEach(() => {
    store = installMockPrisma();
    store.users.push({
      id: 'u-refresh',
      email: 'refresh@example.com',
      name: 'Refresh User',
      isAdmin: false,
    });
    token = jwt.sign({ userId: 'u-refresh', id: 'u-refresh' }, JWT_SECRET, { expiresIn: '1h' });
    store.sessions.push({
      id: 's-refresh',
      userId: 'u-refresh',
      token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    app = buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));
  });

  it('rotates the session and returns 200 with a new token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assert.ok(res.body.token, 'response must carry a rotated token');
    assert.notEqual(res.body.token, token, 'the token must actually be rotated');
  });

  it('leaves exactly one session row holding the rotated token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assert.equal(store.sessions.length, 1, 'refresh must not orphan or duplicate sessions');
    assert.equal(
      store.sessions[0].token,
      res.body.token,
      'the surviving session row must hold the new token (single source of truth)'
    );
  });
});
