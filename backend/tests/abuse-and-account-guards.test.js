'use strict';

/**
 * Abuse + account guards (audit 2026-10-08):
 *  - SlidingWindowRateLimiter honours `max` (express-rate-limit's option name:
 *    apps-ai / apps-kv passed it and silently ran with the 60/min default);
 *  - POST /api/telemetry/error is rate-limited per user/IP (anonymous beacons
 *    with a distinct `page` each defeated the 5-minute alert dedup);
 *  - PUT /api/users/profile refuses to change the account email (it re-bound
 *    Google sign-in and password reset with no verification).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const prisma = require('../src/config/database');
const alerting = require('../src/services/alerting');
const {
  SlidingWindowRateLimiter,
  DEFAULT_LIMIT,
} = require('../src/utils/sliding-window-rate-limiter');
const {
  buildRouteTestApp,
  installAuthSessionMock,
  mockResolvedModule,
  reloadModule,
} = require('./http-test-utils');

describe('SlidingWindowRateLimiter option names', () => {
  test('`max` is honoured like `limit`; `limit` wins when both are given', () => {
    assert.equal(new SlidingWindowRateLimiter({ max: 20 }).limit, 20);
    assert.equal(new SlidingWindowRateLimiter({ limit: 5, max: 20 }).limit, 5);
    assert.equal(new SlidingWindowRateLimiter({ maxRequests: 7 }).limit, 7);
    assert.equal(new SlidingWindowRateLimiter({ max: 0 }).limit, DEFAULT_LIMIT);
    assert.equal(new SlidingWindowRateLimiter({ max: Number.NaN }).limit, DEFAULT_LIMIT);
    assert.equal(new SlidingWindowRateLimiter({}).limit, DEFAULT_LIMIT);
  });

  test('apps-ai and apps-kv limiters now enforce their configured per-minute caps', async () => {
    const { buildAppsAiRouter } = require('../src/routes/apps-ai');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/apps-ai', buildAppsAiRouter({
      env: { CEREBRAS_API_KEY: 'csk-test', APPS_AI_RATE_LIMIT_PER_MIN: '2' },
      createClient: () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }] }) } } }),
    }));
    const body = { messages: [{ role: 'user', content: 'hola' }] };
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/apps-ai/chat').send(body);
      statuses.push(res.status);
      if (res.status === 429) {
        assert.equal(res.body.error, 'rate_limit_exceeded');
        assert.ok(Number(res.headers['retry-after']) >= 1);
      }
    }
    assert.deepEqual(statuses, [200, 200, 429]);
  });
});

describe('POST /api/telemetry/error rate limit', () => {
  let restoreAudit;
  let restoreSystemErrors;
  let realNotify;
  let previousEnv;

  beforeEach(() => {
    realNotify = alerting.notifyFrontendError;
    alerting.notifyFrontendError = async () => {};
    restoreAudit = mockResolvedModule(require.resolve('../src/utils/audit-log'), { writeAuditLog: async () => {} });
    restoreSystemErrors = mockResolvedModule(
      require.resolve('../src/services/observability/system-errors'),
      { captureFrontendEvent: () => {} },
    );
    previousEnv = process.env.SIRAGPT_TELEMETRY_RATE_LIMIT_PER_MIN;
    process.env.SIRAGPT_TELEMETRY_RATE_LIMIT_PER_MIN = '3';
    delete require.cache[require.resolve('../src/routes/telemetry')];
  });

  afterEach(() => {
    alerting.notifyFrontendError = realNotify;
    restoreAudit();
    restoreSystemErrors();
    if (previousEnv === undefined) delete process.env.SIRAGPT_TELEMETRY_RATE_LIMIT_PER_MIN;
    else process.env.SIRAGPT_TELEMETRY_RATE_LIMIT_PER_MIN = previousEnv;
    delete require.cache[require.resolve('../src/routes/telemetry')];
  });

  test('anonymous beacons with distinct pages are capped per IP and minute', async () => {
    const app = buildRouteTestApp('/api/telemetry', reloadModule('../src/routes/telemetry'));
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/telemetry/error')
        .send({ page: `/p${i}`, message: `boom ${i}`, stack: 'at x()' });
      statuses.push(res.status);
      if (res.status === 429) {
        assert.equal(res.body.error, 'rate_limit_exceeded');
        assert.ok(Number(res.headers['retry-after']) >= 1, 'Retry-After tells the client when to come back');
      } else {
        assert.equal(res.body.accepted, true);
      }
    }
    assert.deepEqual(statuses, [202, 202, 202, 429, 429]);
  });

  test('the limiter runs after optionalAuth so a user is keyed by id, not by IP', () => {
    const route = reloadModule('../src/routes/telemetry');
    const layer = route.stack.find((l) => l.route && l.route.path === '/error');
    const names = layer.route.stack.map((l) => l.name);
    const authIdx = names.indexOf('optionalAuthMiddleware');
    const limiterIdx = names.indexOf('slidingWindowRateLimit');
    assert.ok(authIdx >= 0 && limiterIdx > authIdx, `expected optionalAuth before the limiter, got ${names.join(' → ')}`);
  });
});

describe('PUT /api/users/profile email guard', () => {
  let auth;
  let originals;

  beforeEach(() => {
    auth = installAuthSessionMock({ id: 'profile-guard-user', email: 'owner@example.com' });
    originals = { userUpdate: prisma.user.update, userFindFirst: prisma.user.findFirst };
    delete require.cache[require.resolve('../src/routes/users')];
  });

  afterEach(() => {
    prisma.user.update = originals.userUpdate;
    prisma.user.findFirst = originals.userFindFirst;
    auth.restore();
    delete require.cache[require.resolve('../src/routes/users')];
  });

  function app() {
    return buildRouteTestApp('/api/users', reloadModule('../src/routes/users'));
  }

  test('a different email is refused before any write', async () => {
    let writes = 0;
    prisma.user.update = async () => { writes++; return {}; };
    prisma.user.findFirst = async () => { writes++; return null; };
    const res = await request(app())
      .put('/api/users/profile')
      .set('Authorization', auth.authHeader)
      .send({ email: 'attacker-controlled@example.com' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'email_change_unsupported');
    assert.equal(writes, 0);
  });

  test('name changes and the unchanged email still work', async () => {
    const updates = [];
    prisma.user.findFirst = async () => null;
    prisma.user.update = async (args) => {
      updates.push(args.data);
      return { id: auth.user.id, name: args.data.name || auth.user.name, email: auth.user.email };
    };
    const renamed = await request(app())
      .put('/api/users/profile')
      .set('Authorization', auth.authHeader)
      .send({ name: 'Nuevo Nombre' });
    assert.equal(renamed.status, 200);
    assert.equal(updates[0].name, 'Nuevo Nombre');

    const same = await request(app())
      .put('/api/users/profile')
      .set('Authorization', auth.authHeader)
      .send({ email: 'owner@example.com', name: 'Otro' });
    assert.equal(same.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(updates[1], 'email'), false, 'the same email never reaches the update');
  });
});
