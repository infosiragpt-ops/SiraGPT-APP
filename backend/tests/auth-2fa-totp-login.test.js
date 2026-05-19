'use strict';

/**
 * Ratchet 45 — TOTP login gate (extends cycle 134 SMS 2FA).
 *
 * Covers:
 *   POST /api/auth/login
 *     - returns 202 { twoFactorRequired, method:'totp', partialToken }
 *       when totpEnabled=true AND twoFactorEnabled=false
 *     - SMS path still wins when twoFactorEnabled=true (cycle 134
 *       behaviour is preserved)
 *     - skips the TOTP gate entirely when totpEnabled=false
 *
 *   POST /api/auth/2fa/totp/verify
 *     - 200 + full JWT on a valid code redeemed against a fresh partial
 *       token
 *     - 401 on wrong code (partial session NOT consumed)
 *     - 404 on unknown partial token
 *     - 410 on expired partial token
 *     - 409 on a second redemption of the same token (single-use)
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-2fa-totp-login-jwt-secret-at-least-32-chars!!';
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

// Use a known base32 secret so we can deterministically compute the TOTP.
const SECRET_B32 = 'JBSWY3DPEHPK3PXP';

const state = {
  user: {
    id: 'u-totp-login-1',
    email: 'totp-login@example.com',
    name: 'Totp Login',
    password: passwordHash,
    phone: '+14155550199',
    phoneVerifiedAt: null,
    twoFactorEnabled: false,
    totpEnabled: true,
    totpSecret: `plain:${SECRET_B32}`,
    isAdmin: false,
    isSuperAdmin: false,
  },
  partial: [], // PartialSession rows
  twoFAChallenges: [],
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
    findFirst: async () => null,
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
  partialSession: {
    create: async ({ data }) => {
      const row = {
        id: `ps-${state.partial.length + 1}`,
        consumedAt: null,
        createdAt: new Date(),
        ...data,
      };
      state.partial.push(row);
      return row;
    },
    findUnique: async ({ where }) =>
      state.partial.find((r) => r.token === where.token) || null,
    updateMany: async ({ where, data }) => {
      let n = 0;
      for (const r of state.partial) {
        if (r.token !== where.token) continue;
        if (where.consumedAt === null && r.consumedAt !== null) continue;
        Object.assign(r, data);
        n += 1;
      }
      return { count: n };
    },
  },
  twoFAChallenge: {
    create: async ({ data }) => {
      const row = {
        id: `c-${state.twoFAChallenges.length + 1}`,
        attempts: 0,
        consumedAt: null,
        createdAt: new Date(),
        ...data,
      };
      state.twoFAChallenges.push(row);
      return row;
    },
    findUnique: async ({ where }) =>
      state.twoFAChallenges.find((r) => r.challengeId === where.challengeId) || null,
    update: async ({ where, data }) => {
      const r = state.twoFAChallenges.find((x) => x.id === where.id);
      if (r) Object.assign(r, data);
      return r;
    },
    updateMany: async () => ({ count: 0 }),
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
const { generateTotp, base32Decode } = require('../src/services/auth/totp');

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
  state.user.password = passwordHash;
  state.user.phone = '+14155550199';
  state.user.phoneVerifiedAt = null;
  state.user.twoFactorEnabled = false;
  state.user.totpEnabled = true;
  state.user.totpSecret = `plain:${SECRET_B32}`;
  state.partial.length = 0;
  state.twoFAChallenges.length = 0;
  state.sessions.length = 0;
  auditMock._calls.length = 0;
}

describe('POST /api/auth/login — TOTP gate', () => {
  beforeEach(resetState);

  test('returns 202 { twoFactorRequired, method:totp, partialToken } when totpEnabled and SMS off', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/login',
      body: { email: state.user.email, password: 'correct-horse' },
      mount: '/api/auth',
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.twoFactorRequired, true);
    assert.equal(res.body.method, 'totp');
    assert.ok(typeof res.body.partialToken === 'string'
      && res.body.partialToken.length >= 32);
    assert.ok(res.body.expiresAt);
    assert.equal(res.body.token, undefined);
    assert.equal(state.sessions.length, 0);
    assert.equal(state.partial.length, 1);
    assert.ok(auditMock._calls.some((c) => c.action === 'login_totp_required'));
  });

  test('SMS path wins when twoFactorEnabled=true (cycle 134 preserved)', async () => {
    state.user.twoFactorEnabled = true;
    state.user.phoneVerifiedAt = new Date();
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/login',
      body: { email: state.user.email, password: 'correct-horse' },
      mount: '/api/auth',
    });
    assert.equal(res.status, 202);
    // SMS challenge response does NOT include `method` (TOTP-only field).
    assert.equal(res.body.method, undefined);
    assert.ok(res.body.challengeId);
    assert.equal(state.partial.length, 0);
    assert.equal(state.twoFAChallenges.length, 1);
  });

  test('falls back to full JWT when neither totp nor sms enabled', async () => {
    state.user.totpEnabled = false;
    state.user.twoFactorEnabled = false;
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/login',
      body: { email: state.user.email, password: 'correct-horse' },
      mount: '/api/auth',
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.partial.length, 0);
  });
});

describe('POST /api/auth/2fa/totp/verify', () => {
  beforeEach(resetState);

  async function loginAndGetPartial() {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/login',
      body: { email: state.user.email, password: 'correct-horse' },
      mount: '/api/auth',
    });
    assert.equal(res.status, 202);
    return res.body.partialToken;
  }

  test('200 + full JWT on valid code', async () => {
    const partialToken = await loginAndGetPartial();
    const code = generateTotp(base32Decode(SECRET_B32));
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/totp/verify',
      body: { partialToken, code },
      mount: '/api/auth',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.token);
    assert.equal(state.sessions.length, 1);
    assert.ok(state.partial[0].consumedAt instanceof Date);
    assert.ok(auditMock._calls.some((c) => c.action === 'login_totp_verified'));
  });

  test('401 on wrong code; partial session NOT consumed', async () => {
    const partialToken = await loginAndGetPartial();
    const right = generateTotp(base32Decode(SECRET_B32));
    const wrong = right === '000000' ? '111111' : '000000';
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/totp/verify',
      body: { partialToken, code: wrong },
      mount: '/api/auth',
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'totp_invalid');
    assert.equal(state.sessions.length, 0);
    assert.equal(state.partial[0].consumedAt, null);
  });

  test('404 on unknown partial token', async () => {
    const code = generateTotp(base32Decode(SECRET_B32));
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/totp/verify',
      body: { partialToken: 'a'.repeat(64), code },
      mount: '/api/auth',
    });
    assert.equal(res.status, 404);
  });

  test('410 on expired partial token', async () => {
    const partialToken = await loginAndGetPartial();
    // Backdate the expiry by 10 minutes.
    state.partial[0].expiresAt = new Date(Date.now() - 10 * 60 * 1000);
    const code = generateTotp(base32Decode(SECRET_B32));
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/totp/verify',
      body: { partialToken, code },
      mount: '/api/auth',
    });
    assert.equal(res.status, 410);
    assert.equal(state.sessions.length, 0);
  });

  test('409 on second redemption (single-use)', async () => {
    const partialToken = await loginAndGetPartial();
    const code = generateTotp(base32Decode(SECRET_B32));
    const first = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/totp/verify',
      body: { partialToken, code },
      mount: '/api/auth',
    });
    assert.equal(first.status, 200);
    const second = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/totp/verify',
      body: { partialToken, code },
      mount: '/api/auth',
    });
    assert.equal(second.status, 409);
    assert.equal(state.sessions.length, 1);
  });

  test('400 on malformed code', async () => {
    const partialToken = await loginAndGetPartial();
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/totp/verify',
      body: { partialToken, code: 'abc' },
      mount: '/api/auth',
    });
    assert.equal(res.status, 400);
  });
});
