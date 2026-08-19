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
  aggregateProductQualityStats,
  MAX_PRODUCT_QUALITY_WINDOW_DAYS,
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
        const metricWhere = where.AND?.[0] || where;
        if (metricWhere.createdAt) return 12;
        if (metricWhere.deletedAt) return 3;
        if (metricWhere.updatedAt) return 50;
        return 0;
      },
      groupBy: async ({ where }) => {
        groupByCalls += 1;
        const metricWhere = where.AND?.[0] || where;
        // Active-subscriptions call uses subscriptionStatus filter
        if (metricWhere.subscriptionStatus === 'active') {
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
        const metricWhere = where.AND?.[0] || where;
        if (metricWhere.subscriptionStatus === 'active') return [];
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

test('aggregateUserStats excludes RBAC system principals from every user metric query', async () => {
  const calls = [];
  const prisma = {
    user: {
      async count(args) {
        calls.push(args);
        return 0;
      },
      async groupBy(args) {
        calls.push(args);
        return [];
      },
      async findMany(args) {
        calls.push(args);
        return [];
      },
    },
  };

  await aggregateUserStats(prisma, {
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-11T00:00:00.000Z',
  });

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.match(JSON.stringify(call.where), /rbac-system:v/);
  }
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
  // MTD fields are always present, even if cost-tracker is empty.
  assert.equal(typeof usage.currentMonthToDateCost, 'number');
  assert.equal(typeof usage.currentMonthToDateTokens, 'number');
});

test('aggregateUsageStats surfaces month-to-date totals from cost-tracker', async () => {
  const costTracker = require('../src/services/ai/cost-tracker');
  costTracker._reset();
  // Two requests this month — verifies tracker → aggregator wiring.
  costTracker.track({
    userId: 'u1', model: 'gpt-4o', inputTokens: 100, outputTokens: 50, costUSD: 1.25,
  });
  costTracker.track({
    userId: 'u2', model: 'claude-3', inputTokens: 200, outputTokens: 25, costUSD: 0.5,
  });
  const prisma = {
    apiUsage: { groupBy: async () => [] },
    aiModel: { findMany: async () => [] },
    user: { findMany: async () => [] },
  };
  const usage = await aggregateUsageStats(prisma, {});
  assert.equal(usage.currentMonthToDateCost, 1.75);
  assert.equal(usage.currentMonthToDateTokens, 375);
  costTracker._reset();
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
      findMany: async () => [
        { createdAt: new Date(), size: 1000 },
        { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000), size: 500 },
        { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000), size: 250 },
      ],
    },
  };
  const stats = await aggregateFileStats(prisma, {});
  assert.equal(stats.filesUploaded, 4);
  assert.equal(stats.totalBytes, 1280);
  assert.equal(stats.byMime[0].mimeType, 'application/pdf');
  // uploadTrend: exactly 7 entries, sums match input
  assert.equal(stats.uploadTrend.length, 7);
  const totalCount = stats.uploadTrend.reduce((acc, r) => acc + r.count, 0);
  const totalBytes = stats.uploadTrend.reduce((acc, r) => acc + r.totalBytes, 0);
  assert.equal(totalCount, 3);
  assert.equal(totalBytes, 1750);
  // dates are ISO YYYY-MM-DD strings, sorted ascending
  for (let i = 1; i < stats.uploadTrend.length; i += 1) {
    assert.ok(stats.uploadTrend[i].date > stats.uploadTrend[i - 1].date);
    assert.ok('totalBytes' in stats.uploadTrend[i]);
  }
});

