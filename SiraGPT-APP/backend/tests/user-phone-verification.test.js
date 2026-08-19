'use strict';

/**
 * Route + service tests for ratchet 45 phone-verification endpoints:
 *   PUT  /api/users/me/phone
 *   POST /api/users/me/phone/verify
 *
 * Substitutes prisma + auth + audit-log + rate-limit-store via the
 * require cache so the user router runs without a DB / Twilio.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-phone-verify-jwt-secret-at-least-32-chars!!';
// Make sure Twilio path is treated as "not configured" so SMS sender
// degrades to skipped without trying to require the package.
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
delete process.env.TWILIO_MESSAGING_SERVICE_SID;

const authPath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const auditPath = path.resolve(__dirname, '../src/utils/audit-log.js');
const rateLimitStorePath = path.resolve(__dirname, '../src/middleware/rate-limit-store.js');
const usersRoutePath = path.resolve(__dirname, '../src/routes/users.js');
const phoneServicePath = path.resolve(__dirname, '../src/services/phone-verification.js');

const state = {
  user: { id: 'u-1', email: 'u@x.com', name: 'U', phone: null, phoneVerifiedAt: null, password: 'x' },
  rows: [], // PhoneVerification rows
  consumeCalls: [],
  consumeAllow: true,
};

const authMock = {
  authenticateToken: (req, _res, next) => { req.user = state.user; next(); },
};

const prismaMock = {
  phoneVerification: {
    create: async ({ data }) => {
      const row = {
        id: `pv-${state.rows.length + 1}`,
        attempts: 0,
        consumedAt: null,
        createdAt: new Date(),
        ...data,
      };
      state.rows.push(row);
      return row;
    },
    findFirst: async ({ where, orderBy: _o }) => {
      const matches = state.rows.filter((r) =>
        r.userId === where.userId
        && (where.consumedAt === null ? r.consumedAt === null : true),
      );
      matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return matches[0] || null;
    },
    updateMany: async ({ where, data }) => {
      let n = 0;
      for (const r of state.rows) {
        if (r.userId === where.userId && (where.consumedAt === null ? r.consumedAt === null : true)) {
          Object.assign(r, data);
          n += 1;
        }
      }
      return { count: n };
    },
    update: async ({ where, data }) => {
      const r = state.rows.find((x) => x.id === where.id);
      if (r) Object.assign(r, data);
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
    phoneVerification: prismaMock.phoneVerification,
    user: prismaMock.user,
  }),
};

const auditMock = {
  _calls: [],
  writeAuditLog: (_db, payload) => { auditMock._calls.push(payload); },
};

const rateLimitStoreMock = {
  consume: async (key, limit, windowMs) => {
    state.consumeCalls.push({ key, limit, windowMs });
    if (state.consumeAllow) {
      return { allowed: true, resetAt: new Date(Date.now() + windowMs) };
    }
    return { allowed: false, resetAt: new Date(Date.now() + windowMs) };
  },
};

require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authMock };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: auditMock };
require.cache[rateLimitStorePath] = {
  id: rateLimitStorePath, filename: rateLimitStorePath, loaded: true, exports: rateLimitStoreMock,
};

// Force fresh load of the route + service modules so they bind
// against the mocks above.
delete require.cache[phoneServicePath];
delete require.cache[usersRoutePath];
const usersRouter = require(usersRoutePath);
const phoneService = require(phoneServicePath);

function callRoute({ method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/users', usersRouter);
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
            resolve({ status: res.statusCode, body: json, headers: res.headers });
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
  state.user = { id: 'u-1', email: 'u@x.com', name: 'U', phone: null, phoneVerifiedAt: null, password: 'x' };
  state.rows.length = 0;
  state.consumeCalls.length = 0;
  state.consumeAllow = true;
  auditMock._calls.length = 0;
}

describe('phone-verification service', () => {
  beforeEach(resetState);

  test('mintCode returns 6 digits', () => {
    for (let i = 0; i < 20; i += 1) {
      const c = phoneService.mintCode();
      assert.equal(c.length, 6);
      assert.match(c, /^\d{6}$/);
    }
  });

  test('isValidPhone accepts E.164 and rejects junk', () => {
    assert.equal(phoneService.isValidPhone('+14155551234'), true);
    assert.equal(phoneService.isValidPhone('+15551234567890'), true);
    assert.equal(phoneService.isValidPhone('14155551234'), false);
    assert.equal(phoneService.isValidPhone('+0123'), false);
    assert.equal(phoneService.isValidPhone('not-a-phone'), false);
    assert.equal(phoneService.isValidPhone(''), false);
    assert.equal(phoneService.isValidPhone(null), false);
  });

  test('isValidCode accepts 6 digits only', () => {
    assert.equal(phoneService.isValidCode('123456'), true);
    assert.equal(phoneService.isValidCode('12345'), false);
    assert.equal(phoneService.isValidCode('1234567'), false);
    assert.equal(phoneService.isValidCode('12345a'), false);
    assert.equal(phoneService.isValidCode(123456), false);
  });

  test('createPhoneChallenge stores a hash, not plaintext', async () => {
    const { row, code } = await phoneService.createPhoneChallenge(
      prismaMock, 'u-1', '+14155551234',
    );
    assert.equal(row.userId, 'u-1');
    assert.equal(row.phone, '+14155551234');
    assert.ok(row.codeHash);
    assert.notEqual(row.codeHash, code);
    // Hash should verify against the code.
    assert.equal(await phoneService.compareCode(code, row.codeHash), true);
    assert.equal(await phoneService.compareCode('000000', row.codeHash), false);
  });

  test('createPhoneChallenge invalidates prior unconsumed rows', async () => {
    await phoneService.createPhoneChallenge(prismaMock, 'u-1', '+14155551234');
    await phoneService.createPhoneChallenge(prismaMock, 'u-1', '+14155551234');
    const active = state.rows.filter((r) => r.consumedAt === null);
    assert.equal(active.length, 1);
    assert.equal(state.rows.length, 2);
  });

  test('verifyPhoneChallenge accepts a correct code', async () => {
    const { code } = await phoneService.createPhoneChallenge(
      prismaMock, 'u-1', '+14155551234',
    );
    const result = await phoneService.verifyPhoneChallenge(prismaMock, 'u-1', code);
    assert.equal(result.ok, true);
    assert.equal(result.phone, '+14155551234');
    assert.equal(state.user.phone, '+14155551234');
    assert.ok(state.user.phoneVerifiedAt instanceof Date);
    assert.ok(state.rows[0].consumedAt instanceof Date);
  });

  test('verifyPhoneChallenge rejects bad codes and increments attempts', async () => {
    await phoneService.createPhoneChallenge(prismaMock, 'u-1', '+14155551234');
    const result = await phoneService.verifyPhoneChallenge(prismaMock, 'u-1', '000000');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_code');
    assert.equal(result.attempts, 1);
    assert.equal(result.remaining, 4);
    assert.equal(state.rows[0].attempts, 1);
  });

  test('verifyPhoneChallenge locks after 5 attempts', async () => {
    await phoneService.createPhoneChallenge(prismaMock, 'u-1', '+14155551234');
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await phoneService.verifyPhoneChallenge(prismaMock, 'u-1', '000000');
    }
    assert.equal(last.ok, false);
    assert.equal(last.code, 'too_many_attempts');
    assert.equal(last.attempts, 5);
    assert.ok(state.rows[0].consumedAt instanceof Date);

    // Further attempts return not_found because the row is consumed.
    const again = await phoneService.verifyPhoneChallenge(prismaMock, 'u-1', '000000');
    assert.equal(again.ok, false);
    assert.equal(again.code, 'not_found');
  });

  test('verifyPhoneChallenge returns expired for stale rows', async () => {
    await phoneService.createPhoneChallenge(prismaMock, 'u-1', '+14155551234');
    // Force expiry on the active row.
    state.rows[0].expiresAt = new Date(Date.now() - 1000);
    const result = await phoneService.verifyPhoneChallenge(prismaMock, 'u-1', '123456');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'expired');
    assert.ok(state.rows[0].consumedAt instanceof Date);
  });

  test('verifyPhoneChallenge returns invalid_input for non-6-digit codes', async () => {
    const r = await phoneService.verifyPhoneChallenge(prismaMock, 'u-1', '12');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'invalid_input');
  });

  test('sendSms degrades to skipped when Twilio env missing', async () => {
    const r = await phoneService.sendSms('+14155551234', '123456');
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'no-twilio-env');
  });
});

describe('PUT /api/users/me/phone', () => {
  beforeEach(resetState);

  test('mints a row, returns expiresAt, and audits the send', async () => {
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/users/me/phone',
      body: { phone: '+14155551234' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.expiresAt);
    assert.equal(res.body.smsSent, false); // no Twilio in tests
    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0].phone, '+14155551234');
    // Plaintext code is NEVER returned to the client.
    assert.equal(res.body.code, undefined);
    assert.ok(auditMock._calls.some((c) => c.action === 'phone_verification_sent'));
    assert.equal(state.consumeCalls.length, 1);
    assert.equal(state.consumeCalls[0].limit, 1);
    assert.equal(state.consumeCalls[0].windowMs, 60_000);
  });

  test('rejects non-E.164 phones with 400', async () => {
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/users/me/phone',
      body: { phone: '4155551234' },
    });
    assert.equal(res.status, 400);
    assert.equal(state.rows.length, 0);
  });

  test('returns 429 when the rate-limit slot is exhausted', async () => {
    state.consumeAllow = false;
    const res = await callRoute({
      method: 'PUT',
      urlPath: '/api/users/me/phone',
      body: { phone: '+14155551234' },
    });
    assert.equal(res.status, 429);
    assert.ok(res.headers['retry-after']);
    assert.equal(state.rows.length, 0);
  });
});

describe('POST /api/users/me/phone/verify', () => {
  beforeEach(resetState);

  test('verifies a correct code and returns phoneVerifiedAt', async () => {
    const { code } = await phoneService.createPhoneChallenge(
      prismaMock, 'u-1', '+14155551234',
    );
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/phone/verify',
      body: { code },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.phoneVerifiedAt);
    assert.equal(state.user.phone, '+14155551234');
    assert.ok(state.user.phoneVerifiedAt instanceof Date);
    assert.ok(auditMock._calls.some((c) => c.action === 'phone_verified'));
  });

  test('returns 400 + remaining attempts on bad code', async () => {
    await phoneService.createPhoneChallenge(prismaMock, 'u-1', '+14155551234');
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/phone/verify',
      body: { code: '000000' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.attempts, 1);
    assert.equal(res.body.remaining, 4);
  });

  test('returns 404 when no active row exists', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/phone/verify',
      body: { code: '123456' },
    });
    assert.equal(res.status, 404);
  });

  test('returns 410 when the row has expired', async () => {
    await phoneService.createPhoneChallenge(prismaMock, 'u-1', '+14155551234');
    state.rows[0].expiresAt = new Date(Date.now() - 1000);
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/phone/verify',
      body: { code: '123456' },
    });
    assert.equal(res.status, 410);
  });

  test('returns 429 + audits lock after 5 attempts', async () => {
    await phoneService.createPhoneChallenge(prismaMock, 'u-1', '+14155551234');
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await callRoute({
        method: 'POST',
        urlPath: '/api/users/me/phone/verify',
        body: { code: '000000' },
      });
    }
    assert.equal(last.status, 429);
    assert.equal(last.body.attempts, 5);
    assert.ok(auditMock._calls.some((c) => c.action === 'phone_verification_locked'));
  });

  test('rejects malformed code with 400', async () => {
    const res = await callRoute({
      method: 'POST',
      urlPath: '/api/users/me/phone/verify',
      body: { code: '12' },
    });
    assert.equal(res.status, 400);
  });
});
