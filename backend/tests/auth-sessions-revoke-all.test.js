/**
 * auth-sessions-revoke-all — verifies POST /api/auth/sessions/revoke-all
 * removes every active session for the caller except the one bound to
 * the current request token, and emits a single `sessions_revoked_all`
 * audit row carrying the deletion count in metadata.
 *
 * Prisma is mocked so the test runs without a database; only the
 * deleteMany shape is exercised.
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const prisma = require('../src/config/database');
const { buildRouteTestApp, reloadModule } = require('./http-test-utils');
const {
  onUserSessionsRevoked,
} = require('../src/services/auth/user-session-revocation-events');

const JWT_SECRET = 'test-revoke-all-jwt-secret-at-least-32-chars!!';
process.env.JWT_SECRET = JWT_SECRET;

function mockPrisma() {
  const store = {
    users: [],
    sessions: [],
    auditRows: [],
  };

  prisma.user.findUnique = async ({ where }) => {
    if (where.id) return store.users.find((u) => u.id === where.id) || null;
    if (where.email) return store.users.find((u) => u.email === where.email) || null;
    return null;
  };

  prisma.session.findUnique = async ({ where, include }) => {
    const s = store.sessions.find((x) => (
      where.token ? x.token === where.token : x.id === where.id
    )) || null;
    if (!s) return null;
    if (include && include.user) {
      return { ...s, user: store.users.find((u) => u.id === s.userId) || null };
    }
    return s;
  };

  prisma.session.findMany = async ({ where }) => store.sessions.filter((session) => {
    if (where.userId && session.userId !== where.userId) return false;
    if (where.NOT?.token && session.token === where.NOT.token) return false;
    return true;
  });

  prisma.session.delete = async ({ where }) => {
    const index = store.sessions.findIndex((session) => session.id === where.id);
    if (index < 0) throw new Error('session not found');
    const [deleted] = store.sessions.splice(index, 1);
    return deleted;
  };

  prisma.session.deleteMany = async ({ where }) => {
    const before = store.sessions.length;
    for (let i = store.sessions.length - 1; i >= 0; i--) {
      const s = store.sessions[i];
      if (where.userId && s.userId !== where.userId) continue;
      // Spec from route: NOT: { token: req.token }
      if (where.NOT && where.NOT.token && s.token === where.NOT.token) continue;
      store.sessions.splice(i, 1);
    }
    return { count: before - store.sessions.length };
  };

  // AuditLog capture
  if (!prisma.auditLog) prisma.auditLog = {};
  prisma.auditLog.create = async ({ data }) => {
    store.auditRows.push(data);
    return data;
  };
  prisma.auditLog.findMany = async () => [];

  return store;
}

function seedUserAndSessions(store, { userId = 'u1', count = 3 } = {}) {
  store.users.push({
    id: userId,
    email: 'ratchet45@example.com',
    name: 'Ratchet User',
    isAdmin: false,
    plan: 'FREE',
  });
  const tokens = [];
  for (let i = 0; i < count; i++) {
    const t = jwt.sign({ userId, id: userId, n: i }, JWT_SECRET, { expiresIn: '1h' });
    store.sessions.push({
      id: `sess-${i}`,
      userId,
      token: t,
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
    });
    tokens.push(t);
  }
  return tokens;
}

describe('POST /api/auth/sessions/revoke-all', () => {
  let store;
  let app;

  beforeEach(() => {
    store = mockPrisma();
    app = buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));
  });

  it('revokes all sessions except the current one and returns the count', async () => {
    const tokens = seedUserAndSessions(store, { count: 4 });
    const currentToken = tokens[0];

    const res = await request(app)
      .post('/api/auth/sessions/revoke-all')
      .set('Authorization', `Bearer ${currentToken}`)
      .expect(200);

    assert.equal(res.body.ok, true);
    assert.equal(res.body.count, 3);
    assert.equal(store.sessions.length, 1);
    assert.equal(store.sessions[0].token, currentToken);
  });

  it('returns count=0 when the caller has only one session', async () => {
    const tokens = seedUserAndSessions(store, { count: 1 });

    const res = await request(app)
      .post('/api/auth/sessions/revoke-all')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);

    assert.equal(res.body.count, 0);
    assert.equal(store.sessions.length, 1);
  });

  it('writes an audit row tagged sessions_revoked_all with count metadata', async () => {
    const tokens = seedUserAndSessions(store, { count: 3 });

    await request(app)
      .post('/api/auth/sessions/revoke-all')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);

    // writeAuditLog is fire-and-forget — let the microtask queue drain.
    await new Promise((r) => setImmediate(r));
    const row = store.auditRows.find((r) => r.action === 'sessions_revoked_all');
    assert.ok(row, 'expected a sessions_revoked_all audit row');
    assert.equal(row.actorId, 'u1');
    assert.equal(row.resourceType, 'session');
    assert.ok(row.metadata && row.metadata.count === 2);
  });

  it('publishes a user session-revoked event after deleting other sessions', async (t) => {
    const tokens = seedUserAndSessions(store, { count: 3 });
    const events = [];
    const unsubscribe = onUserSessionsRevoked((event) => events.push(event));
    t.after(unsubscribe);

    await request(app)
      .post('/api/auth/sessions/revoke-all')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);

    assert.deepEqual(events, [{
      userId: 'u1',
      reason: 'sessions_revoked',
    }]);
  });

  it('publishes a user session-revoked event after deleting one session', async (t) => {
    const tokens = seedUserAndSessions(store, { count: 3 });
    const events = [];
    const unsubscribe = onUserSessionsRevoked((event) => events.push(event));
    t.after(unsubscribe);

    await request(app)
      .delete('/api/auth/sessions/sess-1')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);

    assert.deepEqual(events, [{
      userId: 'u1',
      reason: 'session_revoked',
    }]);
  });

  it('legacy users revoke-others endpoint publishes the same revocation event', async (t) => {
    const tokens = seedUserAndSessions(store, { count: 3 });
    const events = [];
    const unsubscribe = onUserSessionsRevoked((event) => events.push(event));
    t.after(unsubscribe);
    const usersApp = buildRouteTestApp('/api/users', reloadModule('../src/routes/users'));

    const response = await request(usersApp)
      .post('/api/users/sessions/revoke-others')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);

    assert.equal(response.body.revoked, 2);
    assert.deepEqual(events, [{
      userId: 'u1',
      reason: 'sessions_revoked',
    }]);
  });

  it('rejects unauthenticated callers with 401', async () => {
    await request(app)
      .post('/api/auth/sessions/revoke-all')
      .expect(401);
  });
});
