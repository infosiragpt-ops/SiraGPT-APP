/**
 * Task 14 — security email notifications when an Appshots device is paired
 * or revoked.
 *
 * Confirms that:
 *   - POST /api/appshots/pair triggers emailService.sendAppshotsDeviceLinked
 *     with the caller's IP and a Date, and that the request still returns
 *     201 even if the email helper rejects (fire-and-forget contract).
 *   - DELETE /api/appshots/sessions/:id triggers
 *     emailService.sendAppshotsDeviceRevoked.
 *   - Non-appshots / foreign-owned revocations do NOT send an email.
 *
 * Prisma is stubbed via the shared http-test-utils so no DB is required.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'appshots-email-test-secret-32+chars!';

const prisma = require('../src/config/database');
const emailService = require('../src/services/email');
const { buildRouteTestApp, installAuthSessionMock } = require('./http-test-utils');
const appshotsRouter = require('../src/routes/appshots');

function makeAppshotsToken(userId) {
  return jwt.sign(
    { userId, scope: 'appshots:capture', nonce: 'x' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

describe('POST /api/appshots/pair → device-linked email', () => {
  let auth;
  let calls;
  let origSend;
  let origCreate;
  let origUserFindUnique;
  let userSettings;

  beforeEach(() => {
    auth = installAuthSessionMock({ id: 'task14-user', email: 'task14@example.com', name: 'Task 14 Tester' });
    calls = [];
    origSend = emailService.sendAppshotsDeviceLinked;
    emailService.sendAppshotsDeviceLinked = async (user, info) => {
      calls.push({ user, info });
      return true;
    };
    origCreate = prisma.session.create;
    prisma.session.create = async ({ data }) => ({ id: 'new-session', ...data });
    // Task 18: stub the user.findUnique used by email-preferences.loadNotifications
    // so each test can control the appshots_security opt-out flag.
    userSettings = {};
    origUserFindUnique = prisma.user.findUnique;
    prisma.user.findUnique = async () => ({ settings: userSettings });
  });

  afterEach(() => {
    emailService.sendAppshotsDeviceLinked = origSend;
    prisma.session.create = origCreate;
    prisma.user.findUnique = origUserFindUnique;
    auth.restore();
  });

  it('sends the security email with IP + Date and still returns 201', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .post('/api/appshots/pair')
      .set('Authorization', auth.authHeader)
      .set('X-Forwarded-For', '203.0.113.42, 10.0.0.1');

    assert.equal(res.status, 201);
    assert.ok(res.body.token);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].user.email, 'task14@example.com');
    assert.equal(calls[0].info.ip, '203.0.113.42');
    assert.ok(calls[0].info.when instanceof Date);
  });

  it('does not break the pair response if the email helper throws', async () => {
    emailService.sendAppshotsDeviceLinked = async () => {
      throw new Error('SMTP down');
    };
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .post('/api/appshots/pair')
      .set('Authorization', auth.authHeader);
    assert.equal(res.status, 201);
  });

  it('skips the email when the user has opted out via notifications.appshots_security', async () => {
    // Task 18 — power users can silence Appshots security mails.
    userSettings = { notifications: { appshots_security: false } };
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .post('/api/appshots/pair')
      .set('Authorization', auth.authHeader);
    assert.equal(res.status, 201);
    // Allow the fire-and-forget promise chain to drain before asserting.
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 0);
  });
});

describe('DELETE /api/appshots/sessions/:id → device-revoked email', () => {
  let auth;
  let calls;
  let origSend;
  let origFindUnique;
  let origDelete;
  let origUserFindUnique;
  let userSettings;
  let store;

  beforeEach(() => {
    auth = installAuthSessionMock({ id: 'task14-user', email: 'task14@example.com', name: 'Task 14 Tester' });
    calls = [];
    origSend = emailService.sendAppshotsDeviceRevoked;
    emailService.sendAppshotsDeviceRevoked = async (user, info) => {
      calls.push({ user, info });
      return true;
    };
    store = [
      { id: 'sess-own', userId: 'task14-user', token: makeAppshotsToken('task14-user') },
      { id: 'sess-other', userId: 'someone-else', token: makeAppshotsToken('someone-else') },
    ];
    origFindUnique = prisma.session.findUnique;
    prisma.session.findUnique = async ({ where, select }) => {
      if (where && where.token) return origFindUnique({ where, select });
      return store.find((r) => r.id === where.id) || null;
    };
    origDelete = prisma.session.delete;
    prisma.session.delete = async ({ where }) => {
      const i = store.findIndex((r) => r.id === where.id);
      if (i >= 0) store.splice(i, 1);
      return { id: where.id };
    };
    userSettings = {};
    origUserFindUnique = prisma.user.findUnique;
    prisma.user.findUnique = async () => ({ settings: userSettings });
  });

  afterEach(() => {
    emailService.sendAppshotsDeviceRevoked = origSend;
    prisma.session.findUnique = origFindUnique;
    prisma.session.delete = origDelete;
    prisma.user.findUnique = origUserFindUnique;
    auth.restore();
  });

  it('sends the email after a successful revoke', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .delete('/api/appshots/sessions/sess-own')
      .set('Authorization', auth.authHeader);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].user.email, 'task14@example.com');
    assert.ok(calls[0].info.when instanceof Date);
  });

  it('does not send an email when revocation is rejected (foreign session)', async () => {
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .delete('/api/appshots/sessions/sess-other')
      .set('Authorization', auth.authHeader);
    assert.equal(res.status, 404);
    assert.equal(calls.length, 0);
  });

  it('skips the email when the user has opted out via notifications.appshots_security', async () => {
    userSettings = { notifications: { appshots_security: false } };
    const app = buildRouteTestApp('/api/appshots', appshotsRouter);
    const res = await request(app)
      .delete('/api/appshots/sessions/sess-own')
      .set('Authorization', auth.authHeader);
    assert.equal(res.status, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 0);
  });
});
