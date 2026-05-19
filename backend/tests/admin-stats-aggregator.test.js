'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRange,
  percentile,
  safeNumber,
  aggregateUserStats,
  aggregateUsageStats,
  aggregateFileStats,
  aggregateAgentStats,
  PLAN_MRR_USD,
} = require('../src/services/admin-stats-aggregator');

// ── helpers ────────────────────────────────────────────────────────────────
test('parseRange defaults to last 30 days when from is omitted', () => {
  const r = parseRange({});
  assert.ok(r.from instanceof Date);
  assert.ok(r.to instanceof Date);
  const diffDays = (r.to - r.from) / (24 * 60 * 60 * 1000);
  assert.ok(diffDays >= 29 && diffDays <= 31, `unexpected window: ${diffDays}`);
});

test('parseRange rejects invalid dates and inverted ranges', () => {
  assert.throws(() => parseRange({ from: 'banana' }), /Invalid 'from'/);
  assert.throws(() => parseRange({ to: 'nope' }), /Invalid 'to'/);
  assert.throws(
    () => parseRange({ from: '2030-01-01', to: '2020-01-01' }),
    /'from' is after 'to'/
  );
});

test('percentile returns 0 for empty input and correct value otherwise', () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([10, 20, 30, 40], 50), 30);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

test('safeNumber handles bigint, null and garbage', () => {
  assert.equal(safeNumber(null), 0);
  assert.equal(safeNumber(10n), 10);
  assert.equal(safeNumber('5.5'), 5.5);
  assert.equal(safeNumber('foo'), 0);
});

