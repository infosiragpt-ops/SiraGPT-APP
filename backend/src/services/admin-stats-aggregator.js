'use strict';

/**
 * admin-stats-aggregator — pure aggregation helpers for the admin metrics
 * dashboard. Each function takes a Prisma-like client + a date range and
 * returns a JSON-serialisable summary. Helpers are exported separately so
 * unit tests can stub the Prisma client without spinning up Postgres.
 *
 * Date handling: `from` / `to` may be ISO strings, Date objects, or null.
 * When `from` is null, defaults to 30 days ago; when `to` is null, defaults
 * to now. Bad input throws a `RangeError` so the route can convert to 400.
 */

const DEFAULT_WINDOW_DAYS = 30;

// Approximate MRR per active subscription, in USD. Used as a fallback when
// we cannot read the actual price from Stripe (the live Stripe lookup
// happens elsewhere — these are *proxy* values for the dashboard).
const PLAN_MRR_USD = Object.freeze({
  FREE: 0,
  PRO: 20,
  PRO_MAX: 50,
  ENTERPRISE: 200,
});

function parseRange({ from, to } = {}) {
  const now = new Date();
  const toDate = to ? new Date(to) : now;
  if (Number.isNaN(toDate.getTime())) {
    throw new RangeError(`Invalid 'to' date: ${to}`);
  }
  const fromDate = from
    ? new Date(from)
    : new Date(toDate.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  if (Number.isNaN(fromDate.getTime())) {
    throw new RangeError(`Invalid 'from' date: ${from}`);
  }
  if (fromDate > toDate) {
    throw new RangeError(`'from' is after 'to'`);
  }
  return { from: fromDate, to: toDate };
}

function safeNumber(value) {
  if (value == null) return 0;
  if (typeof value === 'bigint') return Number(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

/**
 * Build the last-7-days signup trend as `[{ date: 'YYYY-MM-DD', count: n }]`.
 * Always returns exactly 7 entries — days with no signups appear with
 * `count: 0` so the UI can render a continuous bar chart without
 * client-side gap-filling.
 */
function _buildSignupTrend(rows, now = new Date()) {
  // Normalise to UTC midnight so the buckets line up regardless of the
  // server timezone — admin dashboards should not skew by host tz.
  const todayUtc = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
  ));
  const buckets = new Map();
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(todayUtc.getTime() - i * 24 * 60 * 60 * 1000);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const r of rows || []) {
    const created = r && r.createdAt ? new Date(r.createdAt) : null;
    if (!created || Number.isNaN(created.getTime())) continue;
    const key = created.toISOString().slice(0, 10);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
  }
  return Array.from(buckets.entries()).map(([date, count]) => ({ date, count }));
}

async function aggregateUserStats(prisma, range) {
  const { from, to } = parseRange(range);

  // Fixed window for the signup trend — last 7 days, independent of the
  // caller's `range`. We surface both: the rolling 30d aggregates *and*
  // the short-term trendline that admins actually look at every morning.
  const now = new Date();
  const trendFrom = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      - 6 * 24 * 60 * 60 * 1000
  );

  const [newUsers, activeUsers, churnedUsers, activeSubs, planBreakdown, signupRows] =
    await Promise.all([
      prisma.user.count({
        where: { createdAt: { gte: from, lte: to }, isSuperAdmin: false },
      }),
      prisma.user.count({
        where: { updatedAt: { gte: from, lte: to }, isSuperAdmin: false, deletedAt: null },
      }),
      prisma.user.count({
        where: { deletedAt: { gte: from, lte: to }, isSuperAdmin: false },
      }),
      prisma.user.groupBy({
        by: ['plan'],
        where: { subscriptionStatus: 'active', isSuperAdmin: false, deletedAt: null },
        _count: { plan: true },
      }),
      // Per-plan headcount across *all* non-deleted users (not just
      // active subscriptions). This gives the admin a sense of how the
      // total user base is distributed between tiers, including FREE.
      prisma.user.groupBy({
        by: ['plan'],
        where: { isSuperAdmin: false, deletedAt: null },
        _count: { plan: true },
      }),
      prisma.user.findMany({
        where: { createdAt: { gte: trendFrom }, isSuperAdmin: false },
        select: { createdAt: true },
        // Defensive cap — even on a 1k-signups/day product we'd only get
        // 7k rows, but keep the safety net so we never page admin DB.
        take: 50000,
      }),
    ]);

  let mrrProxy = 0;
  const subsByPlan = {};
  for (const row of activeSubs || []) {
    const planKey = row.plan;
    const count = row._count?.plan || 0;
    subsByPlan[planKey] = count;
    mrrProxy += (PLAN_MRR_USD[planKey] || 0) * count;
  }

  // Always emit every known plan key, even when count is 0, so the UI
  // can render a stable bar chart without "missing tier" surprises.
  const breakdownByPlan = { FREE: 0, PRO: 0, PRO_MAX: 0, ENTERPRISE: 0 };
  for (const row of planBreakdown || []) {
    const planKey = row.plan;
    const count = row._count?.plan || 0;
    if (planKey in breakdownByPlan) breakdownByPlan[planKey] = count;
    else breakdownByPlan[planKey] = count; // unknown plan → surface it too
  }

  const signupTrend = _buildSignupTrend(signupRows, now);

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    newUsers,
    activeUsers,
    churnedUsers,
    activeSubscriptions: subsByPlan,
    breakdownByPlan,
    signupTrend,
    mrrProxyUsd: Math.round(mrrProxy * 100) / 100,
  };
}

