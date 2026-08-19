'use strict';

/**
 * Ratchet 45 — org member removal + ownership transfer email
 * notifications.
 *
 *  • DELETE /api/orgs/:id/members/:userId (admin removes member) →
 *    sendOrgRemoval called with (user, org, removedBy); audit
 *    metadata.removalEmailSent = true.
 *
 *  • DELETE /api/orgs/:id/members/:userId where caller === target
 *    (self-leave) → NO sendOrgRemoval; audit removalEmailSent = false.
 *
 *  • SMTP unconfigured → no email + audit removalEmailSent = false.
 *
 *  • POST /api/orgs/:id/transfer-ownership →
 *    sendOwnershipTransfer called twice (once for previous owner,
 *    once for new owner) with distinct role tags; audit
 *    metadata.transferEmailSent = true.
 *
 *  • SMTP unconfigured → no transfer email + audit
 *    transferEmailSent = false.
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
const orgsRoutePath = path.resolve(__dirname, '../src/routes/orgs.js');

const state = {
  user: { id: 'u-admin', email: 'admin@x.com', name: 'Admin', emailVerifiedAt: new Date() },
  memberships: [],
  users: [],
  orgs: [],
  removalCalls: [],
  transferCalls: [],
  smtpConfigured: true,
};

const authMock = {
  authenticateToken: (req, _res, next) => { req.user = state.user; next(); },
};

const prismaMock = {
  orgMembership: {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      return state.memberships.find((x) => x.orgId === orgId && x.userId === userId) || null;
    },
    update: async ({ where, data }) => {
      const { orgId, userId } = where.orgId_userId;
      const m = state.memberships.find((x) => x.orgId === orgId && x.userId === userId);
      Object.assign(m, data);
      return m;
    },
    delete: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      const idx = state.memberships.findIndex((x) => x.orgId === orgId && x.userId === userId);
      const [m] = state.memberships.splice(idx, 1);
      return m;
    },
    count: async ({ where }) => state.memberships.filter(
      (m) => m.orgId === where.orgId && m.role === where.role,
    ).length,
  },
  user: {
    findUnique: async ({ where }) => state.users.find((u) => u.id === where.id) || null,
  },
  organization: {
    findUnique: async ({ where }) => state.orgs.find((o) => o.id === where.id) || null,
    update: async ({ where, data }) => {
      const o = state.orgs.find((x) => x.id === where.id);
      Object.assign(o, data);
      return o;
    },
  },
  $transaction: async (fn) => fn({
    orgMembership: prismaMock.orgMembership,
    organization: prismaMock.organization,
  }),
};

const auditMock = {
  _calls: [],
  writeAuditLog: (_db, payload) => { auditMock._calls.push(payload); },
};

const triggersMock = {
  TRIGGERS: [],
  isKnownTrigger: () => true,
  publish: async () => ({ dispatched: 0 }),
  publishDebounced: async () => {},
  resetForTests: () => {},
};

const emailMock = {
  isConfigured: () => state.smtpConfigured,
  sendOrgRemoval: async (user, org, removedBy) => {
    state.removalCalls.push({ user, org, removedBy });
    return true;
  },
  sendOwnershipTransfer: async (user, org, opts) => {
    state.transferCalls.push({ user, org, opts });
    return true;
  },
};

require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authMock };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: auditMock };
require.cache[triggersPath] = { id: triggersPath, filename: triggersPath, loaded: true, exports: triggersMock };
require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: emailMock };

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
  state.user = { id: 'u-admin', email: 'admin@x.com', name: 'Admin', emailVerifiedAt: new Date() };
  state.memberships = [
    { id: 'm-admin', orgId: 'org-1', userId: 'u-admin', role: 'OWNER' },
    { id: 'm-target', orgId: 'org-1', userId: 'u-target', role: 'MEMBER' },
  ];
  state.users = [
    { id: 'u-admin', email: 'admin@x.com', name: 'Admin' },
    { id: 'u-target', email: 'target@x.com', name: 'Target' },
    { id: 'u-new', email: 'new@x.com', name: 'New Owner' },
  ];
  state.orgs = [{ id: 'org-1', name: 'Acme', slug: 'acme', ownerId: 'u-admin' }];
  state.removalCalls = [];
  state.transferCalls = [];
  state.smtpConfigured = true;
  auditMock._calls.length = 0;
}

describe('org member removal + ownership transfer email notifications', () => {
  beforeEach(reset);

  test('admin remove member → sendOrgRemoval called + audit removalEmailSent=true', async () => {
    const res = await call({ method: 'DELETE', urlPath: '/api/orgs/org-1/members/u-target' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    await new Promise((r) => setImmediate(r));
    assert.equal(state.removalCalls.length, 1, 'removal email sent');
    const c = state.removalCalls[0];
    assert.equal(c.user.email, 'target@x.com');
    assert.equal(c.org.id, 'org-1');
    assert.equal(c.removedBy.id, 'u-admin');
    const auditRow = auditMock._calls.find((x) => x.action === 'org_member_remove');
    assert.ok(auditRow, 'audit row exists');
    assert.equal(auditRow.metadata.removalEmailSent, true);
  });

  test('self-leave via DELETE → no removal email + audit removalEmailSent=false', async () => {
    // Target leaves themselves.
    state.user = { id: 'u-target', email: 'target@x.com', name: 'Target', emailVerifiedAt: new Date() };
    const res = await call({ method: 'DELETE', urlPath: '/api/orgs/org-1/members/u-target' });
    assert.equal(res.status, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(state.removalCalls.length, 0);
    const auditRow = auditMock._calls.find((x) => x.action === 'org_member_leave');
    assert.ok(auditRow);
    assert.equal(auditRow.metadata.removalEmailSent, false);
  });

  test('admin remove member w/ SMTP disabled → no email + audit removalEmailSent=false', async () => {
    state.smtpConfigured = false;
    const res = await call({ method: 'DELETE', urlPath: '/api/orgs/org-1/members/u-target' });
    assert.equal(res.status, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(state.removalCalls.length, 0);
    const auditRow = auditMock._calls.find((x) => x.action === 'org_member_remove');
    assert.equal(auditRow.metadata.removalEmailSent, false);
  });

  test('transfer ownership → sendOwnershipTransfer called for both old + new owner + audit transferEmailSent=true', async () => {
    // Add the candidate new owner as a MEMBER.
    state.memberships.push({ id: 'm-new', orgId: 'org-1', userId: 'u-new', role: 'MEMBER' });
    const res = await call({
      method: 'POST',
      urlPath: '/api/orgs/org-1/transfer-ownership',
      body: { newOwnerId: 'u-new' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    await new Promise((r) => setImmediate(r));
    assert.equal(state.transferCalls.length, 2, 'two emails (previous + new owner)');
    const prevCall = state.transferCalls.find((c) => c.opts.role === 'previousOwner');
    const newCall = state.transferCalls.find((c) => c.opts.role === 'newOwner');
    assert.ok(prevCall, 'previous-owner email sent');
    assert.ok(newCall, 'new-owner email sent');
    assert.equal(prevCall.user.email, 'admin@x.com');
    assert.equal(newCall.user.email, 'new@x.com');
    assert.equal(prevCall.org.id, 'org-1');
    const auditRow = auditMock._calls.find((x) => x.action === 'org_ownership_transfer');
    assert.ok(auditRow);
    assert.equal(auditRow.metadata.transferEmailSent, true);
  });

  test('transfer ownership w/ SMTP disabled → no emails + audit transferEmailSent=false', async () => {
    state.smtpConfigured = false;
    state.memberships.push({ id: 'm-new', orgId: 'org-1', userId: 'u-new', role: 'MEMBER' });
    const res = await call({
      method: 'POST',
      urlPath: '/api/orgs/org-1/transfer-ownership',
      body: { newOwnerId: 'u-new' },
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(state.transferCalls.length, 0);
    const auditRow = auditMock._calls.find((x) => x.action === 'org_ownership_transfer');
    assert.equal(auditRow.metadata.transferEmailSent, false);
  });
});
