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
  assert.deepEqual(r, { user: null, org: null, orgBudget: null });
  assert.equal(alertingDouble.sent.length, 0);
});

test('maybeCheck returns null verdicts when no scope provided', async () => {
  const r = await costAlert.maybeCheck({
    getRecords: () => [],
    alerting: alertingDouble,
  });
  assert.deepEqual(r, { user: null, org: null, orgBudget: null });
});

// ── Cost budget alerts (org-level cap) ────────────────────────────────

test('normalizeBudget rejects bad input and defaults warnThresholdPct to 80', () => {
  assert.equal(costAlert.normalizeBudget(null), null);
  assert.equal(costAlert.normalizeBudget({}), null);
  assert.equal(costAlert.normalizeBudget({ monthlyCapUSD: 0 }), null);
  assert.equal(costAlert.normalizeBudget({ monthlyCapUSD: -5 }), null);
  const n = costAlert.normalizeBudget({ monthlyCapUSD: 100 });
  assert.equal(n.monthlyCapUSD, 100);
  assert.equal(n.warnThresholdPct, 80);
  assert.equal(n.warnAtUSD, 80);
  // pct override
  const n2 = costAlert.normalizeBudget({ monthlyCapUSD: 200, warnThresholdPct: 50 });
  assert.equal(n2.warnAtUSD, 100);
  // pct out of range falls back to default
  const n3 = costAlert.normalizeBudget({ monthlyCapUSD: 100, warnThresholdPct: 999 });
  assert.equal(n3.warnThresholdPct, 80);
});

test('_sumMonthToDate only counts current-month records for member set', () => {
  const now = Date.parse('2026-05-19T12:00:00Z');
  const records = [
    { userId: 'm1', costUSD: 3, ts: '2026-05-01T00:00:00Z' },
    { userId: 'm2', costUSD: 4, ts: '2026-05-10T00:00:00Z' },
    // previous month → excluded
    { userId: 'm1', costUSD: 100, ts: '2026-04-30T00:00:00Z' },
    // non-member → excluded
    { userId: 'stranger', costUSD: 999, ts: '2026-05-15T00:00:00Z' },
  ];
  const total = costAlert._sumMonthToDate(records, new Set(['m1', 'm2']), now);
  assert.equal(total, 7);
});

test('checkOrgBudget returns null when no budget configured', async () => {
  const r = await costAlert.checkOrgBudget({
    orgId: 'org1',
    memberIds: ['m1'],
    budget: null,
    getRecords: () => [],
    alerting: alertingDouble,
  });
  assert.equal(r, null);
  assert.equal(alertingDouble.sent.length, 0);
});

test('checkOrgBudget does NOT fire below warn threshold', async () => {
  const now = Date.parse('2026-05-19T12:00:00Z');
  const records = [
    { userId: 'm1', costUSD: 10, ts: '2026-05-10T00:00:00Z' },
  ];
  const r = await costAlert.checkOrgBudget({
    orgId: 'org1',
    memberIds: ['m1'],
    budget: { monthlyCapUSD: 100 }, // warn at 80
    getRecords: () => records,
    alerting: alertingDouble,
    nowMs: now,
  });
  assert.ok(r);
  assert.equal(r.fired, false);
  assert.equal(alertingDouble.sent.length, 0);
});

test('checkOrgBudget fires warn at threshold (default 80%)', async () => {
  const now = Date.parse('2026-05-19T12:00:00Z');
  const records = [
    { userId: 'm1', costUSD: 50, ts: '2026-05-05T00:00:00Z' },
    { userId: 'm2', costUSD: 35, ts: '2026-05-12T00:00:00Z' },
  ];
  const r = await costAlert.checkOrgBudget({
    orgId: 'org1',
    memberIds: ['m1', 'm2'],
    budget: { monthlyCapUSD: 100 },
    getRecords: () => records,
    alerting: alertingDouble,
    nowMs: now,
  });
  assert.ok(r.fired);
  assert.equal(r.severity, 'warn');
  assert.equal(r.overCap, false);
  assert.equal(alertingDouble.sent.length, 1);
  assert.match(alertingDouble.sent[0].title, /^org_budget_warn:org1$/);
  assert.equal(alertingDouble.sent[0].context.scope, 'org_budget');
});

test('checkOrgBudget fires error severity when MTD spend exceeds cap', async () => {
  const now = Date.parse('2026-05-19T12:00:00Z');
  const records = [
    { userId: 'm1', costUSD: 150, ts: '2026-05-05T00:00:00Z' },
  ];
  const r = await costAlert.checkOrgBudget({
    orgId: 'org1',
    memberIds: ['m1'],
    budget: { monthlyCapUSD: 100, warnThresholdPct: 80 },
    getRecords: () => records,
    alerting: alertingDouble,
    nowMs: now,
  });
  assert.ok(r.fired);
  assert.equal(r.overCap, true);
  assert.equal(r.severity, 'error');
  assert.match(alertingDouble.sent[0].title, /^org_budget_exceeded:org1$/);
});

test('maybeCheck wires orgBudget when budget supplied alongside orgId', async () => {
  const now = Date.parse('2026-05-19T12:00:00Z');
  const records = [
    { userId: 'm1', costUSD: 90, ts: '2026-05-10T00:00:00Z' },
  ];
  const r = await costAlert.maybeCheck({
    orgId: 'org1',
    memberIds: ['m1'],
    budget: { monthlyCapUSD: 100 },
    getRecords: () => records,
    alerting: alertingDouble,
    nowMs: now,
  });
  assert.ok(r.orgBudget && r.orgBudget.fired);
  assert.equal(r.org, null); // ratio path didn't trip
});
