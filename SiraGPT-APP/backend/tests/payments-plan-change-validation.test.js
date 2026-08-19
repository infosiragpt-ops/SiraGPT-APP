'use strict';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_STORE = 'memory';
process.env.RATE_LIMIT_SENSITIVE_POLICY = 'memory';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
  mockResolvedModule,
} = require('./http-test-utils');

/**
 * POST /payments/plan-change/{preview,execute} declared express-validator
 * rules but never called validationResult(), so the rules were dead no-ops
 * and an arbitrary `newPlan` flowed into the proration service (throwing a
 * TypeError surfaced as a generic error). Activating validationResult must:
 *   - reject an invalid newPlan / non-boolean immediate with a clean 400, and
 *   - still accept a valid request that omits the optional `immediate` field.
 */

describe('POST /payments/plan-change · validation contract', () => {
  let auth;
  let restoreProration;

  beforeEach(() => {
    auth = installAuthSessionMock();
    restoreProration = mockResolvedModule(require.resolve('../src/services/proration'), {
      previewPlanChange: async () => ({ ok: true, preview: true }),
      changePlan: async () => ({ ok: true, changed: true }),
      cancelScheduledPlanChange: async () => ({ ok: true }),
    });
    delete require.cache[require.resolve('../src/routes/payments')];
  });

  afterEach(() => {
    auth.restore();
    restoreProration();
    delete require.cache[require.resolve('../src/routes/payments')];
  });

  function buildApp() {
    return buildRouteTestApp('/payments', reloadModule('../src/routes/payments'));
  }

  test('execute: invalid newPlan returns 400 with validation errors', async () => {
    const res = await request(buildApp())
      .post('/payments/plan-change/execute')
      .set('Authorization', auth.authHeader)
      .send({ newPlan: 'INVALID' });
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.errors), 'expected express-validator errors array');
  });

  test('execute: non-boolean immediate returns 400', async () => {
    const res = await request(buildApp())
      .post('/payments/plan-change/execute')
      .set('Authorization', auth.authHeader)
      .send({ newPlan: 'PRO', immediate: 'yes' });
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.errors));
  });

  test('execute: valid newPlan WITHOUT immediate is accepted (regression guard)', async () => {
    const res = await request(buildApp())
      .post('/payments/plan-change/execute')
      .set('Authorization', auth.authHeader)
      .send({ newPlan: 'PRO' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  test('preview: invalid newPlan returns 400 with validation errors', async () => {
    const res = await request(buildApp())
      .post('/payments/plan-change/preview')
      .set('Authorization', auth.authHeader)
      .send({ newPlan: 'FREE' });
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.errors));
  });

  test('execute: unauthenticated request is rejected before the handler', async () => {
    const res = await request(buildApp())
      .post('/payments/plan-change/execute')
      .send({ newPlan: 'PRO' });
    assert.equal(res.status, 401);
  });
});
