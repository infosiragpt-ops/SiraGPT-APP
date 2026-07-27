/**
 * Task 26 — when an admin deletes a user via DELETE /admin/users/:id, the
 * cascade-revoked sessions must leave an `session_admin_revoked` audit row
 * per session so the owner's GET /api/appshots/revocations list can show
 * "Revocado por el equipo de soporte" for Appshots-scoped tokens.
 *
 * Verifies:
 *   - one audit row per session
 *   - actorId = victim user id (not the admin)
 *   - metadata.adminId = admin user id
 *   - metadata.scope = 'appshots:capture' only on Appshots-scoped tokens
 *   - 200 response is still returned
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'task26-admin-revoke-test-secret-32+chars!';

const prisma = require('../src/config/database');
const { buildRouteTestApp, installAuthSessionMock } = require('./http-test-utils');
const adminRouter = require('../src/routes/admin');
const {
  SYSTEM_ASSIGNMENT_TAG,
} = require('../src/services/rbac-system-assignments');

function makeAppshotsToken(userId) {
  return jwt.sign(
    { userId, scope: 'appshots:capture', nonce: 'n' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makePlainToken(userId) {
  return jwt.sign({ userId, id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('DELETE /admin/users/:id emits session_admin_revoked audit rows', () => {
  let auth;
  let app;
  const restoreFns = [];
  const VICTIM_ID = 'victim-user-26';
  let auditWrites = [];
  let sessions = [];

  beforeEach(() => {
    auth = installAuthSessionMock({
      id: 'admin-user-26',
      email: 'admin@example.com',
      isAdmin: true,
      isSuperAdmin: true,
    });
    restoreFns.push(() => auth.restore());

    sessions = [
      { id: 'sess-aps-1', userId: VICTIM_ID, token: makeAppshotsToken(VICTIM_ID) },
      { id: 'sess-aps-2', userId: VICTIM_ID, token: makeAppshotsToken(VICTIM_ID) },
      { id: 'sess-plain', userId: VICTIM_ID, token: makePlainToken(VICTIM_ID) },
    ];

    const origSessionFind = prisma.session.findMany;
    prisma.session.findMany = async ({ where } = {}) =>
      sessions.filter((s) => s.userId === where.userId);
    restoreFns.push(() => { prisma.session.findMany = origSessionFind; });

    for (const modelName of ['session', 'partialSession', 'twoFAChallenge']) {
      const model = prisma[modelName];
      if (!model) continue;
      const originalDeleteMany = model.deleteMany;
      model.deleteMany = async () => ({ count: 0 });
      restoreFns.push(() => { model.deleteMany = originalDeleteMany; });
    }

    const origUserDelete = prisma.user.delete;
    prisma.user.delete = async ({ where } = {}) => ({ id: where.id });
    restoreFns.push(() => { prisma.user.delete = origUserDelete; });

    const origUserFindUnique = prisma.user.findUnique;
    prisma.user.findUnique = async ({ where } = {}) => ({
      id: where.id,
      isSuperAdmin: false,
      deletedAt: null,
    });
    restoreFns.push(() => { prisma.user.findUnique = origUserFindUnique; });

    const origUserRoleDeleteMany = prisma.userRole.deleteMany;
    prisma.userRole.deleteMany = async () => ({ count: 0 });
    restoreFns.push(() => { prisma.userRole.deleteMany = origUserRoleDeleteMany; });

    const origTransaction = prisma.$transaction;
    prisma.$transaction = async (fn) => fn(prisma);
    restoreFns.push(() => { prisma.$transaction = origTransaction; });

    const origQueryRawUnsafe = prisma.$queryRawUnsafe;
    prisma.$queryRawUnsafe = async () => [{ version: '1' }];
    restoreFns.push(() => { prisma.$queryRawUnsafe = origQueryRawUnsafe; });

    const origExecuteRawUnsafe = prisma.$executeRawUnsafe;
    prisma.$executeRawUnsafe = async () => 1;
    restoreFns.push(() => { prisma.$executeRawUnsafe = origExecuteRawUnsafe; });

    const origSettingsFindUnique = prisma.systemSettings.findUnique;
    prisma.systemSettings.findUnique = async () => ({ value: '1' });
    restoreFns.push(() => { prisma.systemSettings.findUnique = origSettingsFindUnique; });

    const origUserRoleFindMany = prisma.userRole.findMany;
    prisma.userRole.findMany = async ({ select } = {}) => {
      if (select?.scope || select?.scopeId) return [];
      return [{
        role: {
          permissions: [{ permission: { code: 'users.delete' } }],
        },
      }];
    };
    restoreFns.push(() => { prisma.userRole.findMany = origUserRoleFindMany; });

    auditWrites = [];
    if (!prisma.auditLog) prisma.auditLog = {};
    const origAuditCreate = prisma.auditLog.create;
    prisma.auditLog.create = async ({ data } = {}) => {
      auditWrites.push(data);
      return { id: `audit-${auditWrites.length}`, ...data };
    };
    restoreFns.push(() => { prisma.auditLog.create = origAuditCreate; });

    app = buildRouteTestApp('/admin', adminRouter);
  });

  afterEach(() => {
    while (restoreFns.length) {
      const fn = restoreFns.pop();
      try { fn(); } catch (_) { /* noop */ }
    }
  });

  it('writes one audit row per revoked session with the correct scope/admin metadata', async () => {
    const res = await request(app)
      .delete(`/admin/users/${VICTIM_ID}`)
      .set('Authorization', auth.authHeader)
      .send();

    assert.equal(res.status, 200);
    assert.equal(res.body.message, 'User deleted successfully');

    // Audit writes are fire-and-forget — give the microtask queue a tick.
    await new Promise((r) => setImmediate(r));

    const revoked = auditWrites.filter((row) => row.action === 'session_admin_revoked');
    assert.equal(revoked.length, 3, 'one audit row per session');

    for (const row of revoked) {
      assert.equal(row.actorId, VICTIM_ID, 'actorId = victim id');
      assert.equal(row.resourceType, 'session');
      assert.ok(row.resourceId);
      assert.ok(row.metadata && typeof row.metadata === 'object');
      assert.equal(row.metadata.adminId, 'admin-user-26');
    }

    const appshotsRows = revoked.filter((r) => r.metadata.scope === 'appshots:capture');
    assert.equal(appshotsRows.length, 2, 'two Appshots-scoped tokens tagged');
    const plainRows = revoked.filter((r) => !('scope' in r.metadata));
    assert.equal(plainRows.length, 1, 'plain token left untagged');
  });

  it('refuses to delete the admin themselves and emits no audit rows', async () => {
    const res = await request(app)
      .delete('/admin/users/admin-user-26')
      .set('Authorization', auth.authHeader)
      .send();

    assert.equal(res.status, 400);
    await new Promise((r) => setImmediate(r));
    assert.equal(
      auditWrites.filter((row) => row.action === 'session_admin_revoked').length,
      0,
    );
  });

  it('returns 409 before touching the RBAC system principal', async () => {
    const res = await request(app)
      .delete(`/admin/users/${encodeURIComponent(SYSTEM_ASSIGNMENT_TAG)}`)
      .set('Authorization', auth.authHeader)
      .send();

    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'rbac_system_principal_protected');
    await new Promise((r) => setImmediate(r));
    assert.equal(auditWrites.length, 0);
  });

  it('blocks every admin user-mutation surface for the RBAC system principal', async () => {
    const id = encodeURIComponent(SYSTEM_ASSIGNMENT_TAG);
    const attempts = [
      request(app)
        .put(`/admin/users/${id}`)
        .set('Authorization', auth.authHeader)
        .send({ name: 'Forbidden edit' }),
      request(app)
        .post(`/admin/users/${id}/reset-password`)
        .set('Authorization', auth.authHeader)
        .send(),
      request(app)
        .post(`/admin/users/${id}/grant-credits`)
        .set('Authorization', auth.authHeader)
        .send({ credits: 100 }),
    ];

    const responses = await Promise.all(attempts);
    for (const response of responses) {
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'rbac_system_principal_protected');
    }
    assert.equal(auditWrites.length, 0);
  });
});
