'use strict';

/**
 * Unit tests for services/ai/cost-alert.js.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const costAlert = require('../src/services/ai/cost-alert');

function makeRecord({ userId = 'u1', costUSD = 1, daysAgo = 0 } = {}) {
  const now = Date.now();
  const ts = new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return { ts, userId, model: 'gpt-4o-mini', costUSD, inputTokens: 0, outputTokens: 0 };
}

function makeFakeAlerting() {
  const sent = [];
  return {
    sent,
    sendAlert: async (a) => { sent.push(a); return { ok: true }; },
  };
}

let alertingDouble;
beforeEach(() => { alertingDouble = makeFakeAlerting(); });

test('summarize splits today vs baseline', () => {
  const records = [
    makeRecord({ daysAgo: 0, costUSD: 12 }),
    makeRecord({ daysAgo: 1, costUSD: 1 }),
    makeRecord({ daysAgo: 3, costUSD: 6 }),
    makeRecord({ daysAgo: 8, costUSD: 100 }), // outside 7d window
  ];
  const s = costAlert.summarize(records);
  assert.equal(s.todayUSD, 12);
  // baseline = (1 + 6) / 7 = 1
  assert.equal(s.avg7dUSD, 1);
});

test('evaluate trips only when both thresholds met', () => {
  // Below dollar threshold
  assert.equal(costAlert.evaluate({ todayUSD: 5, avg7dUSD: 1 }), null);
  // Below ratio threshold (2x)
  assert.equal(costAlert.evaluate({ todayUSD: 11, avg7dUSD: 10 }), null);
  // Zero baseline → no ratio possible
  assert.equal(costAlert.evaluate({ todayUSD: 50, avg7dUSD: 0 }), null);
  // Trips
  const v = costAlert.evaluate({ todayUSD: 30, avg7dUSD: 5 });
  assert.ok(v && v.ratio === 6);
});

test('checkUser fires alert when thresholds met', async () => {
  const records = [
    makeRecord({ userId: 'u1', daysAgo: 0, costUSD: 30 }),
    makeRecord({ userId: 'u1', daysAgo: 2, costUSD: 5 }),
    makeRecord({ userId: 'u1', daysAgo: 3, costUSD: 2 }),
    makeRecord({ userId: 'other', daysAgo: 0, costUSD: 999 }), // filtered out
  ];
  const v = await costAlert.checkUser({
    userId: 'u1',
    getRecords: () => records,
    alerting: alertingDouble,
  });
  assert.ok(v, 'verdict returned');
  assert.equal(alertingDouble.sent.length, 1);
  assert.equal(alertingDouble.sent[0].severity, 'warn');
  assert.match(alertingDouble.sent[0].title, /^ai_cost_runaway_user:u1$/);
  assert.equal(alertingDouble.sent[0].context.scope, 'user');
});

test('checkUser does NOT fire when today below $10', async () => {
  const records = [
    makeRecord({ userId: 'u1', daysAgo: 0, costUSD: 5 }),
    makeRecord({ userId: 'u1', daysAgo: 2, costUSD: 0.1 }),
  ];
  const v = await costAlert.checkUser({
    userId: 'u1',
    getRecords: () => records,
    alerting: alertingDouble,
  });
  assert.equal(v, null);
  assert.equal(alertingDouble.sent.length, 0);
});

test('checkOrg aggregates across memberIds', async () => {
  const records = [
    makeRecord({ userId: 'm1', daysAgo: 0, costUSD: 9 }),
    makeRecord({ userId: 'm2', daysAgo: 0, costUSD: 9 }),  // today total = 18
    makeRecord({ userId: 'm1', daysAgo: 2, costUSD: 2 }),
    makeRecord({ userId: 'm2', daysAgo: 4, costUSD: 3 }),
    makeRecord({ userId: 'stranger', daysAgo: 0, costUSD: 9999 }), // excluded
  ];
  const v = await costAlert.checkOrg({
    orgId: 'org1',
    memberIds: ['m1', 'm2'],
    getRecords: () => records,
    alerting: alertingDouble,
  });
  assert.ok(v, 'verdict returned');
  assert.equal(alertingDouble.sent[0].context.scope, 'org');
  assert.equal(alertingDouble.sent[0].context.orgId, 'org1');
  assert.equal(alertingDouble.sent[0].context.memberCount, 2);
});

test('maybeCheck swallows errors from getRecords', async () => {
  const r = await costAlert.maybeCheck({
    userId: 'u1',
    getRecords: () => { throw new Error('boom'); },
    alerting: alertingDouble,
  });
  assert.deepEqual(r, { user: null, org: null });
  assert.equal(alertingDouble.sent.length, 0);
});

test('maybeCheck returns null verdicts when no scope provided', async () => {
  const r = await costAlert.maybeCheck({
    getRecords: () => [],
    alerting: alertingDouble,
  });
  assert.deepEqual(r, { user: null, org: null });
});
