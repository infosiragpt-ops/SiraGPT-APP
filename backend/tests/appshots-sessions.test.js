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
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'appshots-sessions-test-secret-32+chars!';

const prisma = require('../src/config/database');
const { buildRouteTestApp, installAuthSessionMock } = require('./http-test-utils');
const appshotsRouter = require('../src/routes/appshots');
const { authenticateToken } = require('../src/middleware/auth');

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
        geoHint: 'Madrid, ES',
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
    // Task 19 — geo hint also surfaces.
    assert.equal(s.geoHint, 'Madrid, ES');
    assert.ok(typeof s.userAgent === 'string' && s.userAgent.includes('Chrome'));
    // Task 20 — isCurrent flag is always present and false when the
    // request's UA/IP don't match the stored session.
    assert.equal(s.isCurrent, false);
  });

  // Task 20 — when the caller's User-Agent + ipHint match a stored
  // session, that one row is flagged isCurrent: true so the UI can
  // render "Este dispositivo".
  it('marks the matching session as isCurrent based on UA + ipHint', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const matchingUa =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const res = await request(app)
      .get('/api/appshots/sessions')
      .set('Authorization', auth.authHeader)
      .set('User-Agent', matchingUa)
      .set('X-Forwarded-For', '81.45.30.42');
    restore();
    assert.equal(res.status, 200);
    assert.equal(res.body.sessions.length, 1);
    assert.equal(res.body.sessions[0].isCurrent, true);
  });

  it('does not mark anything as current when only the UA matches', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const matchingUa =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const res = await request(app)
      .get('/api/appshots/sessions')
      .set('Authorization', auth.authHeader)
      .set('User-Agent', matchingUa)
      .set('X-Forwarded-For', '203.0.113.5');
    restore();
    assert.equal(res.status, 200);
    assert.equal(res.body.sessions[0].isCurrent, false);
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

describe('POST /api/appshots/pair (Task 19 — geoHint)', () => {
  let restore;
  let auth;
  let createdRows;
  let originalFetch;
  let originalGeoUrl;

  beforeEach(() => {
    auth = installAuthSessionMock({ id: 'task19-user', email: 'task19@example.com' });
    createdRows = [];
    const originalCreate = prisma.session.create;
    prisma.session.create = async ({ data }) => {
      const row = { id: `sess-${createdRows.length + 1}`, ...data };
      createdRows.push(row);
      return row;
    };
    originalFetch = globalThis.fetch;
    originalGeoUrl = process.env.GEOIP_LOOKUP_URL;
    // Point the geo lookup at a loopback HTTPS-equivalent (the secure-by-
    // default guard allows http on localhost). We never actually hit the
    // network — the test substitutes globalThis.fetch with a canned
    // response per case below.
    process.env.GEOIP_LOOKUP_URL = 'http://127.0.0.1:65535/{ip}';
    restore = () => {
      prisma.session.create = originalCreate;
      globalThis.fetch = originalFetch;
      if (originalGeoUrl === undefined) delete process.env.GEOIP_LOOKUP_URL;
      else process.env.GEOIP_LOOKUP_URL = originalGeoUrl;
      auth.restore();
    };
  });

  it('persists the resolved geoHint on the new session row', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'success', city: 'Madrid', countryCode: 'ES' }),
    });
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .post('/api/appshots/pair')
      .set('Authorization', auth.authHeader)
      .set('X-Forwarded-For', '81.45.30.20')
      .send({});
    const lastRow = createdRows[createdRows.length - 1];
    restore();
    assert.equal(res.status, 201);
    assert.ok(res.body.token);
    assert.ok(lastRow, 'pair handler must have created a Session row');
    assert.equal(lastRow.geoHint, 'Madrid, ES');
    assert.equal(lastRow.ipHint, '81.45.30.0/24');
  });

  it('falls back to a null geoHint when the lookup fails (degrades silently)', async () => {
    globalThis.fetch = async () => { throw new Error('upstream down'); };
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .post('/api/appshots/pair')
      .set('Authorization', auth.authHeader)
      .set('X-Forwarded-For', '81.45.30.20')
      .send({});
    const lastRow = createdRows[createdRows.length - 1];
    restore();
    assert.equal(res.status, 201);
    assert.ok(lastRow);
    assert.equal(lastRow.geoHint, null);
    assert.equal(lastRow.ipHint, '81.45.30.0/24');
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

describe('GET /api/appshots/revocations (Task 22/25)', () => {
  let restore;
  let auth;
  let findManyArgs;
  let storedRows;

  beforeEach(() => {
    auth = installAuthSessionMock({ id: 'task22-user' });
    findManyArgs = null;
    // 60 appshots-scoped rows so we can verify the in-handler cap at 50
    // kicks in even when the upstream `take: 200` returned more.
    storedRows = [];
    for (let i = 0; i < 60; i++) {
      storedRows.push({
        id: `appshots-${String(i).padStart(2, '0')}`,
        action: i % 3 === 0 ? 'session_fingerprint_mismatch'
              : i % 3 === 1 ? 'session_admin_revoked'
              : 'session_expired',
        createdAt: new Date(Date.UTC(2026, 4, 20) - i * 60_000),
        metadata: { scope: 'appshots:capture' },
        resourceId: `sess-${i}`,
      });
    }
    // Noise rows that MUST be filtered out by the scope guard.
    storedRows.push({
      id: 'noise-no-scope',
      action: 'session_expired',
      createdAt: new Date('2026-05-20T09:00:00Z'),
      metadata: { reason: 'jwt_expired' },
      resourceId: 'sess-noise-1',
    });
    storedRows.push({
      id: 'noise-other-scope',
      action: 'session_fingerprint_mismatch',
      createdAt: new Date('2026-05-20T09:00:00Z'),
      metadata: { scope: 'something-else' },
      resourceId: 'sess-noise-2',
    });
    storedRows.push({
      id: 'noise-null-metadata',
      action: 'session_admin_revoked',
      createdAt: new Date('2026-05-20T09:00:00Z'),
      metadata: null,
      resourceId: 'sess-noise-3',
    });

    const hadAuditLog = !!prisma.auditLog;
    const originalFindMany = prisma.auditLog?.findMany;
    if (!prisma.auditLog) prisma.auditLog = {};
    prisma.auditLog.findMany = async (args) => {
      findManyArgs = args;
      return storedRows;
    };

    restore = () => {
      if (hadAuditLog) prisma.auditLog.findMany = originalFindMany;
      else delete prisma.auditLog;
      auth.restore();
    };
  });

  it('returns only appshots-scoped rows, capped at 50, with mapped reasons', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .get('/api/appshots/revocations')
      .set('Authorization', auth.authHeader);
    restore();
    assert.equal(res.status, 200);
    assert.equal(res.body.revocations.length, 50);
    // Only appshots-scoped rows surface (noise stripped).
    for (const row of res.body.revocations) {
      assert.ok(row.id.startsWith('appshots-'), `noise row leaked: ${row.id}`);
      assert.ok(
        ['token_expired', 'fingerprint_mismatch', 'admin_revoked'].includes(row.reason),
        `unexpected reason: ${row.reason}`,
      );
      assert.ok(row.when, 'each revocation must carry a timestamp');
    }
    // The handler preserves upstream order, which is desc by createdAt.
    // The first 50 of our 60 appshots rows are the newest 50.
    assert.equal(res.body.revocations[0].id, 'appshots-00');
    assert.equal(res.body.revocations[49].id, 'appshots-49');
  });

  it('asks Prisma for the right scope: actorId, action whitelist, desc order', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    await request(app)
      .get('/api/appshots/revocations')
      .set('Authorization', auth.authHeader);
    restore();
    assert.ok(findManyArgs, 'auditLog.findMany must have been called');
    assert.equal(findManyArgs.where.actorId, 'task22-user');
    assert.deepEqual(
      [...findManyArgs.where.action.in].sort(),
      ['session_admin_revoked', 'session_expired', 'session_fingerprint_mismatch'],
    );
    assert.equal(findManyArgs.orderBy.createdAt, 'desc');
    assert.ok(findManyArgs.where.createdAt?.gte instanceof Date);
  });

  it('returns an empty list when the Prisma client lacks auditLog.findMany (narrow stubs)', async () => {
    // The real PrismaClient defines model getters non-configurably so we
    // can't `delete prisma.auditLog` outright; stubbing findMany to a
    // non-function exercises the same defensive branch in the route.
    prisma.auditLog.findMany = null;
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .get('/api/appshots/revocations')
      .set('Authorization', auth.authHeader);
    restore();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { revocations: [] });
  });
});