async function aggregateUsageStats(prisma, range) {
  const { from, to } = parseRange(range);

  const [byModel, modelDirectory, topUserAgg] = await Promise.all([
    prisma.apiUsage.groupBy({
      by: ['model'],
      where: { timestamp: { gte: from, lte: to } },
      _sum: { tokens: true, cost: true },
      _count: { model: true },
    }),
    prisma.aiModel.findMany({ select: { name: true, provider: true } }),
    prisma.apiUsage.groupBy({
      by: ['userId'],
      where: { timestamp: { gte: from, lte: to } },
      _sum: { cost: true, tokens: true },
      orderBy: { _sum: { cost: 'desc' } },
      take: 10,
    }),
  ]);

  const providerByModel = new Map();
  for (const m of modelDirectory) providerByModel.set(m.name, m.provider || 'unknown');

  let totalTokens = 0;
  let totalCost = 0;
  const byModelOut = [];
  const byProviderTokens = {};
  const byProviderCost = {};

  for (const row of byModel) {
    const tokens = safeNumber(row._sum?.tokens);
    const cost = safeNumber(row._sum?.cost);
    totalTokens += tokens;
    totalCost += cost;
    const provider = providerByModel.get(row.model) || 'unknown';
    byProviderTokens[provider] = (byProviderTokens[provider] || 0) + tokens;
    byProviderCost[provider] = (byProviderCost[provider] || 0) + cost;
    byModelOut.push({
      model: row.model,
      provider,
      tokens,
      cost: Math.round(cost * 1e6) / 1e6,
      calls: row._count?.model || 0,
    });
  }
  byModelOut.sort((a, b) => b.cost - a.cost);

  // Hydrate top users with email/name
  const userIds = (topUserAgg || []).map((r) => r.userId);
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true, name: true, plan: true },
      })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const topUsers = (topUserAgg || []).map((row) => ({
    userId: row.userId,
    email: userById.get(row.userId)?.email || null,
    name: userById.get(row.userId)?.name || null,
    plan: userById.get(row.userId)?.plan || null,
    tokens: safeNumber(row._sum?.tokens),
    cost: Math.round(safeNumber(row._sum?.cost) * 1e6) / 1e6,
  }));

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    totalTokens,
    totalCost: Math.round(totalCost * 1e6) / 1e6,
    byProviderTokens,
    byProviderCost: Object.fromEntries(
      Object.entries(byProviderCost).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6])
    ),
    byModel: byModelOut,
    topUsers,
  };
}

async function aggregateFileStats(prisma, range) {
  const { from, to } = parseRange(range);

  const [byMime, totals] = await Promise.all([
    prisma.file.groupBy({
      by: ['mimeType'],
      where: { createdAt: { gte: from, lte: to } },
      _count: { mimeType: true },
      _sum: { size: true },
    }),
    prisma.file.aggregate({
      where: { createdAt: { gte: from, lte: to } },
      _count: { _all: true },
      _sum: { size: true },
    }),
  ]);

  const byMimeOut = byMime
    .map((row) => ({
      mimeType: row.mimeType || 'unknown',
      count: row._count?.mimeType || 0,
      bytes: safeNumber(row._sum?.size),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    filesUploaded: totals._count?._all || 0,
    totalBytes: safeNumber(totals._sum?.size),
    byMime: byMimeOut,
  };
}

async function aggregateAgentStats(prisma, range) {
  const { from, to } = parseRange(range);

  // Pull a bounded sample so we can compute durations + success rate.
  // For very large datasets, swap with a raw SQL percentile query — but
  // for the admin dashboard a 5000-row cap is plenty.
  const SAMPLE_CAP = 5000;
  const tasks = await prisma.agentTask.findMany({
    where: { createdAt: { gte: from, lte: to } },
    select: { status: true, createdAt: true, completedAt: true, failedAt: true },
    take: SAMPLE_CAP,
    orderBy: { createdAt: 'desc' },
  });

  let success = 0;
  let failed = 0;
  const durations = [];
  for (const t of tasks) {
    if (t.status === 'completed' || t.status === 'succeeded') {
      success += 1;
      if (t.completedAt && t.createdAt) {
        durations.push(new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime());
      }
    } else if (t.status === 'failed' || t.failedAt) {
      failed += 1;
    }
  }
  durations.sort((a, b) => a - b);
  const total = tasks.length;
  const finished = success + failed;

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    sampleSize: total,
    sampleCap: SAMPLE_CAP,
    success,
    failed,
    successRate: finished ? Math.round((success / finished) * 1000) / 1000 : 0,
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
  };
}

module.exports = {
  PLAN_MRR_USD,
  parseRange,
  percentile,
  safeNumber,
  aggregateUserStats,
  aggregateUsageStats,
  aggregateFileStats,
  aggregateAgentStats,
};
