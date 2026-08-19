'use strict';

/**
 * Route + service tests for ratchet 45 cycle 131 SMS-based 2FA scaffold:
 *   POST /api/auth/2fa/sms/challenge
 *   POST /api/auth/2fa/sms/verify
 *
 * Mocks prisma + audit-log + rate-limit-auth + email service via the
 * require cache so the auth router runs without a DB / Twilio / SMTP.
 * The Twilio sender in `two-fa-sms.js` degrades to a `skipped` reason
 * when TWILIO_* envs are unset, which is exactly what we want here.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-2fa-sms-jwt-secret-at-least-32-chars!!';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.TWILIO_MESSAGING_SERVICE_SID;

const authPath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const auditPath = path.resolve(__dirname, '../src/utils/audit-log.js');
const emailPath = path.resolve(__dirname, '../src/services/email.js');
const rateLimitPath = path.resolve(__dirname, '../src/middleware/rate-limit-auth.js');
const authRoutePath = path.resolve(__dirname, '../src/routes/auth.js');
const twoFAPath = path.resolve(__dirname, '../src/services/two-fa-sms.js');

const state = {
  users: [
    {
      id: 'u-1',
      email: 'a@example.com',
      name: 'Alice',
      password: 'x',
      phone: '+14155551234',
      phoneVerifiedAt: new Date(),
      isAdmin: false,
      isSuperAdmin: false,
    },
  ],
  rows: [], // TwoFAChallenge rows
  sessions: [],
};

const authMock = {
  authenticateToken: (_req, _res, next) => next(),
};

const prismaMock = {
  user: {
    findUnique: async ({ where }) => {
      if (where.email) return state.users.find((u) => u.email === where.email) || null;
      if (where.id) return state.users.find((u) => u.id === where.id) || null;
      return null;
    },
    findFirst: async ({ where }) => {
      if (where.phone) return state.users.find((u) => u.phone === where.phone) || null;
      return null;
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
        if (
          r.userId === where.userId
          && (where.consumedAt === null ? r.consumedAt === null : true)
        ) {
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
};

const auditMock = {
  _calls: [],
  writeAuditLog: (_db, payload) => { auditMock._calls.push(payload); },
};

const emailMock = {
  sendEmailVerification: async () => {},
  isConfigured: () => false,
};

const rateLimitMock = {
  makeAuthRateLimit: () => (_req, _res, next) => next(),
};

require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authMock };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: auditMock };
require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: emailMock };
require.cache[rateLimitPath] = { id: rateLimitPath, filename: rateLimitPath, loaded: true, exports: rateLimitMock };

delete require.cache[twoFAPath];
delete require.cache[authRoutePath];
const authRouter = require(authRoutePath);
const twoFASms = require(twoFAPath);

function callRoute({ method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
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
  state.rows.length = 0;
  state.sessions.length = 0;
  auditMock._calls.length = 0;
  state.users[0].phone = '+14155551234';
}

describe('two-fa-sms service helpers', () => {
  test('mintCode returns 6 digits', () => {
    for (let i = 0; i < 20; i += 1) {
      assert.match(twoFASms.mintCode(), /^\d{6}$/);
    }
  });

  test('mintChallengeId returns 43+ url-safe chars', () => {
    const id = twoFASms.mintChallengeId();
    assert.ok(twoFASms.isValidChallengeId(id), `bad challenge id: ${id}`);
  });

  test('isValidPhone enforces E.164', () => {
    assert.equal(twoFASms.isValidPhone('+14155551234'), true);
    assert.equal(twoFASms.isValidPhone('14155551234'), false);
    assert.equal(twoFASms.isValidPhone('+1'), false);
  });

  test('isValidCode accepts only 6 digits', () => {
    assert.equal(twoFASms.isValidCode('123456'), true);
    assert.equal(twoFASms.isValidCode('12345'), false);
    assert.equal(twoFASms.isValidCode('abcdef'), false);
  });

  test('lookupKey is stable + case-insensitive', () => {
    assert.equal(twoFASms.lookupKey('A@X.com'), twoFASms.lookupKey('a@x.com'));
    assert.notEqual(twoFASms.lookupKey('a@x.com'), twoFASms.lookupKey('b@x.com'));
  });

  test('sendSms degrades gracefully without Twilio env', async () => {
    const res = await twoFASms.sendSms('+14155551234', '123456');
    assert.equal(res.sent, false);
    assert.ok(res.reason);
  });
});

describe('POST /api/auth/2fa/sms/challenge', () => {
  beforeEach(resetState);

  test('400 when no contact provided', async () => {
    const res = await callRoute({ method: 'POST', urlPath: '/api/auth/2fa/sms/challenge', body: {} });
    assert.equal(res.status, 400);
  });

  test('mints a row when email resolves to a user with a phone', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/sms/challenge',
      body: { email: 'a@example.com' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(twoFASms.isValidChallengeId(res.body.challengeId));
    assert.ok(res.body.expiresAt);
    assert.equal(res.body.smsSent, false); // Twilio not configured in tests
    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0].channel, 'sms');
    assert.equal(state.rows[0].destination, '+14155551234');
    assert.ok(auditMock._calls.some((c) => c.action === '2fa_sms_challenge_sent'));
  });

  test('returns opaque 200 for unknown contact (no row minted)', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/sms/challenge',
      body: { email: 'nobody@example.com' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.challengeId);
    assert.equal(res.body.smsSent, false);
    assert.equal(res.body.smsSkippedReason, 'unknown-contact');
    assert.equal(state.rows.length, 0);
    assert.ok(auditMock._calls.some((c) => c.action === '2fa_sms_challenge_miss'));
  });

  test('returns opaque 200 when user has no phone on file', async () => {
    state.users[0].phone = null;
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/sms/challenge',
      body: { email: 'a@example.com' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.smsSkippedReason, 'unknown-contact');
    assert.equal(state.rows.length, 0);
  });

  test('invalidates prior unconsumed rows on re-challenge', async () => {
    await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/sms/challenge',
      body: { email: 'a@example.com' },
    });
    await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/sms/challenge',
      body: { email: 'a@example.com' },
    });
    assert.equal(state.rows.length, 2);
    assert.ok(state.rows[0].consumedAt instanceof Date);
    assert.equal(state.rows[1].consumedAt, null);
  });
});

describe('POST /api/auth/2fa/sms/verify', () => {
  beforeEach(resetState);

  test('400 on malformed input', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/sms/verify',
      body: { challengeId: 'short', code: '12345' },
    });
    assert.equal(res.status, 400);
  });

  test('404 when challenge unknown', async () => {
    const fakeId = twoFASms.mintChallengeId();
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/sms/verify',
      body: { challengeId: fakeId, code: '123456' },
    });
    assert.equal(res.status, 404);
  });

  test('verifies a fresh row and returns a session JWT', async () => {
    // Mint via service so we know the plaintext code.
    const { challengeId, code } = await twoFASms.createSmsChallenge(
      prismaMock,
      state.users[0],
      '+14155551234',
    );
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/sms/verify',
      body: { challengeId, code },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(typeof res.body.token === 'string' && res.body.token.split('.').length === 3);
    assert.equal(res.body.user.email, 'a@example.com');
    assert.equal(state.sessions.length, 1);
    assert.ok(state.rows[state.rows.length - 1].consumedAt instanceof Date);
    assert.ok(auditMock._calls.some((c) => c.action === '2fa_sms_verified'));
  });

  test('400 invalid_code increments attempts', async () => {
    const { challengeId } = await twoFASms.createSmsChallenge(
      prismaMock,
      state.users[0],
      '+14155551234',
    );
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/sms/verify',
      body: { challengeId, code: '000000' },
    });
    // The OTP is random; the chance of matching '000000' is ~1e-6 so
    // accept either outcome but force the failure path by retrying on
    // the unlikely success.
    if (res.status === 200) {
      // Lottery winner — the test guarantees the consumed flag flipped.
      assert.equal(state.rows[0].consumedAt instanceof Date, true);
      return;
    }
    assert.equal(res.status, 400);
    assert.equal(res.body.attempts, 1);
    assert.equal(res.body.remaining, 4);
  });

  test('429 after MAX_VERIFY_ATTEMPTS', async () => {
    const { challengeId } = await twoFASms.createSmsChallenge(
      prismaMock,
      state.users[0],
      '+14155551234',
    );
    // Force the row's attempt counter to the cap.
    state.rows[0].attempts = twoFASms.MAX_VERIFY_ATTEMPTS;
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/sms/verify',
      body: { challengeId, code: '000000' },
    });
    assert.equal(res.status, 429);
    assert.ok(auditMock._calls.some((c) => c.action === '2fa_sms_locked'));
  });

  test('410 when challenge expired', async () => {
    const { challengeId } = await twoFASms.createSmsChallenge(
      prismaMock,
      state.users[0],
      '+14155551234',
    );
    state.rows[0].expiresAt = new Date(Date.now() - 1000);
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/auth/2fa/sms/verify',
      body: { challengeId, code: '123456' },
    });
    assert.equal(res.status, 410);
  });
});
