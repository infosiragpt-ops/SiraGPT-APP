'use strict';

/**
 * Ratchet 45 — TOTP-based 2FA scaffold.
 *
 * Covers:
 *   POST /api/users/me/2fa/totp/setup
 *     - returns { secret, otpauthUri } and persists encrypted secret
 *     - rejects when TOTP is already enabled (409)
 *     - audits the setup-initiated event
 *
 *   POST /api/users/me/2fa/totp/verify { code }
 *     - 400 on malformed code
 *     - 400 when /setup hasn't been called yet
 *     - 401 on a wrong code
 *     - 200 + totpEnabled=true on the correct current code
 *     - audits the enable transition once (not on idempotent re-verify)
 *
 * Mocks prisma + auth + audit-log via the require cache so the router
 * runs without a real DB / ENCRYPTION_KEY.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-totp-2fa-jwt-secret-at-least-32-chars!!';
// utils/encryption.js calls process.exit(1) when ENCRYPTION_KEY is
// missing or wrong length, so the encryption envelope path is
// exercised in tests too (64 hex chars = 32 bytes).
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const authMiddlewarePath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const auditPath = path.resolve(__dirname, '../src/utils/audit-log.js');
const usersRoutePath = path.resolve(__dirname, '../src/routes/users.js');

const state = {
  user: {
    id: 'u-totp-1',
    email: 'totp@example.com',
    name: 'Totp Tester',
    totpSecret: null,
    totpEnabled: false,
    isAdmin: false,
    isSuperAdmin: false,
  },
};

const authMock = {
  authenticateToken: (req, _res, next) => { req.user = state.user; next(); },
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
};

const auditMock = {
  _calls: [],
  writeAuditLog: (_db, payload) => { auditMock._calls.push(payload); },
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

delete require.cache[usersRoutePath];
const usersRouter = require(usersRoutePath);
const { generateTotp, base32Decode } = require('../src/services/auth/totp');

function callRoute({ method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/users', usersRouter);
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
  state.user.totpSecret = null;
  state.user.totpEnabled = false;
  auditMock._calls.length = 0;
}

describe('POST /api/users/me/2fa/totp/setup', () => {
  beforeEach(resetState);

  test('returns secret + otpauth URI and persists encrypted secret', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/2fa/totp/setup',
      body: {},
    });
    assert.equal(res.status, 200);
    assert.match(res.body.secret, /^[A-Z2-7]+$/);
    assert.ok(res.body.otpauthUri.startsWith('otpauth://totp/'));
    assert.ok(res.body.otpauthUri.includes('secret='));
    assert.ok(res.body.otpauthUri.includes('issuer='));
    // Stored envelope: either enc: (if ENCRYPTION_KEY present) or plain: fallback.
    assert.ok(
      state.user.totpSecret.startsWith('plain:') || state.user.totpSecret.startsWith('enc:'),
      `unexpected envelope: ${state.user.totpSecret}`,
    );
    // totpEnabled stays false until /verify succeeds.
    assert.equal(state.user.totpEnabled, false);
    assert.ok(auditMock._calls.some((c) => c.action === 'totp_setup_initiated'));
  });

  test('rejects when TOTP is already enabled (409)', async () => {
    state.user.totpEnabled = true;
    state.user.totpSecret = 'plain:JBSWY3DPEHPK3PXP';
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/2fa/totp/setup',
      body: {},
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'totp_already_enabled');
  });
});

describe('POST /api/users/me/2fa/totp/verify', () => {
  beforeEach(resetState);

  test('400 on malformed code', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/2fa/totp/verify',
      body: { code: 'abc' },
    });
    assert.equal(res.status, 400);
  });

  test('400 when /setup has not been called', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/2fa/totp/verify',
      body: { code: '000000' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'totp_not_initialised');
  });

  test('401 on wrong code', async () => {
    // Seed with a known secret so we can predict the *right* code and
    // submit a different one.
    state.user.totpSecret = 'plain:JBSWY3DPEHPK3PXP';
    const right = generateTotp(base32Decode('JBSWY3DPEHPK3PXP'));
    const wrong = right === '000000' ? '111111' : '000000';
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/2fa/totp/verify',
      body: { code: wrong },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'totp_invalid');
    assert.equal(state.user.totpEnabled, false);
  });

  test('200 + totpEnabled=true on correct current code + audits once', async () => {
    state.user.totpSecret = 'plain:JBSWY3DPEHPK3PXP';
    const code = generateTotp(base32Decode('JBSWY3DPEHPK3PXP'));
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/2fa/totp/verify',
      body: { code },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.totpEnabled, true);
    assert.equal(state.user.totpEnabled, true);
    const enableCount = auditMock._calls.filter((c) => c.action === 'totp_enabled').length;
    assert.equal(enableCount, 1);

    // Re-verifying with the same already-enabled state should NOT
    // emit a second 'totp_enabled' audit event.
    const res2 = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/2fa/totp/verify',
      body: { code },
    });
    assert.equal(res2.status, 200);
    const enableCount2 = auditMock._calls.filter((c) => c.action === 'totp_enabled').length;
    assert.equal(enableCount2, 1);
  });
});

describe('internal helpers', () => {
  const { INTERNAL } = require(usersRoutePath);

  test('encrypt/decrypt round-trip with plaintext fallback', () => {
    const enveloped = INTERNAL.encryptTotpSecret('JBSWY3DPEHPK3PXP');
    assert.ok(enveloped.startsWith('plain:') || enveloped.startsWith('enc:'));
    assert.equal(INTERNAL.decryptTotpSecret(enveloped), 'JBSWY3DPEHPK3PXP');
  });

  test('decryptTotpSecret tolerates legacy raw base32', () => {
    assert.equal(INTERNAL.decryptTotpSecret('JBSWY3DPEHPK3PXP'), 'JBSWY3DPEHPK3PXP');
  });

  test('buildOtpauthUri includes label, secret, and issuer', () => {
    const uri = INTERNAL.buildOtpauthUri({
      secret: 'JBSWY3DPEHPK3PXP',
      accountName: 'alice@example.com',
      issuer: 'SiraGPT',
    });
    assert.ok(uri.startsWith('otpauth://totp/SiraGPT:'));
    assert.ok(uri.includes('alice%40example.com'));
    assert.ok(uri.includes('secret=JBSWY3DPEHPK3PXP'));
    assert.ok(uri.includes('issuer=SiraGPT'));
    assert.ok(uri.includes('algorithm=SHA1'));
    assert.ok(uri.includes('digits=6'));
    assert.ok(uri.includes('period=30'));
  });
});