// ── user stats ─────────────────────────────────────────────────────────────
test('aggregateUserStats computes counts + MRR proxy', async () => {
  let groupByCalls = 0;
  const prisma = {
    user: {
      count: async ({ where }) => {
        if (where.createdAt) return 12;
        if (where.deletedAt) return 3;
        if (where.updatedAt) return 50;
        return 0;
      },
      groupBy: async ({ where }) => {
        groupByCalls += 1;
        // Active-subscriptions call uses subscriptionStatus filter
        if (where.subscriptionStatus === 'active') {
          return [
            { plan: 'PRO', _count: { plan: 4 } },
            { plan: 'PRO_MAX', _count: { plan: 2 } },
            { plan: 'FREE', _count: { plan: 100 } },
          ];
        }
        // Overall plan breakdown
        return [
          { plan: 'FREE', _count: { plan: 200 } },
          { plan: 'PRO', _count: { plan: 30 } },
          { plan: 'PRO_MAX', _count: { plan: 5 } },
          { plan: 'ENTERPRISE', _count: { plan: 1 } },
        ];
      },
      findMany: async () => [
        { createdAt: new Date() },
        { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      ],
    },
  };
  const stats = await aggregateUserStats(prisma, {});
  assert.equal(stats.newUsers, 12);
  assert.equal(stats.activeUsers, 50);
  assert.equal(stats.churnedUsers, 3);
  assert.equal(stats.activeSubscriptions.PRO, 4);
  assert.equal(
    stats.mrrProxyUsd,
    Math.round((PLAN_MRR_USD.PRO * 4 + PLAN_MRR_USD.PRO_MAX * 2) * 100) / 100
  );
  assert.equal(groupByCalls, 2);
  // breakdownByPlan includes every known tier, even when count is 0
  assert.deepEqual(stats.breakdownByPlan, {
    FREE: 200, PRO: 30, PRO_MAX: 5, ENTERPRISE: 1,
  });
  // signupTrend covers exactly 7 days, sums to 3, today/yesterday non-zero
  assert.equal(stats.signupTrend.length, 7);
  const total = stats.signupTrend.reduce((acc, r) => acc + r.count, 0);
  assert.equal(total, 3);
  // dates are ISO YYYY-MM-DD strings, sorted ascending
  for (let i = 1; i < stats.signupTrend.length; i += 1) {
    assert.ok(stats.signupTrend[i].date > stats.signupTrend[i - 1].date);
  }
});

test('aggregateUserStats fills empty plans with zero counts', async () => {
  const prisma = {
    user: {
      count: async () => 0,
      groupBy: async ({ where }) => {
        if (where.subscriptionStatus === 'active') return [];
        // only FREE has users → PRO/PRO_MAX/ENTERPRISE must default to 0
        return [{ plan: 'FREE', _count: { plan: 5 } }];
      },
      findMany: async () => [],
    },
  };
  const stats = await aggregateUserStats(prisma, {});
  assert.deepEqual(stats.breakdownByPlan, {
    FREE: 5, PRO: 0, PRO_MAX: 0, ENTERPRISE: 0,
  });
  assert.equal(stats.signupTrend.length, 7);
  assert.ok(stats.signupTrend.every((r) => r.count === 0));
});

// ── usage stats ────────────────────────────────────────────────────────────
test('aggregateUsageStats sums tokens/cost by model+provider and ranks users', async () => {
  const prisma = {
    apiUsage: {
      groupBy: async ({ by }) => {
        if (by[0] === 'model') {
          return [
            { model: 'gpt-4o', _sum: { tokens: 1000n, cost: 12.5 }, _count: { model: 5 } },
            { model: 'claude-3', _sum: { tokens: 500n, cost: 6.25 }, _count: { model: 3 } },
          ];
        }
        // userId
        return [
          { userId: 'u1', _sum: { cost: 12, tokens: 800n } },
          { userId: 'u2', _sum: { cost: 6.75, tokens: 700n } },
        ];
      },
    },
    aiModel: {
      findMany: async () => [
        { name: 'gpt-4o', provider: 'OpenAI' },
        { name: 'claude-3', provider: 'Anthropic' },
      ],
    },
    user: {
      findMany: async () => [
        { id: 'u1', email: 'a@b.com', name: 'Alice', plan: 'PRO' },
        { id: 'u2', email: 'c@d.com', name: 'Carl', plan: 'FREE' },
      ],
    },
  };
  const usage = await aggregateUsageStats(prisma, { from: '2025-01-01', to: '2026-01-01' });
  assert.equal(usage.totalTokens, 1500);
  assert.equal(usage.totalCost, 18.75);
  assert.equal(usage.byProviderTokens.OpenAI, 1000);
  assert.equal(usage.byProviderTokens.Anthropic, 500);
  assert.equal(usage.topUsers.length, 2);
  assert.equal(usage.topUsers[0].email, 'a@b.com');
});

// ── file stats ─────────────────────────────────────────────────────────────
test('aggregateFileStats reports total + per-mime breakdown', async () => {
  const prisma = {
    file: {
      groupBy: async () => [
        { mimeType: 'application/pdf', _count: { mimeType: 3 }, _sum: { size: 1024 } },
        { mimeType: 'text/plain', _count: { mimeType: 1 }, _sum: { size: 256 } },
      ],
      aggregate: async () => ({ _count: { _all: 4 }, _sum: { size: 1280 } }),
    },
  };
  const stats = await aggregateFileStats(prisma, {});
  assert.equal(stats.filesUploaded, 4);
  assert.equal(stats.totalBytes, 1280);
  assert.equal(stats.byMime[0].mimeType, 'application/pdf');
});

// ── agent stats ────────────────────────────────────────────────────────────
test('aggregateAgentStats computes success rate + percentiles', async () => {
  const base = new Date('2026-01-01T00:00:00Z').getTime();
  const tasks = [];
  for (let i = 0; i < 10; i += 1) {
    tasks.push({
      status: 'completed',
      createdAt: new Date(base),
      completedAt: new Date(base + (i + 1) * 1000),
      failedAt: null,
    });
  }
  tasks.push({ status: 'failed', createdAt: new Date(base), completedAt: null, failedAt: new Date(base) });

  const prisma = {
    agentTask: { findMany: async () => tasks },
  };
  const stats = await aggregateAgentStats(prisma, {});
  assert.equal(stats.success, 10);
  assert.equal(stats.failed, 1);
  // 10 of 11 finished → ~0.909
  assert.ok(stats.successRate > 0.9 && stats.successRate <= 1);
  assert.ok(stats.p50DurationMs > 0);
  assert.ok(stats.p95DurationMs >= stats.p50DurationMs);
});
