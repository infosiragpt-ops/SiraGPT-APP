'use strict';

/**
 * Ratchet 45 — org member email notifications.
 *
 *  • POST /api/orgs/invitation/:token/accept (verified user) →
 *    sendOrgWelcome called, audit metadata.welcomeEmailSent = true.
 *
 *  • POST /api/orgs/:id/members/:userId/role →
 *    sendRoleChangeNotification called with (user, org, oldRole,
 *    newRole) and audit metadata.roleChangeEmailSent = true.
 *
 *  • SMTP unconfigured (isConfigured=false) → no email, audit
 *    metadata sent-flag = false.
 *
 *  • Same-role "change" → no notification email.
 *
 * Pure-JS fake prisma + email; no DB, no SMTP.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const authPath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const auditPath = path.resolve(__dirname, '../src/utils/audit-log.js');
const triggersPath = path.resolve(__dirname, '../src/services/trigger-registry.js');
const emailPath = path.resolve(__dirname, '../src/services/email.js');
const evPath = path.resolve(__dirname, '../src/services/email-verification.js');
const orgsRoutePath = path.resolve(__dirname, '../src/routes/orgs.js');

const state = {
  user: { id: 'u-caller', email: 'caller@x.com', name: 'C', emailVerifiedAt: new Date() },
  invitations: [],
  memberships: [],
  users: [],
  orgs: [],
  welcomeCalls: [],
  roleChangeCalls: [],
  smtpConfigured: true,
};

const authMock = {
  authenticateToken: (req, _res, next) => { req.user = state.user; next(); },
};

const prismaMock = {
  orgInvitation: {
    findUnique: async ({ where }) => {
      const r = state.invitations.find((x) => x.token === where.token);
      if (!r) return null;
      const o = state.orgs.find((x) => x.id === r.orgId) || { id: r.orgId, name: 'Org', slug: 'org' };
      return { ...r, organization: o };
    },
    update: async ({ where, data }) => {
      const r = state.invitations.find((x) => x.id === where.id);
      Object.assign(r, data);
      return r;
    },
  },
  orgMembership: {
    findUnique: async ({ where, include }) => {
      const { orgId, userId } = where.orgId_userId;
      const m = state.memberships.find((x) => x.orgId === orgId && x.userId === userId);
      if (!m) return null;
      if (include && include.organization) {
        const o = state.orgs.find((x) => x.id === m.orgId);
        return { ...m, organization: o };
      }
      return m;
    },
    create: async ({ data }) => {
      const m = { id: `m-${state.memberships.length + 1}`, ...data };
      state.memberships.push(m);
      return m;
    },
    update: async ({ where, data }) => {
      const { orgId, userId } = where.orgId_userId;
      const m = state.memberships.find((x) => x.orgId === orgId && x.userId === userId);
      Object.assign(m, data);
      return m;
    },
    count: async () => state.memberships.filter((m) => m.role === 'OWNER').length,
  },
  user: {
    findUnique: async ({ where }) => state.users.find((u) => u.id === where.id) || null,
  },
  organization: {
    findUnique: async ({ where }) => state.orgs.find((o) => o.id === where.id) || null,
  },
  $transaction: async (fn) => fn({
    orgMembership: prismaMock.orgMembership,
    orgInvitation: prismaMock.orgInvitation,
  }),
};

const auditMock = {
  _calls: [],
  writeAuditLog: (_db, payload) => { auditMock._calls.push(payload); },
};

const triggersMock = {
  TRIGGERS: ['org.invitation.created', 'org.invitation.accepted', 'org.invitation.revoked'],
  isKnownTrigger: () => true,
  publish: async () => ({ dispatched: 0 }),
  publishDebounced: async () => {},
  resetForTests: () => {},
};

const emailMock = {
  isConfigured: () => state.smtpConfigured,
  sendEmailVerification: async () => {},
  sendOrgWelcome: async (user, org) => { state.welcomeCalls.push({ user, org }); return true; },
  sendRoleChangeNotification: async (user, org, oldRole, newRole) => {
    state.roleChangeCalls.push({ user, org, oldRole, newRole });
    return true;
  },
};

require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authMock };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: auditMock };
require.cache[triggersPath] = { id: triggersPath, filename: triggersPath, loaded: true, exports: triggersMock };
require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: emailMock };

delete require.cache[evPath];
delete require.cache[orgsRoutePath];
const orgsRouter = require(orgsRoutePath);

function call({ method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/orgs', orgsRouter);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method, headers: { 'content-type': 'application/json' } },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => {
            server.close();
            let json = null; try { json = buf ? JSON.parse(buf) : null; } catch { /* noop */ }
            resolve({ status: res.statusCode, body: json });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

