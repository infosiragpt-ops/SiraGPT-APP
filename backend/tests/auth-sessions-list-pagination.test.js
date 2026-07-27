/**
 * auth-sessions-list-pagination — verifies GET /api/auth/sessions
 * accepts ?page= and ?limit= and returns {sessions, total, page, pages,
 * limit}. Default limit is 20, max is 100. Garbage input collapses to
 * the defaults so a stale query string in the sessions UI keeps working.
 *
 * Prisma is mocked; we only exercise the Session.findMany/count contract
 * and the IP/UA enrichment path which is tested elsewhere.
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const prisma = require('../src/config/database');
const { buildRouteTestApp, reloadModule } = require('./http-test-utils');
const {
  hashSessionToken,
} = require('../src/services/auth/session-token-persistence');

const JWT_SECRET = 'test-sessions-list-pagination-jwt-secret-32!!';
process.env.JWT_SECRET = JWT_SECRET;

function mockPrisma() {
  const store = { users: [], sessions: [] };

  prisma.user.findUnique = async ({ where }) => {
    if (where.id) return store.users.find((u) => u.id === where.id) || null;
    if (where.email) return store.users.find((u) => u.email === where.email) || null;
    return null;
  };

  prisma.session.findUnique = async ({ where, include }) => {
    const s = store.sessions.find((x) => x.token === where.token) || null;
    if (!s) return null;
    if (include && include.user) {
      return { ...s, user: store.users.find((u) => u.id === s.userId) || null };
    }
    return s;
  };

  prisma.session.updateMany = async ({ where, data }) => {
    let count = 0;
    for (const session of store.sessions) {
      if (where.id && session.id !== where.id) continue;
      if (where.token && session.token !== where.token) continue;
      Object.assign(session, data);
      count += 1;
    }
    return { count };
  };

  prisma.session.findMany = async ({ where, orderBy, skip = 0, take } = {}) => {
    let rows = store.sessions
      .filter((s) => (!where || !where.userId) || s.userId === where.userId)
      .filter((s) => {
        if (!where || !where.expiresAt) return true;
        if (where.expiresAt.gt) return s.expiresAt > where.expiresAt.gt;
        return true;
      });
    if (orderBy && orderBy.createdAt === 'desc') {
      rows = rows.slice().sort((a, b) => b.createdAt - a.createdAt);
    }
    return rows.slice(skip, skip + (take || rows.length));
  };

  prisma.session.count = async ({ where } = {}) => {
    const list = await prisma.session.findMany({ where });
    return list.length;
  };

  if (!prisma.auditLog) prisma.auditLog = {};
  prisma.auditLog.findMany = async () => [];

  return store;
}

function seedUserAndSessions(store, { userId = 'u1', count = 25 } = {}) {
  store.users.push({
    id: userId,
    email: 'paginate@example.com',
    name: 'Page User',
    isAdmin: false,
    plan: 'FREE',
  });
  const tokens = [];
  const base = Date.now();
  for (let i = 0; i < count; i++) {
    const t = jwt.sign({ userId, id: userId, n: i }, JWT_SECRET, { expiresIn: '1h' });
    store.sessions.push({
      id: `sess-${i}`,
      userId,
      token: hashSessionToken(t),
      expiresAt: new Date(base + 3600_000),
      // descending by createdAt → most-recently created first when sorted
      createdAt: new Date(base + i),
    });
    tokens.push(t);
  }
  return tokens;
}

describe('GET /api/auth/sessions — pagination', () => {
  let store;
  let app;
  let tokens;

  beforeEach(() => {
    store = mockPrisma();
    app = buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));
    tokens = seedUserAndSessions(store, { count: 25 });
  });

  it('returns {sessions,total,page,pages,limit} with default limit 20', async () => {
    const res = await request(app)
      .get('/api/auth/sessions')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);

    assert.equal(res.body.total, 25);
    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 20);
    assert.equal(res.body.pages, 2);
    assert.equal(Array.isArray(res.body.sessions), true);
    assert.equal(res.body.sessions.length, 20);
  });

  it('marks the current session when its stored token is hashed', async () => {
    const res = await request(app)
      .get('/api/auth/sessions?limit=100')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);

    const current = res.body.sessions.filter((session) => session.current);
    assert.equal(current.length, 1);
    assert.equal(current[0].id, 'sess-0');
  });

  it('honours ?page and ?limit', async () => {
    const res = await request(app)
      .get('/api/auth/sessions?page=2&limit=10')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);

    assert.equal(res.body.page, 2);
    assert.equal(res.body.limit, 10);
    assert.equal(res.body.pages, 3); // ceil(25/10)
    assert.equal(res.body.sessions.length, 10);
  });

  it('caps limit at 100', async () => {
    const res = await request(app)
      .get('/api/auth/sessions?limit=9999')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);

    assert.equal(res.body.limit, 100);
  });

  it('collapses garbage page/limit to defaults', async () => {
    const res = await request(app)
      .get('/api/auth/sessions?page=NaN&limit=-1')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .expect(200);

    assert.equal(res.body.page, 1);
    assert.equal(res.body.limit, 20);
  });
});
