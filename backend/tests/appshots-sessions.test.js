/**
 * appshots-sessions — Task 8 — verifies GET/DELETE /api/appshots/sessions
 *
 *   - GET returns only sessions whose JWT carries scope `appshots:capture`
 *     (other long-lived rows from the same user are filtered out).
 *   - DELETE removes the row when caller owns it AND it is an appshots
 *     session; rejects 404 for foreign owners, 403 for non-appshots
 *     sessions.
 *
 * Prisma is mocked so the test runs without a database. We piggyback on
 * http-test-utils.installAuthSessionMock so authenticateToken sees the
 * caller as a real user.
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'appshots-sessions-test-secret-32+chars!';

const prisma = require('../src/config/database');
const { buildRouteTestApp, installAuthSessionMock } = require('./http-test-utils');
const appshotsRouter = require('../src/routes/appshots');

function makeAppshotsToken(userId) {
  return jwt.sign(
    { userId, scope: 'appshots:capture', nonce: 'x' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makePlainToken(userId) {
  return jwt.sign({ userId, id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('GET /api/appshots/sessions', () => {
  let restore;
  let auth;
  let rows;

  beforeEach(() => {
    auth = installAuthSessionMock({ id: 'task8-user' });
    rows = [
      {
        id: 'sess-appshots-1',
        userId: 'task8-user',
        token: makeAppshotsToken('task8-user'),
        createdAt: new Date('2026-05-01T10:00:00Z'),
        expiresAt: new Date('2027-05-01T10:00:00Z'),
        lastUsedAt: new Date('2026-05-10T12:00:00Z'),
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ipHint: '81.45.30.0/24',
        label: 'Portátil del trabajo',
      },
      {
        id: 'sess-plain',
        userId: 'task8-user',
        token: makePlainToken('task8-user'),
        createdAt: new Date('2026-05-02T10:00:00Z'),
        expiresAt: new Date('2027-05-02T10:00:00Z'),
        lastUsedAt: null,
      },
    ];

    const originalFindMany = prisma.session.findMany;
    prisma.session.findMany = async ({ where }) =>
      rows.filter((r) => r.userId === where.userId);

    restore = () => {
      prisma.session.findMany = originalFindMany;
      auth.restore();
    };
  });

  it('returns only appshots-scoped sessions, hiding the raw token', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .get('/api/appshots/sessions')
      .set('Authorization', auth.authHeader);
    restore();
    assert.equal(res.status, 200);
    assert.equal(res.body.sessions.length, 1);
    const s = res.body.sessions[0];
    assert.equal(s.id, 'sess-appshots-1');
    assert.equal(s.token, undefined);
    assert.ok(s.createdAt);
    assert.ok(s.lastUsedAt);
    // Task 15 — device hints surface through the API.
    assert.equal(s.label, 'Portátil del trabajo');
    assert.equal(s.ipHint, '81.45.30.0/24');
    assert.equal(s.device, 'Chrome en macOS');
    assert.ok(typeof s.userAgent === 'string' && s.userAgent.includes('Chrome'));
  });
});

describe('describeUserAgent (Task 15)', () => {
  const { describeUserAgent } = appshotsRouter._private;
  it('recognises common browser + OS combinations', () => {
    assert.equal(
      describeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      ),
      'Chrome en macOS',
    );
    assert.equal(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
      ),
      'Edge en Windows',
    );
    assert.equal(
      describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0'),
      'Firefox en Linux',
    );
  });
  it('returns null when nothing is recognisable', () => {
    assert.equal(describeUserAgent(''), null);
    assert.equal(describeUserAgent('curl/8.0.1'), null);
  });
});

describe('PATCH /api/appshots/sessions/:id (Task 15)', () => {
  let restore;
  let auth;
  let store;

  beforeEach(() => {
    auth = installAuthSessionMock({ id: 'task15-user' });
    store = [
      {
        id: 'sess-appshots-1',
        userId: 'task15-user',
        token: makeAppshotsToken('task15-user'),
        label: null,
      },
      {
        id: 'sess-other-user',
        userId: 'someone-else',
        token: makeAppshotsToken('someone-else'),
        label: null,
      },
      {
        id: 'sess-plain-mine',
        userId: 'task15-user',
        token: makePlainToken('task15-user'),
        label: null,
      },
    ];
    const originalFindUnique = prisma.session.findUnique;
    const originalUpdate = prisma.session.update;
    prisma.session.findUnique = async ({ where, select }) => {
      if (where.token) return originalFindUnique({ where, select });
      return store.find((r) => r.id === where.id) || null;
    };
    prisma.session.update = async ({ where, data }) => {
      const row = store.find((r) => r.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    };
    restore = () => {
      prisma.session.findUnique = originalFindUnique;
      prisma.session.update = originalUpdate;
      auth.restore();
    };
  });

  it('renames own appshots session', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .patch('/api/appshots/sessions/sess-appshots-1')
      .set('Authorization', auth.authHeader)
      .send({ label: '  Portátil de casa  ' });
    const stored = store.find((r) => r.id === 'sess-appshots-1');
    restore();
    assert.equal(res.status, 200);
    assert.equal(res.body.label, 'Portátil de casa');
    assert.equal(stored.label, 'Portátil de casa');
  });

  it('clears the label when given an empty string', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    store[0].label = 'previo';
    const res = await request(app)
      .patch('/api/appshots/sessions/sess-appshots-1')
      .set('Authorization', auth.authHeader)
      .send({ label: '' });
    const stored = store.find((r) => r.id === 'sess-appshots-1');
    restore();
    assert.equal(res.status, 200);
    assert.equal(res.body.label, null);
    assert.equal(stored.label, null);
  });

  it('refuses to rename a session that belongs to someone else (404)', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .patch('/api/appshots/sessions/sess-other-user')
      .set('Authorization', auth.authHeader)
      .send({ label: 'hack' });
    restore();
    assert.equal(res.status, 404);
  });

  it('refuses to rename a non-appshots session (403)', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .patch('/api/appshots/sessions/sess-plain-mine')
      .set('Authorization', auth.authHeader)
      .send({ label: 'nope' });
    restore();
    assert.equal(res.status, 403);
  });
});

describe('DELETE /api/appshots/sessions/:id', () => {
  let restore;
  let auth;
  let store;

  beforeEach(() => {
    auth = installAuthSessionMock({ id: 'task8-user' });
    store = [
      {
        id: 'sess-appshots-1',
        userId: 'task8-user',
        token: makeAppshotsToken('task8-user'),
      },
      {
        id: 'sess-other-user',
        userId: 'someone-else',
        token: makeAppshotsToken('someone-else'),
      },
      {
        id: 'sess-plain-mine',
        userId: 'task8-user',
        token: makePlainToken('task8-user'),
      },
    ];
    const originalFindUnique = prisma.session.findUnique;
    const originalDelete = prisma.session.delete;
    prisma.session.findUnique = async ({ where, select }) => {
      if (where.token) return originalFindUnique({ where, select });
      const row = store.find((r) => r.id === where.id);
      return row || null;
    };
    prisma.session.delete = async ({ where }) => {
      const i = store.findIndex((r) => r.id === where.id);
      if (i >= 0) store.splice(i, 1);
      return { id: where.id };
    };
    restore = () => {
      prisma.session.findUnique = originalFindUnique;
      prisma.session.delete = originalDelete;
      auth.restore();
    };
  });

  it('revokes own appshots session', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .delete('/api/appshots/sessions/sess-appshots-1')
      .set('Authorization', auth.authHeader);
    const remaining = store.map((r) => r.id);
    restore();
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(!remaining.includes('sess-appshots-1'));
  });

  it('refuses to revoke a session that belongs to someone else (404)', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .delete('/api/appshots/sessions/sess-other-user')
      .set('Authorization', auth.authHeader);
    const stillThere = store.some((r) => r.id === 'sess-other-user');
    restore();
    assert.equal(res.status, 404);
    assert.ok(stillThere);
  });

  it('refuses to revoke a non-appshots session (403)', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .delete('/api/appshots/sessions/sess-plain-mine')
      .set('Authorization', auth.authHeader);
    const stillThere = store.some((r) => r.id === 'sess-plain-mine');
    restore();
    assert.equal(res.status, 403);
    assert.ok(stillThere);
  });
});