function reset() {
  state.user = { id: 'u-invitee', email: 'invitee@x.com', name: 'I', emailVerifiedAt: new Date() };
  state.invitations = [{
    id: 'inv-1', orgId: 'org-1', email: 'invitee@x.com', role: 'MEMBER',
    token: 'i'.repeat(32), acceptedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(),
  }];
  state.memberships = [];
  state.users = [
    { id: 'u-caller', email: 'caller@x.com', name: 'Caller' },
    { id: 'u-invitee', email: 'invitee@x.com', name: 'Invitee' },
    { id: 'u-target', email: 'target@x.com', name: 'Target' },
    { id: 'u-admin', email: 'admin@x.com', name: 'Admin' },
  ];
  state.orgs = [{ id: 'org-1', name: 'Acme', slug: 'acme' }];
  state.welcomeCalls = [];
  state.roleChangeCalls = [];
  state.smtpConfigured = true;
  auditMock._calls.length = 0;
}

describe('org member email notifications', () => {
  beforeEach(reset);

  test('invitation accept → sendOrgWelcome called + audit welcomeEmailSent=true', async () => {
    const token = 'i'.repeat(32);
    const res = await call({ method: 'POST', urlPath: `/api/orgs/invitation/${token}/accept` });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    // Allow microtasks for fire-and-forget
    await new Promise((r) => setImmediate(r));
    assert.equal(state.welcomeCalls.length, 1, 'welcome email sent');
    assert.equal(state.welcomeCalls[0].user.email, 'invitee@x.com');
    assert.equal(state.welcomeCalls[0].org.id, 'org-1');
    const auditRow = auditMock._calls.find((c) => c.action === 'org_invite_accept');
    assert.ok(auditRow, 'audit row exists');
    assert.equal(auditRow.metadata.welcomeEmailSent, true);
  });

  test('invitation accept w/ SMTP disabled → no email + audit welcomeEmailSent=false', async () => {
    state.smtpConfigured = false;
    const token = 'i'.repeat(32);
    const res = await call({ method: 'POST', urlPath: `/api/orgs/invitation/${token}/accept` });
    assert.equal(res.status, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(state.welcomeCalls.length, 0);
    const auditRow = auditMock._calls.find((c) => c.action === 'org_invite_accept');
    assert.equal(auditRow.metadata.welcomeEmailSent, false);
  });

  test('role change → sendRoleChangeNotification called + audit roleChangeEmailSent=true', async () => {
    // Caller is OWNER admin; target exists as MEMBER.
    state.user = { id: 'u-admin', email: 'admin@x.com', name: 'Admin', emailVerifiedAt: new Date() };
    state.memberships = [
      { id: 'm-admin', orgId: 'org-1', userId: 'u-admin', role: 'OWNER' },
      { id: 'm-target', orgId: 'org-1', userId: 'u-target', role: 'MEMBER' },
    ];
    const res = await call({
      method: 'POST',
      urlPath: '/api/orgs/org-1/members/u-target/role',
      body: { role: 'ADMIN' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'ADMIN');
    await new Promise((r) => setImmediate(r));
    assert.equal(state.roleChangeCalls.length, 1);
    const c = state.roleChangeCalls[0];
    assert.equal(c.user.email, 'target@x.com');
    assert.equal(c.org.id, 'org-1');
    assert.equal(c.oldRole, 'MEMBER');
    assert.equal(c.newRole, 'ADMIN');
    const auditRow = auditMock._calls.find((c) => c.action === 'org_member_role_change');
    assert.ok(auditRow);
    assert.equal(auditRow.metadata.roleChangeEmailSent, true);
  });

  test('role change to same role → no email, audit roleChangeEmailSent=false', async () => {
    state.user = { id: 'u-admin', email: 'admin@x.com', name: 'Admin', emailVerifiedAt: new Date() };
    state.memberships = [
      { id: 'm-admin', orgId: 'org-1', userId: 'u-admin', role: 'OWNER' },
      { id: 'm-target', orgId: 'org-1', userId: 'u-target', role: 'MEMBER' },
    ];
    const res = await call({
      method: 'POST',
      urlPath: '/api/orgs/org-1/members/u-target/role',
      body: { role: 'MEMBER' },
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(state.roleChangeCalls.length, 0);
    const auditRow = auditMock._calls.find((c) => c.action === 'org_member_role_change');
    assert.equal(auditRow.metadata.roleChangeEmailSent, false);
  });

  test('role change w/ SMTP disabled → no email, audit roleChangeEmailSent=false', async () => {
    state.smtpConfigured = false;
    state.user = { id: 'u-admin', email: 'admin@x.com', name: 'Admin', emailVerifiedAt: new Date() };
    state.memberships = [
      { id: 'm-admin', orgId: 'org-1', userId: 'u-admin', role: 'OWNER' },
      { id: 'm-target', orgId: 'org-1', userId: 'u-target', role: 'MEMBER' },
    ];
    const res = await call({
      method: 'POST',
      urlPath: '/api/orgs/org-1/members/u-target/role',
      body: { role: 'ADMIN' },
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(state.roleChangeCalls.length, 0);
    const auditRow = auditMock._calls.find((c) => c.action === 'org_member_role_change');
    assert.equal(auditRow.metadata.roleChangeEmailSent, false);
  });
});
