'use strict';

/**
 * Ratchet 45 — 2FA opt-in flag + login enforcement.
 *
 * Covers:
 *   PATCH /api/users/me/2fa { enabled }
 *     - rejects opt-in when phone is not verified
 *     - allows opt-in when phoneVerifiedAt is set
 *     - allows opt-out unconditionally
 *     - audits enable/disable transitions
 *
 *   POST /api/auth/login
 *     - returns 202 { twoFactorRequired, challengeId } when the user has
 *       twoFactorEnabled + phoneVerifiedAt + a valid phone
 *     - preserves the cycle-0 200 + JWT response when 2FA is disabled
 *     - skips the gate when phoneVerifiedAt is null even if opted in
 *
 * Mocks prisma + auth + audit-log + rate-limit modules via the require
 * cache so both routers run without a DB / Twilio / SMTP.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-2fa-opt-in-jwt-secret-at-least-32-chars!!';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.TWILIO_MESSAGING_SERVICE_SID;

const authMiddlewarePath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const auditPath = path.resolve(__dirname, '../src/utils/audit-log.js');
const emailPath = path.resolve(__dirname, '../src/services/email.js');
const rateLimitAuthPath = path.resolve(__dirname, '../src/middleware/rate-limit-auth.js');
const rateLimitStorePath = path.resolve(__dirname, '../src/middleware/rate-limit-store.js');
const usersRoutePath = path.resolve(__dirname, '../src/routes/users.js');
const authRoutePath = path.resolve(__dirname, '../src/routes/auth.js');
const twoFAPath = path.resolve(__dirname, '../src/services/two-fa-sms.js');

const passwordHash = bcrypt.hashSync('correct-horse', 4);

const state = {
  user: {
    id: 'u-1',
    email: 'a@example.com',
    name: 'Alice',
    password: passwordHash,
    phone: '+14155551234',
    phoneVerifiedAt: new Date(),
    twoFactorEnabled: false,
    isAdmin: false,
    isSuperAdmin: false,
  },
  rows: [], // TwoFAChallenge rows
  sessions: [],
};

const authMock = {
  authenticateToken: (req, _res, next) => { req.user = state.user; next(); },
};

const prismaMock = {
  user: {
    findUnique: async ({ where, select }) => {
      let row = null;
      if (where.email) row = state.user.email === where.email ? state.user : null;
      else if (where.id) row = state.user.id === where.id ? state.user : null;
      if (!row) return null;
      if (select) {
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = row[k];
        return out;
      }
      return row;
    },
    findFirst: async ({ where }) => {
      if (where && where.phone && state.user.phone === where.phone) return state.user;
      return null;
    },
    update: async ({ where, data, select }) => {
      if (state.user.id !== where.id) return null;
      Object.assign(state.user, data);
      if (select) {
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = state.user[k];
        return out;
      }
      return state.user;
    },
  },
  twoFAChallenge: {
    create: async ({ data }) => {
      const row = {
        id: `c-${state.rows.length + 1}`,
        attempts: 0,
        consumedAt: null,
        createdAt: new Date(),
        ...data,
      };
      state.rows.push(row);
      return row;
    },
    findUnique: async ({ where }) =>
      state.rows.find((r) => r.challengeId === where.challengeId) || null,
    update: async ({ where, data }) => {
      const r = state.rows.find((x) => x.id === where.id);
      if (r) Object.assign(r, data);
      return r;
    },
    updateMany: async ({ where, data }) => {
      let n = 0;
      for (const r of state.rows) {
        if (r.userId === where.userId
          && (where.consumedAt === null ? r.consumedAt === null : true)) {
          Object.assign(r, data);
          n += 1;
        }
      }
      return { count: n };
    },
  },
  session: {
    create: async ({ data }) => {
      const row = { id: `s-${state.sessions.length + 1}`, createdAt: new Date(), ...data };
      state.sessions.push(row);
      return row;
    },
  },
  organization: {
    findFirst: async () => null,
  },
};

const auditMock = {
  _calls: [],
  writeAuditLog: (_db, payload) => { auditMock._calls.push(payload); },
};

const emailMock = {
  sendEmailVerification: async () => {},
  isConfigured: () => false,
};

const rateLimitAuthMock = {
  makeAuthRateLimit: () => (_req, _res, next) => next(),
};

const rateLimitStoreMock = {
  consume: async (_key, _limit, windowMs) => ({
    allowed: true,
    resetAt: new Date(Date.now() + windowMs),
  }),
};

require.cache[authMiddlewarePath] = {
  id: authMiddlewarePath, filename: authMiddlewarePath, loaded: true, exports: authMock,
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: prismaMock,
};
require.cache[auditPath] = {
  id: auditPath, filename: auditPath, loaded: true, exports: auditMock,
};
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, exports: emailMock,
};
require.cache[rateLimitAuthPath] = {
  id: rateLimitAuthPath, filename: rateLimitAuthPath, loaded: true, exports: rateLimitAuthMock,
};
require.cache[rateLimitStorePath] = {
  id: rateLimitStorePath, filename: rateLimitStorePath, loaded: true, exports: rateLimitStoreMock,
};

delete require.cache[twoFAPath];
delete require.cache[usersRoutePath];
delete require.cache[authRoutePath];
const usersRouter = require(usersRoutePath);
const authRouter = require(authRoutePath);

function callRoute({ method, urlPath, body, mount }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use(mount, mount === '/api/auth' ? authRouter : usersRouter);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers: { 'content-type': 'application/json' },
        },
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
  state.user.phone = '+14155551234';
  state.user.phoneVerifiedAt = new Date();
  state.user.twoFactorEnabled = false;
  state.user.password = passwordHash;
  state.rows.length = 0;
  state.sessions.length = 0;
  auditMock._calls.length = 0;
}

describe('PATCH /api/users/me/2fa', () => {
  beforeEach(resetState);

  test('400 when "enabled" is not a boolean', async () => {
    const res = await callRoute({
      method: 'PATCH',
      urlPath: '/api/users/me/2fa',
      body: { enabled: 'yes' },
      mount: '/api/users',
    });
    assert.equal(res.status, 400);
  });

  test('rejects opt-in when phone is not verified', async () => {
    state.user.phoneVerifiedAt = null;
    const res = await callRoute({
      method: 'PATCH',
      urlPath: '/api/users/me/2fa',
      body: { enabled: true },
      mount: '/api/users',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'phone_not_verified');
    assert.equal(state.user.twoFactorEnabled, false);
  });

  test('allows opt-in when phoneVerifiedAt is set + audits', async () => {
    const res = await callRoute({
      method: 'PATCH',
      urlPath: '/api/users/me/2fa',
      body: { enabled: true },
      mount: '/api/users',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.twoFactorEnabled, true);
    assert.equal(state.user.twoFactorEnabled, true);
    assert.ok(auditMock._calls.some((c) => c.action === 'two_factor_enabled'));
  });

  test('allows opt-out even without a verified phone + audits', async () => {
    state.user.twoFactorEnabled = true;
    state.user.phoneVerifiedAt = null;
    const res = await callRoute({
      method: 'PATCH',
      urlPath: '/api/users/me/2fa',
      body: { enabled: false },
      mount: '/api/users',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.twoFactorEnabled, false);
    assert.equal(state.user.twoFactorEnabled, false);
    assert.ok(auditMock._calls.some((c) => c.action === 'two_factor_disabled'));
  });
});

describe('POST /api/auth/login — 2FA enforcement', () => {
  beforeEach(resetState);

  test('returns full JWT (200) when 2FA disabled (cycle 0 behaviour)', async () => {
    state.user.twoFactorEnabled = false;
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/login',
      body: { email: 'a@example.com', password: 'correct-horse' },
      mount: '/api/auth',
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(res.body.twoFactorRequired, undefined);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.rows.length, 0);
  });

  test('returns 202 { twoFactorRequired, challengeId } when opted in + phone verified', async () => {
    state.user.twoFactorEnabled = true;
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/login',
      body: { email: 'a@example.com', password: 'correct-horse' },
      mount: '/api/auth',
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.twoFactorRequired, true);
    assert.ok(typeof res.body.challengeId === 'string' && res.body.challengeId.length >= 16);
    assert.ok(res.body.expiresAt);
    // No JWT, no session yet — only the challenge row.
    assert.equal(res.body.token, undefined);
    assert.equal(state.sessions.length, 0);
    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0].channel, 'sms');
    assert.ok(auditMock._calls.some((c) => c.action === 'login_2fa_required'));
  });

  test('falls back to full JWT when twoFactorEnabled but phoneVerifiedAt missing', async () => {
    state.user.twoFactorEnabled = true;
    state.user.phoneVerifiedAt = null;
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/login',
      body: { email: 'a@example.com', password: 'correct-horse' },
      mount: '/api/auth',
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(state.rows.length, 0);
    assert.equal(state.sessions.length, 1);
  });

  test('401 on wrong password — gate never reached', async () => {
    state.user.twoFactorEnabled = true;
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/login',
      body: { email: 'a@example.com', password: 'WRONG' },
      mount: '/api/auth',
    });
    assert.equal(res.status, 401);
    assert.equal(state.rows.length, 0);
    assert.equal(state.sessions.length, 0);
  });
});