test('aggregateFileStats uploadTrend is all zeros when no files', async () => {
  const prisma = {
    file: {
      groupBy: async () => [],
      aggregate: async () => ({ _count: { _all: 0 }, _sum: { size: 0 } }),
      findMany: async () => [],
    },
  };
  const stats = await aggregateFileStats(prisma, {});
  assert.equal(stats.uploadTrend.length, 7);
  assert.ok(stats.uploadTrend.every((r) => r.count === 0 && r.totalBytes === 0));
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
  // Trend is always exactly 7 daily buckets with started/completed/failed.
  assert.equal(stats.agentTaskTrend.length, 7);
  for (const row of stats.agentTaskTrend) {
    assert.ok('started' in row && 'completed' in row && 'failed' in row);
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('aggregateAgentStats agentTaskTrend buckets started/completed/failed per day', async () => {
  // Build a trend dataset where the same Prisma.findMany call returns
  // rows for *both* the main sample and the trend window.
  const now = new Date();
  const today = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
  ));
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);
  // 3 tasks today: one running, one completed, one failed.
  // 1 task yesterday: started yesterday, completed today (so 'started'
  // bumps yesterday's bucket and 'completed' bumps today's).
  // 1 task two days ago: started + failed same day.
  const rows = [
    { status: 'running', createdAt: today, completedAt: null, failedAt: null },
    { status: 'completed', createdAt: today, completedAt: today, failedAt: null },
    { status: 'failed', createdAt: today, completedAt: null, failedAt: today },
    { status: 'completed', createdAt: yesterday, completedAt: today, failedAt: null },
    { status: 'failed', createdAt: twoDaysAgo, completedAt: null, failedAt: twoDaysAgo },
  ];
  const prisma = {
    agentTask: { findMany: async () => rows },
  };
  const stats = await aggregateAgentStats(prisma, {});
  const trend = stats.agentTaskTrend;
  const byDate = Object.fromEntries(trend.map((r) => [r.date, r]));
  const todayKey = today.toISOString().slice(0, 10);
  const yestKey = yesterday.toISOString().slice(0, 10);
  const twoKey = twoDaysAgo.toISOString().slice(0, 10);
  // today: started=3, completed=2 (today's row + yesterday→today), failed=1
  assert.equal(byDate[todayKey].started, 3);
  assert.equal(byDate[todayKey].completed, 2);
  assert.equal(byDate[todayKey].failed, 1);
  // yesterday: started=1 (the yesterday→today task), no completed here
  assert.equal(byDate[yestKey].started, 1);
  assert.equal(byDate[yestKey].completed, 0);
  // two days ago: started + failed = 1 each
  assert.equal(byDate[twoKey].started, 1);
  assert.equal(byDate[twoKey].failed, 1);
});

test('aggregateAgentStats agentTaskTrend is all zeros when no tasks', async () => {
  const prisma = { agentTask: { findMany: async () => [] } };
  const stats = await aggregateAgentStats(prisma, {});
  assert.equal(stats.agentTaskTrend.length, 7);
  assert.ok(stats.agentTaskTrend.every(
    (r) => r.started === 0 && r.completed === 0 && r.failed === 0
  ));
});