describe('authenticateToken metadata.scope tagging (Task 22/25)', () => {
  let restore;
  let auditCalls;

  function buildScopedApp() {
    const app = express();
    app.use((req, _res, next) => {
      req._allowScopedToken = 'appshots:capture';
      next();
    });
    app.get('/protected', authenticateToken, (_req, res) => res.json({ ok: true }));
    return app;
  }

  function waitForAuditFlush() {
    // writeAuditLog is fire-and-forget (`void writeAuditLog(...)`); give
    // the event loop a couple of ticks to flush our awaited stub.
    return new Promise((r) => setTimeout(r, 25));
  }

  beforeEach(() => {
    auditCalls = [];
    const hadAuditLog = !!prisma.auditLog;
    const originalAuditCreate = prisma.auditLog?.create;
    const originalFindUnique = prisma.session.findUnique;
    const originalDeleteMany = prisma.session.deleteMany;

    if (!prisma.auditLog) prisma.auditLog = {};
    prisma.auditLog.create = async (args) => {
      auditCalls.push(args);
      return { id: `aud-${auditCalls.length}`, ...args.data };
    };
    prisma.session.deleteMany = async () => ({ count: 1 });

    restore = () => {
      prisma.session.findUnique = originalFindUnique;
      prisma.session.deleteMany = originalDeleteMany;
      if (hadAuditLog) prisma.auditLog.create = originalAuditCreate;
      else delete prisma.auditLog;
    };
  });

  it('writes metadata.scope when an Appshots session row has expired', async () => {
    const token = makeAppshotsToken('user-22-expired');
    prisma.session.findUnique = async ({ where }) => {
      if (where?.token !== token) return null;
      return {
        id: 'sess-22-expired',
        token,
        userId: 'user-22-expired',
        user: { id: 'user-22-expired', email: 'expired@example.com' },
        expiresAt: new Date(Date.now() - 1000),
        fingerprint: null,
      };
    };
    const res = await request(buildScopedApp())
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);
    await waitForAuditFlush();
    const expiredCall = auditCalls.find((c) => c.data.action === 'session_expired');
    restore();
    assert.equal(res.status, 401);
    assert.ok(expiredCall, 'session_expired audit row must be written');
    assert.equal(expiredCall.data.metadata.scope, 'appshots:capture');
    assert.equal(expiredCall.data.resourceType, 'session');
    assert.equal(expiredCall.data.resourceId, 'sess-22-expired');
    assert.equal(expiredCall.data.actorId, 'user-22-expired');
  });

  it('writes metadata.scope on fingerprint mismatch for Appshots tokens', async () => {
    const token = makeAppshotsToken('user-22-fingerprint');
    prisma.session.findUnique = async ({ where }) => {
      if (where?.token !== token) return null;
      return {
        id: 'sess-22-fp',
        token,
        userId: 'user-22-fingerprint',
        user: { id: 'user-22-fingerprint', email: 'fp@example.com' },
        expiresAt: new Date(Date.now() + 60_000),
        // A non-matching stored fingerprint forces the mismatch branch:
        // compareFingerprints(current, 'wrong-hash') is false because the
        // current request fingerprint is sha256(...) of a totally different
        // IP + UA, never equal to this literal string.
        fingerprint: 'definitely-not-a-real-fingerprint-hash',
      };
    };
    const res = await request(buildScopedApp())
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
      .set('User-Agent', 'AppshotsTest/1.0')
      .set('X-Forwarded-For', '10.20.30.40');
    await waitForAuditFlush();
    const fpCall = auditCalls.find((c) => c.data.action === 'session_fingerprint_mismatch');
    restore();
    assert.equal(res.status, 401);
    assert.equal(res.body.reason, 'fingerprint_mismatch');
    assert.ok(fpCall, 'session_fingerprint_mismatch audit row must be written');
    assert.equal(fpCall.data.metadata.scope, 'appshots:capture');
    assert.equal(fpCall.data.metadata.revoked, true);
    assert.equal(fpCall.data.resourceId, 'sess-22-fp');
    assert.equal(fpCall.data.actorId, 'user-22-fingerprint');
  });

  it('does NOT tag scope on plain (non-scoped) JWT expiry — sanity check', async () => {
    const token = makePlainToken('user-22-plain');
    prisma.session.findUnique = async ({ where }) => {
      if (where?.token !== token) return null;
      return {
        id: 'sess-22-plain',
        token,
        userId: 'user-22-plain',
        user: { id: 'user-22-plain', email: 'plain@example.com' },
        expiresAt: new Date(Date.now() - 1000),
        fingerprint: null,
      };
    };
    const res = await request(buildScopedApp())
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);
    await waitForAuditFlush();
    const expiredCall = auditCalls.find((c) => c.data.action === 'session_expired');
    restore();
    assert.equal(res.status, 401);
    assert.ok(expiredCall, 'session_expired audit row must be written for plain tokens too');
    assert.equal(
      expiredCall.data.metadata.scope,
      undefined,
      'plain tokens carry no scope claim, so metadata.scope must be absent',
    );
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
