'use strict';

/**
 * Ratchet 45 — POST /api/orgs/invitation/:token/accept must require a
 * verified email before promoting the invitee to OrgMembership.
 *
 * Two paths:
 *   • user.emailVerifiedAt = null → 202 needs_verification, no membership
 *   • user.emailVerifiedAt set    → 200 + membership created (as before)
 *
 * Pure-JS fake prisma — no DB, no SMTP.
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
  user: { id: 'u-invitee', email: 'invitee@x.com', name: 'I', emailVerifiedAt: null },
  invitations: [],
  memberships: [],
  tokens: [],
  emailCalls: [],
};

const authMock = {
  authenticateToken: (req, _res, next) => {
    req.user = state.user;
    next();
  },
};

const prismaMock = {
  orgInvitation: {
    findUnique: async ({ where }) => {
      const r = state.invitations.find((x) => x.token === where.token);
      if (!r) return null;
      return { ...r, organization: { id: r.orgId, name: 'Org', slug: 'org' } };
    },
    update: async ({ where, data }) => {
      const r = state.invitations.find((x) => x.id === where.id);
      Object.assign(r, data);
      return r;
    },
  },
  orgMembership: {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      return state.memberships.find((m) => m.orgId === orgId && m.userId === userId) || null;
    },
    create: async ({ data }) => {
      const m = { id: `m-${state.memberships.length + 1}`, ...data };
      state.memberships.push(m);
      return m;
    },
  },
  emailVerificationToken: {
    create: async ({ data }) => {
      const row = { id: `t-${state.tokens.length + 1}`, consumedAt: null, createdAt: new Date(), ...data };
      state.tokens.push(row);
      return row;
    },
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

const triggerCalls = [];
const triggersMock = {
  TRIGGERS: ['org.invitation.created', 'org.invitation.accepted', 'org.invitation.revoked'],
  isKnownTrigger: () => true,
  publish: async (event, payload, userId) => { triggerCalls.push({ event, payload, userId }); return { dispatched: 0 }; },
  publishDebounced: async () => {},
  resetForTests: () => {},
};

const emailMock = {
  sendEmailVerification: async (user, token) => { state.emailCalls.push({ user, token }); },
  isConfigured: () => true,
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
  state.user = { id: 'u-invitee', email: 'invitee@x.com', name: 'I', emailVerifiedAt: null };
  state.invitations = [{
    id: 'inv-1', orgId: 'org-1', email: 'invitee@x.com', role: 'MEMBER',
    token: 'i'.repeat(32), acceptedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(),
  }];
  state.memberships = [];
  state.tokens = [];
  state.emailCalls = [];
  auditMock._calls.length = 0;
  triggerCalls.length = 0;
}

describe('POST /api/orgs/invitation/:token/accept · email verification gate', () => {
  beforeEach(reset);

  test('unverified user → 202 needs_verification, no membership created, verification email sent', async () => {
    const token = 'i'.repeat(32);
    const res = await call({ method: 'POST', urlPath: `/api/orgs/invitation/${token}/accept` });
    assert.equal(res.status, 202);
    assert.equal(res.body.needs_verification, true);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.expiresAt);
    assert.equal(state.memberships.length, 0, 'no membership before verification');
    assert.equal(state.invitations[0].acceptedAt, null, 'invitation stays pending');
    assert.equal(state.tokens.length, 1, 'one verification token minted');
    assert.equal(state.emailCalls.length, 1, 'verification email sent');
    assert.equal(state.emailCalls[0].user.email, 'invitee@x.com');
    assert.equal(triggerCalls.length, 0, 'no org.invitation.accepted trigger fires yet');
  });

  test('verified user → 200, membership created, trigger fires', async () => {
    state.user.emailVerifiedAt = new Date();
    const token = 'i'.repeat(32);
    const res = await call({ method: 'POST', urlPath: `/api/orgs/invitation/${token}/accept` });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.role, 'MEMBER');
    assert.equal(state.memberships.length, 1);
    assert.equal(state.memberships[0].userId, 'u-invitee');
    assert.equal(state.invitations[0].acceptedAt instanceof Date, true);
    assert.equal(state.tokens.length, 0, 'no verification token needed when already verified');
    assert.equal(triggerCalls.length, 1);
    assert.equal(triggerCalls[0].event, 'org.invitation.accepted');
  });

  test('email mismatch still blocks before verification gate', async () => {
    state.user.email = 'other@x.com';
    const token = 'i'.repeat(32);
    const res = await call({ method: 'POST', urlPath: `/api/orgs/invitation/${token}/accept` });
    assert.equal(res.status, 403);
    assert.equal(state.tokens.length, 0, 'no verification minted on email mismatch');
  });
});
