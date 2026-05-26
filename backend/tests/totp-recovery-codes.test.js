'use strict';

/**
 * Ratchet 45 (Task 2) — TOTP recovery codes.
 *
 * Covers:
 *   Helpers (users.js INTERNAL):
 *     - generateRecoveryCodeSet returns 10 × 16-char plaintext codes
 *     - hashRecoveryCode is deterministic + tolerates hyphens/spaces/case
 *     - generated codes are alphanumeric (Crockford-style alphabet)
 *
 *   POST /api/users/me/2fa/totp/recovery-codes
 *     - 200 returns plaintext codes ONCE, persists hashed array
 *     - 409 when totpEnabled is false
 *     - regeneration replaces the old set
 *
 *   POST /api/auth/2fa/totp/verify (recovery branch)
 *     - 200 + JWT when a recovery code is redeemed; entry is marked usedAt
 *     - 401 on unknown recovery code (partial session NOT consumed)
 *     - 401 when the same recovery code is replayed after consumption
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-totp-recovery-jwt-secret-at-least-32-chars!!';
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
const SECRET_B32 = 'JBSWY3DPEHPK3PXP';

const state = {
  user: {
    id: 'u-totp-rec-1',
    email: 'rec@example.com',
    name: 'Rec',
    password: passwordHash,
    phone: null,
    phoneVerifiedAt: null,
    twoFactorEnabled: false,
    totpEnabled: true,
    totpSecret: `plain:${SECRET_B32}`,
    totpRecoveryCodes: null,
    isAdmin: false,
    isSuperAdmin: false,
  },
  partial: [],
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
    create: async () => ({}),
    findUnique: async () => null,
    update: async () => null,
    updateMany: async () => ({ count: 0 }),
  },
  session: {
    create: async ({ data }) => {
      const row = { id: `s-${state.sessions.length + 1}`, createdAt: new Date(), ...data };
      state.sessions.push(row);
      return row;
    },
  },
  organization: { findFirst: async () => null },
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
const { INTERNAL } = usersRouter;

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
  state.user.twoFactorEnabled = false;
  state.user.totpEnabled = true;
  state.user.totpSecret = `plain:${SECRET_B32}`;
  state.user.totpRecoveryCodes = null;
  state.partial.length = 0;
  state.twoFAChallenges.length = 0;
  state.sessions.length = 0;
  auditMock._calls.length = 0;
}

describe('TOTP recovery code helpers', () => {
  test('generateRecoveryCodeSet returns 10 × 16-char alphanumeric codes', () => {
    const { plaintext, stored } = INTERNAL.generateRecoveryCodeSet();
    assert.equal(plaintext.length, INTERNAL.RECOVERY_CODE_COUNT);
    assert.equal(plaintext.length, 10);
    for (const code of plaintext) {
      assert.equal(code.length, INTERNAL.RECOVERY_CODE_LENGTH);
      assert.equal(code.length, 16);
      assert.match(code, /^[A-Z0-9]+$/);
    }
    assert.equal(stored.length, 10);
    for (const entry of stored) {
      assert.ok(typeof entry.hash === 'string' && entry.hash.length === 64);
      assert.equal(entry.usedAt, null);
    }
    // No duplicates within a freshly-minted batch.
    assert.equal(new Set(plaintext).size, plaintext.length);
  });

  test('hashRecoveryCode is deterministic and tolerates formatting', () => {
    const code = 'ABCD-EFGH-JKMN-PQRS';
    const a = INTERNAL.hashRecoveryCode(code);
    const b = INTERNAL.hashRecoveryCode('abcdefghjkmnpqrs');
    const c = INTERNAL.hashRecoveryCode('  ABCD efgh jkmn pqrs  ');
    assert.equal(a, b);
    assert.equal(a, c);
    assert.notEqual(a, INTERNAL.hashRecoveryCode('ABCDEFGHJKMNPQR9'));
  });
});

describe('POST /api/users/me/2fa/totp/recovery-codes', () => {
  beforeEach(resetState);

  test('returns 10 plaintext codes once and persists hashes', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/2fa/totp/recovery-codes',
      body: {},
      mount: '/api/users',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 10);
    assert.equal(res.body.recoveryCodes.length, 10);
    assert.ok(Array.isArray(state.user.totpRecoveryCodes));
    assert.equal(state.user.totpRecoveryCodes.length, 10);
    for (const entry of state.user.totpRecoveryCodes) {
      assert.equal(typeof entry.hash, 'string');
      assert.equal(entry.usedAt, null);
    }
    // Stored hashes must match what hashing the plaintext yields.
    const expectedHashes = res.body.recoveryCodes.map((c) => INTERNAL.hashRecoveryCode(c));
    const storedHashes = state.user.totpRecoveryCodes.map((e) => e.hash);
    assert.deepEqual(storedHashes.sort(), expectedHashes.sort());

    assert.ok(auditMock._calls.some((c) => c.action === 'totp_recovery_codes_generated'));
  });

  test('returns 409 when totpEnabled is false', async () => {
    state.user.totpEnabled = false;
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/2fa/totp/recovery-codes',
      body: {},
      mount: '/api/users',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'totp_not_enabled');
    assert.equal(state.user.totpRecoveryCodes, null);
  });

  test('regeneration replaces the previous set', async () => {
    const first = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/2fa/totp/recovery-codes',
      body: {},
      mount: '/api/users',
    });
    const firstCodes = first.body.recoveryCodes;
    const second = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/2fa/totp/recovery-codes',
      body: {},
      mount: '/api/users',
    });
    const secondCodes = second.body.recoveryCodes;
    assert.equal(second.status, 200);
    // None of the new codes should match the old set.
    for (const c of secondCodes) assert.ok(!firstCodes.includes(c));
    // Stored set matches the new codes only.
    const storedHashes = state.user.totpRecoveryCodes.map((e) => e.hash).sort();
    const expected = secondCodes.map((c) => INTERNAL.hashRecoveryCode(c)).sort();
    assert.deepEqual(storedHashes, expected);
  });
});

describe('POST /api/auth/2fa/totp/verify — recovery branch', () => {
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

  async function mintRecoveryCodes() {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/2fa/totp/recovery-codes',
      body: {},
      mount: '/api/users',
    });
    assert.equal(res.status, 200);
    return res.body.recoveryCodes;
  }

  test('200 + JWT when a recovery code is redeemed; entry is marked usedAt', async () => {
    const codes = await mintRecoveryCodes();
    const partialToken = await loginAndGetPartial();
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/totp/verify',
      body: { partialToken, code: codes[0] },
      mount: '/api/auth',
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(state.sessions.length, 1);
    // The matched entry now has a non-null usedAt.
    const used = state.user.totpRecoveryCodes.filter((e) => e.usedAt);
    assert.equal(used.length, 1);
    assert.ok(auditMock._calls.some((c) => c.action === 'login_totp_recovery_used'));
  });

  test('401 on unknown recovery code; partial session NOT consumed', async () => {
    await mintRecoveryCodes();
    const partialToken = await loginAndGetPartial();
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/totp/verify',
      body: { partialToken, code: 'ZZZZZZZZZZZZZZZZ' },
      mount: '/api/auth',
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'totp_invalid');
    assert.equal(state.sessions.length, 0);
    assert.equal(state.partial[0].consumedAt, null);
  });

  test('401 when the same recovery code is replayed after consumption', async () => {
    const codes = await mintRecoveryCodes();
    const code = codes[0];

    const partial1 = await loginAndGetPartial();
    const r1 = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/totp/verify',
      body: { partialToken: partial1, code },
      mount: '/api/auth',
    });
    assert.equal(r1.status, 200);

    const partial2 = await loginAndGetPartial();
    const r2 = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/totp/verify',
      body: { partialToken: partial2, code },
      mount: '/api/auth',
    });
    assert.equal(r2.status, 401);
    assert.equal(r2.body.code, 'totp_invalid');
  });
});