// ── product quality stats ──────────────────────────────────────────────────
test('aggregateProductQualityStats measures adoption, outcomes and satisfaction without PII', async () => {
  const prisma = {
    user: {
      count: async ({ where }) => {
        const metric = where.AND?.[0] || where;
        if (metric.OR?.some((entry) => entry.lastActiveAt)) return 10;
        if (metric.OR?.length === 2) return 8;
        if (metric.chatRuns) return 7;
        if (metric.agentTasks) return 4;
        return 20;
      },
    },
    chatRun: {
      groupBy: async () => [
        { status: 'completed', _count: { _all: 8 } },
        { status: 'failed', _count: { _all: 1 } },
        { status: 'cancelled', _count: { _all: 1 } },
        { status: 'running', _count: { _all: 2 } },
      ],
    },
    agentTask: {
      groupBy: async () => [
        { status: 'completed', _count: { _all: 3 } },
        { status: 'failed', _count: { _all: 1 } },
        { status: 'cancelled', _count: { _all: 1 } },
        { status: 'queued', _count: { _all: 1 } },
      ],
    },
    message: {
      count: async () => 100,
      groupBy: async () => [
        { feedback: 'liked', _count: { _all: 8 } },
        { feedback: 'disliked', _count: { _all: 2 } },
      ],
    },
    $queryRaw: async () => [
      { day: new Date('2026-01-01T00:00:00.000Z'), metric: 'started', count: 10n },
      { day: new Date('2026-01-01T00:00:00.000Z'), metric: 'completed', count: 6n },
      { day: new Date('2026-01-01T00:00:00.000Z'), metric: 'cancelled', count: 1n },
      { day: new Date('2026-01-01T00:00:00.000Z'), metric: 'liked', count: 8n },
      { day: new Date('2026-01-01T00:00:00.000Z'), metric: 'disliked', count: 2n },
      { day: new Date('2026-01-02T00:00:00.000Z'), metric: 'started', count: 8n },
      { day: new Date('2026-01-02T00:00:00.000Z'), metric: 'completed', count: 5n },
      { day: new Date('2026-01-02T00:00:00.000Z'), metric: 'failed', count: 2n },
      { day: new Date('2026-01-02T00:00:00.000Z'), metric: 'cancelled', count: 1n },
    ],
  };

  const result = await aggregateProductQualityStats(prisma, {
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-02T23:59:59.999Z',
  });

  assert.equal(result.adoption.eligibleUsers, 20);
  assert.equal(result.adoption.activeUsers, 10);
  assert.equal(result.adoption.adopters, 8);
  assert.equal(result.adoption.adoptionRate, 0.8);
  assert.equal(result.outcomes.started, 18);
  assert.equal(result.outcomes.terminal, 15);
  assert.equal(result.outcomes.completed, 11);
  assert.equal(result.outcomes.cancelled, 2);
  assert.equal(result.outcomes.successRate, 0.7333);
  assert.equal(result.outcomes.cancellationRate, 0.1333);
  assert.equal(result.satisfaction.feedbackResponses, 10);
  assert.equal(result.satisfaction.satisfactionRate, 0.8);
  assert.equal(result.satisfaction.feedbackCoverageRate, 0.1);
  assert.equal(result.trend.length, 2);
  assert.equal(result.trend[0].started, 10);
  assert.equal(result.privacy.containsPii, false);
  assert.equal(result.privacy.aggregationOnly, true);

  const forbiddenKeys = new Set(['userId', 'email', 'name', 'prompt', 'content', 'cancelReason']);
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `PII key leaked: ${key}`);
      visit(nested);
    }
  };
  visit(result);
});

test('aggregateProductQualityStats suppresses rates and daily micro-cohorts', async () => {
  const prisma = {
    user: { count: async () => 3 },
    chatRun: {
      groupBy: async () => [
        { status: 'completed', _count: { _all: 2 } },
        { status: 'cancelled', _count: { _all: 1 } },
      ],
    },
    agentTask: { groupBy: async () => [] },
    message: {
      count: async () => 3,
      groupBy: async () => [
        { feedback: 'liked', _count: { _all: 1 } },
        { feedback: 'disliked', _count: { _all: 1 } },
      ],
    },
    $queryRaw: async () => [
      { day: new Date('2026-01-01T00:00:00.000Z'), metric: 'started', count: 2n },
      { day: new Date('2026-01-01T00:00:00.000Z'), metric: 'liked', count: 1n },
    ],
  };

  const result = await aggregateProductQualityStats(prisma, {
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T23:59:59.999Z',
  });

  assert.equal(result.adoption.adoptionRate, null);
  assert.equal(result.outcomes.successRate, null);
  assert.equal(result.outcomes.cancellationRate, null);
  assert.equal(result.satisfaction.satisfactionRate, null);
  assert.equal(result.satisfaction.feedbackCoverageRate, null);
  assert.equal(result.satisfaction.liked, null);
  assert.equal(result.satisfaction.disliked, null);
  assert.equal(result.trend[0].started, null);
  assert.equal(result.trend[0].liked, null);
  assert.equal(result.trend[0].suppressed, true);
  assert.equal(result.privacy.suppressed.dailyBuckets, 1);
});

test('aggregateProductQualityStats rejects unbounded dashboard ranges', async () => {
  await assert.rejects(
    aggregateProductQualityStats({}, {
      from: '2020-01-01T00:00:00.000Z',
      to: '2022-01-01T00:00:00.000Z',
    }),
    new RegExp(`${MAX_PRODUCT_QUALITY_WINDOW_DAYS} days`),
  );
});
