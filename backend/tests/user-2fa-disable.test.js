'use strict';

/**
 * Ratchet 45 — 2FA disable endpoints + /api/auth/me 2FA exposure.
 *
 * Covers:
 *   DELETE /api/users/me/2fa/totp
 *     - 403 reauth_required when neither password nor recent session present
 *     - 403 invalid_password when the wrong password is supplied
 *     - 200 with correct password — clears totpSecret + totpRecoveryCodes
 *       + totpEnabled, audits totp_disabled
 *     - 200 with a session created within the trailing 5-minute window
 *       even without a password in the body
 *
 *   DELETE /api/users/me/2fa/sms
 *     - 200 with correct password — clears twoFactorEnabled + phoneVerifiedAt
 *       but retains the phone column
 *     - 403 invalid_password on a wrong password
 *
 *   GET /api/auth/me
 *     - exposes totpEnabled / twoFactorEnabled booleans
 *     - counts only recovery codes with usedAt == null
 *
 * Uses the same require-cache mocking pattern as the existing TOTP /
 * 2FA test files so the router runs without a real DB.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-2fa-disable-jwt-secret-at-least-32-chars!!';

const authMiddlewarePath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const auditPath = path.resolve(__dirname, '../src/utils/audit-log.js');
const usersRoutePath = path.resolve(__dirname, '../src/routes/users.js');
const authRoutePath = path.resolve(__dirname, '../src/routes/auth.js');
const emailPath = path.resolve(__dirname, '../src/services/email.js');
const rateLimitAuthPath = path.resolve(__dirname, '../src/middleware/rate-limit-auth.js');
const rateLimitStorePath = path.resolve(__dirname, '../src/middleware/rate-limit-store.js');

const passwordHash = bcrypt.hashSync('correct-horse', 4);

const state = {
  user: {
    id: 'u-2fa-disable-1',
    email: 'disable@example.com',
    name: 'Disable Tester',
    password: passwordHash,
    phone: '+15551234567',
    phoneVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    twoFactorEnabled: true,
    totpSecret: 'plain:JBSWY3DPEHPK3PXP',
    totpEnabled: true,
    totpRecoveryCodes: [
      { hash: 'h1', usedAt: null },
      { hash: 'h2', usedAt: new Date('2026-02-01T00:00:00Z') },
      { hash: 'h3', usedAt: null },
    ],
    emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    isAdmin: false,
    isSuperAdmin: false,
  },
  // Mutable per-request "session" used by the authenticateToken mock.
  session: null,
};

const authMock = {
  authenticateToken: (req, _res, next) => {
    req.user = state.user;
    req.session = state.session;
    next();
  },
};

const prismaMock = {
  user: {
    findUnique: async ({ where, select }) => {
      if (where.id !== state.user.id) return null;
      if (select) {
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = state.user[k];
        return out;
      }
      return state.user;
    },
    findFirst: async () => null,
    update: async ({ where, data, select }) => {
      if (where.id !== state.user.id) return null;
      Object.assign(state.user, data);
      if (select) {
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = state.user[k];
        return out;
      }
      return state.user;
    },
  },
  session: {
    deleteMany: async () => ({ count: 0 }),
    update: async () => null,
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
      const payload = body === undefined ? null : JSON.stringify(body);
      const headers = { 'content-type': 'application/json' };
      // express.json() doesn't parse DELETE bodies without Content-Length
      // because Node uses chunked encoding by default for streamed writes.
      if (payload !== null) headers['content-length'] = Buffer.byteLength(payload);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers,
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
      if (payload !== null) req.write(payload);
      req.end();
    });
  });
}

function resetState() {
  state.user.password = passwordHash;
  state.user.phone = '+15551234567';
  state.user.phoneVerifiedAt = new Date('2026-01-01T00:00:00Z');
  state.user.twoFactorEnabled = true;
  state.user.totpSecret = 'plain:JBSWY3DPEHPK3PXP';
  state.user.totpEnabled = true;
  state.user.totpRecoveryCodes = [
    { hash: 'h1', usedAt: null },
    { hash: 'h2', usedAt: new Date('2026-02-01T00:00:00Z') },
    { hash: 'h3', usedAt: null },
  ];
  state.session = null;
  auditMock._calls.length = 0;
}

describe('DELETE /api/users/me/2fa/totp', () => {
  beforeEach(resetState);

  test('403 reauth_required without password and without recent session', async () => {
    state.session = { id: 's1', createdAt: new Date(Date.now() - 60 * 60 * 1000) };
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/users/me/2fa/totp',
      body: {},
      mount: '/api/users',
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'reauth_required');
    assert.equal(state.user.totpEnabled, true);
    assert.equal(state.user.totpSecret, 'plain:JBSWY3DPEHPK3PXP');
  });

  test('403 invalid_password when wrong password is supplied', async () => {
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/users/me/2fa/totp',
      body: { currentPassword: 'nope' },
      mount: '/api/users',
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'invalid_password');
    assert.equal(state.user.totpEnabled, true);
  });

  test('200 with correct password — clears secret + recovery codes + enabled flag', async () => {
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/users/me/2fa/totp',
      body: { currentPassword: 'correct-horse' },
      mount: '/api/users',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.totpEnabled, false);
    assert.equal(state.user.totpEnabled, false);
    assert.equal(state.user.totpSecret, null);
    assert.equal(state.user.totpRecoveryCodes, null);
    assert.ok(auditMock._calls.some((c) => c.action === 'totp_disabled'));
  });

  test('200 with recent session (< 5min) — no password required', async () => {
    state.session = { id: 's2', createdAt: new Date(Date.now() - 60 * 1000) };
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/users/me/2fa/totp',
      body: {},
      mount: '/api/users',
    });
    assert.equal(res.status, 200);
    assert.equal(state.user.totpEnabled, false);
    assert.equal(state.user.totpSecret, null);
    assert.equal(state.user.totpRecoveryCodes, null);
  });
});

describe('DELETE /api/users/me/2fa/sms', () => {
  beforeEach(resetState);

  test('200 with correct password — clears flags but keeps phone column', async () => {
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/users/me/2fa/sms',
      body: { currentPassword: 'correct-horse' },
      mount: '/api/users',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.twoFactorEnabled, false);
    assert.equal(state.user.twoFactorEnabled, false);
    assert.equal(state.user.phoneVerifiedAt, null);
    // Phone retained.
    assert.equal(state.user.phone, '+15551234567');
    assert.ok(auditMock._calls.some((c) => c.action === 'two_factor_sms_disabled'));
  });

  test('403 invalid_password on wrong password', async () => {
    const res = await callRoute({
      method: 'DELETE',
      urlPath: '/api/users/me/2fa/sms',
      body: { currentPassword: 'wrong' },
      mount: '/api/users',
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'invalid_password');
    assert.equal(state.user.twoFactorEnabled, true);
    assert.ok(state.user.phoneVerifiedAt instanceof Date);
  });
});

describe('GET /api/auth/me — 2FA fields', () => {
  beforeEach(resetState);

  test('exposes totpEnabled / twoFactorEnabled / recovery-codes-remaining', async () => {
    const res = await callRoute({
      method: 'GET',
      urlPath: '/api/auth/me',
      mount: '/api/auth',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.totpEnabled, true);
    assert.equal(res.body.twoFactorEnabled, true);
    // 2 of 3 stored entries have usedAt == null.
    assert.equal(res.body.totpRecoveryCodesRemaining, 2);
  });

  test('counts 0 when totpRecoveryCodes is null', async () => {
    state.user.totpRecoveryCodes = null;
    const res = await callRoute({
      method: 'GET',
      urlPath: '/api/auth/me',
      mount: '/api/auth',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.totpRecoveryCodesRemaining, 0);
  });

  // Ratchet 45 — totpSetupInitiated lets the settings UI detect a
  // half-completed enrolment (secret persisted but the user never
  // confirmed the first code, so totpEnabled is still false).
  test('totpSetupInitiated=true when a totpSecret is present', async () => {
    const res = await callRoute({
      method: 'GET',
      urlPath: '/api/auth/me',
      mount: '/api/auth',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.totpSetupInitiated, true);
  });

  test('totpSetupInitiated=true even when totpEnabled is false (half-complete)', async () => {
    state.user.totpEnabled = false;
    const res = await callRoute({
      method: 'GET',
      urlPath: '/api/auth/me',
      mount: '/api/auth',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.totpEnabled, false);
    assert.equal(res.body.totpSetupInitiated, true);
  });

  test('totpSetupInitiated=false when totpSecret is missing', async () => {
    state.user.totpSecret = null;
    state.user.totpEnabled = false;
    const res = await callRoute({
      method: 'GET',
      urlPath: '/api/auth/me',
      mount: '/api/auth',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.totpSetupInitiated, false);
  });
});
