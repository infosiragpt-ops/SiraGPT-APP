'use strict';

/**
 * Route tests for ratchet 45 email-verification endpoints:
 *   GET  /api/auth/verify-email/:token
 *   POST /api/auth/resend-verification
 *
 * Uses require-cache module substitution so the auth router runs
 * against a pure-JS fake prisma + a stub email service. No DB, no SMTP.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-verify-email-jwt-secret-at-least-32-chars!!';

const authPath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const auditPath = path.resolve(__dirname, '../src/utils/audit-log.js');
const emailPath = path.resolve(__dirname, '../src/services/email.js');
const rateLimitPath = path.resolve(__dirname, '../src/middleware/rate-limit-auth.js');
const authRoutePath = path.resolve(__dirname, '../src/routes/auth.js');
const evPath = path.resolve(__dirname, '../src/services/email-verification.js');

const state = {
  user: { id: 'u-1', email: 'u@x.com', name: 'U', emailVerifiedAt: null },
  tokens: [], // { id, userId, token, expiresAt, consumedAt }
  emailCalls: [],
};

const authMock = {
  authenticateToken: (req, _res, next) => {
    req.user = state.user;
    next();
  },
};

const prismaMock = {
  emailVerificationToken: {
    create: async ({ data }) => {
      const row = { id: `t-${state.tokens.length + 1}`, consumedAt: null, createdAt: new Date(), ...data };
      state.tokens.push(row);
      return row;
    },
    findUnique: async ({ where }) => state.tokens.find((r) => r.token === where.token) || null,
    update: async ({ where, data }) => {
      const r = state.tokens.find((x) => x.id === where.id);
      Object.assign(r, data);
      return r;
    },
  },
  user: {
    update: async ({ where, data }) => {
      if (state.user.id === where.id) Object.assign(state.user, data);
      return state.user;
    },
  },
  $transaction: async (fn) => fn({
    user: prismaMock.user,
    emailVerificationToken: prismaMock.emailVerificationToken,
  }),
};

const auditMock = {
  _calls: [],
  writeAuditLog: (_db, payload) => { auditMock._calls.push(payload); },
};

const emailMock = {
  sendEmailVerification: async (user, token) => {
    state.emailCalls.push({ user, token });
  },
  isConfigured: () => true,
};

// rate-limit-auth must be a pass-through in tests so we don't trip the
// limiter across describe blocks.
const rateLimitMock = {
  makeAuthRateLimit: () => (_req, _res, next) => next(),
};

require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authMock };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: auditMock };
require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: emailMock };
require.cache[rateLimitPath] = { id: rateLimitPath, filename: rateLimitPath, loaded: true, exports: rateLimitMock };

// Force fresh load of the email-verification module + auth router so
// they bind against the mocks above.
delete require.cache[evPath];
delete require.cache[authRoutePath];
const authRouter = require(authRoutePath);

function callRoute({ method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method, headers: { 'content-type': 'application/json' } },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => {
            server.close();
            let json = null;
            try { json = buf ? JSON.parse(buf) : null; } catch { /* noop */ }
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

function resetState() {
  state.user = { id: 'u-1', email: 'u@x.com', name: 'U', emailVerifiedAt: null };
  state.tokens.length = 0;
  state.emailCalls.length = 0;
  auditMock._calls.length = 0;
}

describe('GET /api/auth/verify-email/:token', () => {
  beforeEach(resetState);

  test('redeems a valid token and sets emailVerifiedAt', async () => {
    const token = 'a'.repeat(64);
    state.tokens.push({
      id: 't-1', userId: 'u-1', token,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null, createdAt: new Date(),
    });
    const res = await callRoute({ method: 'GET', urlPath: `/api/auth/verify-email/${token}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.userId, 'u-1');
    assert.ok(state.user.emailVerifiedAt instanceof Date);
    assert.ok(state.tokens[0].consumedAt instanceof Date);
    assert.ok(auditMock._calls.some((c) => c.action === 'email_verified'));
  });

  test('short token returns 400', async () => {
    const res = await callRoute({ method: 'GET', urlPath: '/api/auth/verify-email/short' });
    assert.equal(res.status, 400);
  });

  test('unknown token returns 404', async () => {
    const res = await callRoute({ method: 'GET', urlPath: `/api/auth/verify-email/${'z'.repeat(64)}` });
    assert.equal(res.status, 404);
  });

  test('expired token returns 410', async () => {
    const token = 'b'.repeat(64);
    state.tokens.push({
      id: 't-2', userId: 'u-1', token,
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null, createdAt: new Date(),
    });
    const res = await callRoute({ method: 'GET', urlPath: `/api/auth/verify-email/${token}` });
    assert.equal(res.status, 410);
  });

  test('already-consumed token returns 409', async () => {
    const token = 'c'.repeat(64);
    state.tokens.push({
      id: 't-3', userId: 'u-1', token,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: new Date(), createdAt: new Date(),
    });
    const res = await callRoute({ method: 'GET', urlPath: `/api/auth/verify-email/${token}` });
    assert.equal(res.status, 409);
  });
});

describe('POST /api/auth/resend-verification', () => {
  beforeEach(resetState);

  test('mints a fresh token and calls the email service', async () => {
    const res = await callRoute({ method: 'POST', urlPath: '/api/auth/resend-verification' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.expiresAt);
    assert.equal(state.tokens.length, 1);
    assert.equal(state.emailCalls.length, 1);
    assert.equal(state.emailCalls[0].user.email, 'u@x.com');
    assert.equal(state.emailCalls[0].token, state.tokens[0].token);
    assert.ok(auditMock._calls.some((c) => c.action === 'verification_resent'));
  });

  test('already-verified user → 200 alreadyVerified, no token minted', async () => {
    state.user.emailVerifiedAt = new Date();
    const res = await callRoute({ method: 'POST', urlPath: '/api/auth/resend-verification' });
    assert.equal(res.status, 200);
    assert.equal(res.body.alreadyVerified, true);
    assert.equal(state.tokens.length, 0);
    assert.equal(state.emailCalls.length, 0);
  });
});
