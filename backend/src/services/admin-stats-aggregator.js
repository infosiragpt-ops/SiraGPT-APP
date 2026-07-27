'use strict';

const {
  excludeRbacSystemPrincipalsWhere,
  SYSTEM_ASSIGNMENT_TAG_PREFIX,
} = require('./rbac-system-assignments');

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
const MAX_PRODUCT_QUALITY_WINDOW_DAYS = 366;
const PRODUCT_QUALITY_MINIMUM_COHORT = 5;

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

function roundedRatio(numerator, denominator) {
  const safeDenominator = safeNumber(denominator);
  if (safeDenominator <= 0) return null;
  return Math.round((safeNumber(numerator) / safeDenominator) * 10000) / 10000;
}

function cohortRatio(numerator, denominator, minimumCohort = PRODUCT_QUALITY_MINIMUM_COHORT) {
  return safeNumber(denominator) >= minimumCohort
    ? roundedRatio(numerator, denominator)
    : null;
}

function _summarizeOutcomeRows(rows) {
  const successful = new Set(['completed', 'succeeded', 'done']);
  const failed = new Set(['failed', 'error']);
  const cancelled = new Set(['cancelled', 'canceled']);
  const summary = {
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    inProgress: 0,
    terminal: 0,
  };

  for (const row of rows || []) {
    const status = String(row?.status || '').toLowerCase();
    const count = safeNumber(row?._count?._all ?? row?._count?.status ?? row?.count);
    summary.started += count;
    if (successful.has(status)) summary.completed += count;
    else if (failed.has(status)) summary.failed += count;
    else if (cancelled.has(status)) summary.cancelled += count;
    else summary.inProgress += count;
  }
  summary.terminal = summary.completed + summary.failed + summary.cancelled;
  return summary;
}

function _buildProductQualityTrend(rows, range, minimumCohort = PRODUCT_QUALITY_MINIMUM_COHORT) {
  const start = new Date(Date.UTC(
    range.from.getUTCFullYear(),
    range.from.getUTCMonth(),
    range.from.getUTCDate(),
  ));
  const end = new Date(Date.UTC(
    range.to.getUTCFullYear(),
    range.to.getUTCMonth(),
    range.to.getUTCDate(),
  ));
  const buckets = new Map();
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += 24 * 60 * 60 * 1000) {
    const date = new Date(cursor).toISOString().slice(0, 10);
    buckets.set(date, {
      started: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      liked: 0,
      disliked: 0,
    });
  }

  for (const row of rows || []) {
    const day = row?.day ? new Date(row.day) : null;
    if (!day || Number.isNaN(day.getTime())) continue;
    const slot = buckets.get(day.toISOString().slice(0, 10));
    const metric = String(row?.metric || '');
    if (!slot || !Object.prototype.hasOwnProperty.call(slot, metric)) continue;
    slot[metric] += safeNumber(row?.count);
  }

  let suppressedBuckets = 0;
  const trend = Array.from(buckets.entries()).map(([date, values]) => {
    const terminalEvents = values.completed + values.failed + values.cancelled;
    const feedbackResponses = values.liked + values.disliked;
    const suppressStarted = values.started > 0 && values.started < minimumCohort;
    const suppressOutcomes = terminalEvents > 0 && terminalEvents < minimumCohort;
    const suppressFeedback = feedbackResponses > 0 && feedbackResponses < minimumCohort;
    if (suppressStarted || suppressOutcomes || suppressFeedback) suppressedBuckets += 1;
    return {
      date,
      started: suppressStarted ? null : values.started,
      completed: suppressOutcomes ? null : values.completed,
      failed: suppressOutcomes ? null : values.failed,
      cancelled: suppressOutcomes ? null : values.cancelled,
      liked: suppressFeedback ? null : values.liked,
      disliked: suppressFeedback ? null : values.disliked,
      suppressed: suppressStarted || suppressOutcomes || suppressFeedback,
    };
  });

  return { trend, suppressedBuckets };
}

async function _loadProductQualityTrendRows(prisma, range) {
  const excludedPrincipalPattern = `${SYSTEM_ASSIGNMENT_TAG_PREFIX}%`;
  return prisma.$queryRaw`
    WITH eligible_users AS (
      SELECT id
      FROM users
      WHERE "deletedAt" IS NULL
        AND "isSuperAdmin" = FALSE
        AND id NOT LIKE ${excludedPrincipalPattern}
    ), event_counts AS (
      SELECT date_trunc('day', cr."createdAt")::date AS day,
             'started'::text AS metric,
             COUNT(*)::bigint AS event_count
      FROM chat_runs cr
      JOIN eligible_users eu ON eu.id = cr."userId"
      WHERE cr."createdAt" >= ${range.from} AND cr."createdAt" <= ${range.to}
      GROUP BY 1

      UNION ALL
      SELECT date_trunc('day', at."createdAt")::date, 'started'::text, COUNT(*)::bigint
      FROM agent_tasks at
      JOIN eligible_users eu ON eu.id = at."userId"
      WHERE at."createdAt" >= ${range.from} AND at."createdAt" <= ${range.to}
      GROUP BY 1

      UNION ALL
      SELECT date_trunc('day', cr."completedAt")::date, 'completed'::text, COUNT(*)::bigint
      FROM chat_runs cr
      JOIN eligible_users eu ON eu.id = cr."userId"
      WHERE cr."completedAt" >= ${range.from} AND cr."completedAt" <= ${range.to}
      GROUP BY 1

      UNION ALL
      SELECT date_trunc('day', at."completedAt")::date, 'completed'::text, COUNT(*)::bigint
      FROM agent_tasks at
      JOIN eligible_users eu ON eu.id = at."userId"
      WHERE at."completedAt" >= ${range.from} AND at."completedAt" <= ${range.to}
      GROUP BY 1

      UNION ALL
      SELECT date_trunc('day', cr."updatedAt")::date, 'failed'::text, COUNT(*)::bigint
      FROM chat_runs cr
      JOIN eligible_users eu ON eu.id = cr."userId"
      WHERE cr.status = 'failed'
        AND cr."updatedAt" >= ${range.from} AND cr."updatedAt" <= ${range.to}
      GROUP BY 1

      UNION ALL
      SELECT date_trunc('day', at."failedAt")::date, 'failed'::text, COUNT(*)::bigint
      FROM agent_tasks at
      JOIN eligible_users eu ON eu.id = at."userId"
      WHERE at."failedAt" >= ${range.from} AND at."failedAt" <= ${range.to}
      GROUP BY 1

      UNION ALL
      SELECT date_trunc('day', cr."cancelledAt")::date, 'cancelled'::text, COUNT(*)::bigint
      FROM chat_runs cr
      JOIN eligible_users eu ON eu.id = cr."userId"
      WHERE cr."cancelledAt" >= ${range.from} AND cr."cancelledAt" <= ${range.to}
      GROUP BY 1

      UNION ALL
      SELECT date_trunc('day', at."cancelledAt")::date, 'cancelled'::text, COUNT(*)::bigint
      FROM agent_tasks at
      JOIN eligible_users eu ON eu.id = at."userId"
      WHERE at."cancelledAt" >= ${range.from} AND at."cancelledAt" <= ${range.to}
      GROUP BY 1

      UNION ALL
      SELECT date_trunc('day', m.timestamp)::date, m.feedback::text, COUNT(*)::bigint
      FROM messages m
      JOIN chats c ON c.id = m."chatId"
      JOIN eligible_users eu ON eu.id = c."userId"
      WHERE m.role = 'ASSISTANT'
        AND m.feedback IN ('liked', 'disliked')
        AND m."deletedAt" IS NULL
        AND m.timestamp >= ${range.from} AND m.timestamp <= ${range.to}
      GROUP BY 1, 2
    )
    SELECT day, metric, SUM(event_count)::bigint AS count
    FROM event_counts
    GROUP BY day, metric
    ORDER BY day ASC, metric ASC
  `;
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

/**
 * Build the last-7-days agent-task trend as
 * `[{ date: 'YYYY-MM-DD', started, completed, failed }]`. Mirrors
 * `_buildSignupTrend` / `_buildUploadTrend` but counts task lifecycle
 * transitions per day so the admin dashboard can render started vs
 * finished volumes side by side.
 *
 * - `started` is bucketed by `createdAt`
 * - `completed` is bucketed by `completedAt` (only when present)
 * - `failed` is bucketed by `failedAt` (fallback: row with status==='failed'
 *   but no failedAt → bucketed by createdAt so the bar isn't lost)
 */
function _buildAgentTaskTrend(rows, now = new Date()) {
  const todayUtc = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
  ));
  const buckets = new Map();
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(todayUtc.getTime() - i * 24 * 60 * 60 * 1000);
    buckets.set(d.toISOString().slice(0, 10), { started: 0, completed: 0, failed: 0 });
  }
  const bumpAt = (rawDate, field) => {
    if (!rawDate) return;
    const d = new Date(rawDate);
    if (Number.isNaN(d.getTime())) return;
    const key = d.toISOString().slice(0, 10);
    const slot = buckets.get(key);
    if (slot) slot[field] += 1;
  };
  for (const r of rows || []) {
    bumpAt(r && r.createdAt, 'started');
    if (r && (r.status === 'completed' || r.status === 'succeeded')) {
      bumpAt(r.completedAt || r.createdAt, 'completed');
    } else if (r && (r.status === 'failed' || r.failedAt)) {
      bumpAt(r.failedAt || r.createdAt, 'failed');
    }
  }
  return Array.from(buckets.entries()).map(([date, v]) => ({
    date,
    started: v.started,
    completed: v.completed,
    failed: v.failed,
  }));
}

/**
 * Build the last-7-days upload trend as
 * `[{ date: 'YYYY-MM-DD', count, totalBytes }]`. Mirrors `_buildSignupTrend`
 * but additionally sums per-day bytes so the admin dashboard can render both
 * a count bar chart and a storage-growth line in one pass.
 */
function _buildUploadTrend(rows, now = new Date()) {
  const todayUtc = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
  ));
  const buckets = new Map();
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(todayUtc.getTime() - i * 24 * 60 * 60 * 1000);
    buckets.set(d.toISOString().slice(0, 10), { count: 0, totalBytes: 0 });
  }
  for (const r of rows || []) {
    const created = r && r.createdAt ? new Date(r.createdAt) : null;
    if (!created || Number.isNaN(created.getTime())) continue;
    const key = created.toISOString().slice(0, 10);
    const slot = buckets.get(key);
    if (!slot) continue;
    slot.count += 1;
    slot.totalBytes += safeNumber(r.size);
  }
  return Array.from(buckets.entries()).map(([date, v]) => ({
    date,
    count: v.count,
    totalBytes: v.totalBytes,
  }));
}

async function aggregateUserStats(prisma, range) {
  const { from, to } = parseRange(range);

  // Signup-trend window: follow the caller's range so the 7d/30d/90d
  // selector actually changes the chart. When no explicit range is given
  // (parseRange default), keep the classic 7-day morning trendline.
  const now = new Date();
  const requestedSpanMs = Math.max(0, to.getTime() - from.getTime());
  const defaultTrendFrom = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      - 6 * 24 * 60 * 60 * 1000
  );
  const trendFrom = requestedSpanMs > 8 * 24 * 60 * 60 * 1000 ? from : defaultTrendFrom;

  const [newUsers, activeUsers, churnedUsers, activeSubs, planBreakdown, signupRows] =
    await Promise.all([
      prisma.user.count({
        where: excludeRbacSystemPrincipalsWhere({
          createdAt: { gte: from, lte: to },
          isSuperAdmin: false,
        }),
      }),
      prisma.user.count({
        where: excludeRbacSystemPrincipalsWhere({
          updatedAt: { gte: from, lte: to },
          isSuperAdmin: false,
          deletedAt: null,
        }),
      }),
      prisma.user.count({
        where: excludeRbacSystemPrincipalsWhere({
          deletedAt: { gte: from, lte: to },
          isSuperAdmin: false,
        }),
      }),
      prisma.user.groupBy({
        by: ['plan'],
        where: excludeRbacSystemPrincipalsWhere({
          subscriptionStatus: 'active',
          isSuperAdmin: false,
          deletedAt: null,
        }),
        _count: { plan: true },
      }),
      // Per-plan headcount across *all* non-deleted users (not just
      // active subscriptions). This gives the admin a sense of how the
      // total user base is distributed between tiers, including FREE.
      prisma.user.groupBy({
        by: ['plan'],
        where: excludeRbacSystemPrincipalsWhere({
          isSuperAdmin: false,
          deletedAt: null,
        }),
        _count: { plan: true },
      }),
      prisma.user.findMany({
        where: excludeRbacSystemPrincipalsWhere({
          createdAt: { gte: trendFrom },
          isSuperAdmin: false,
        }),
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

  // Total headcount for the status page (full base, not range-bound).
  const totalUsers = await prisma.user.count({
    where: excludeRbacSystemPrincipalsWhere({
      isSuperAdmin: false,
      deletedAt: null,
    }),
  });

  const mrrRounded = Math.round(mrrProxy * 100) / 100;
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    newUsers,
    activeUsers,
    churnedUsers,
    activeSubscriptions: subsByPlan,
    breakdownByPlan,
    signupTrend,
    mrrProxyUsd: mrrRounded,
    // Contract aliases consumed by the admin Status page — keep both
    // namings so neither consumer breaks.
    totalUsers,
    newThisWeek: newUsers,
    activeThisWeek: activeUsers,
    mrrUsd: mrrRounded,
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

  // Month-to-date aggregate from the in-process cost-tracker. Lazy-require
  // so this module stays loadable in tests that stub Prisma without the
  // tracker side-effects (and so a tracker fault never breaks the admin
  // dashboard — we swallow errors and report zeros).
  let currentMonthToDateCost = 0;
  let currentMonthToDateTokens = 0;
  try {
    // eslint-disable-next-line global-require
    const costTracker = require('./ai/cost-tracker');
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );
    const mtd = costTracker.report({ from: monthStart, to: now, includeRecords: false });
    currentMonthToDateCost = Math.round(safeNumber(mtd?.totals?.costUSD) * 1e6) / 1e6;
    currentMonthToDateTokens =
      safeNumber(mtd?.totals?.inputTokens) + safeNumber(mtd?.totals?.outputTokens);
  } catch {
    // never throw — admin dashboard must keep rendering even if the
    // in-process tracker is unavailable.
  }

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
    currentMonthToDateCost,
    currentMonthToDateTokens,
  };
}

async function aggregateFileStats(prisma, range) {
  const { from, to } = parseRange(range);

  // Fixed window for the upload trend — last 7 days, independent of the
  // caller's `range`. Mirrors signupTrend in aggregateUserStats.
  const now = new Date();
  const trendFrom = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      - 6 * 24 * 60 * 60 * 1000
  );

  const [byMime, totals, uploadRows] = await Promise.all([
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
    prisma.file.findMany({
      where: { createdAt: { gte: trendFrom } },
      select: { createdAt: true, size: true },
      // Defensive cap — even at 10k uploads/day we'd only see 70k rows.
      take: 50000,
    }),
  ]);

  const byMimeOut = byMime
    .map((row) => ({
      mimeType: row.mimeType || 'unknown',
      count: row._count?.mimeType || 0,
      bytes: safeNumber(row._sum?.size),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const uploadTrend = _buildUploadTrend(uploadRows, now);

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    filesUploaded: totals._count?._all || 0,
    totalBytes: safeNumber(totals._sum?.size),
    byMime: byMimeOut,
    uploadTrend,
  };
}

async function aggregateAgentStats(prisma, range) {
  const { from, to } = parseRange(range);

  // Fixed window for the agent-task trend — last 7 days, independent of
  // the caller's `range`. Mirrors signupTrend / uploadTrend.
  const now = new Date();
  const trendFrom = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      - 6 * 24 * 60 * 60 * 1000
  );

  // Pull a bounded sample so we can compute durations + success rate.
  // For very large datasets, swap with a raw SQL percentile query — but
  // for the admin dashboard a 5000-row cap is plenty.
  const SAMPLE_CAP = 5000;
  const [tasks, trendRows] = await Promise.all([
    prisma.agentTask.findMany({
      where: { createdAt: { gte: from, lte: to } },
      select: { status: true, createdAt: true, completedAt: true, failedAt: true },
      take: SAMPLE_CAP,
      orderBy: { createdAt: 'desc' },
    }),
    // Trend rows must include tasks whose `createdAt` falls outside the
    // trend window but whose `completedAt`/`failedAt` lands inside it,
    // so we OR across all three timestamps. Defensive cap of 50k rows.
    prisma.agentTask.findMany({
      where: {
        OR: [
          { createdAt: { gte: trendFrom } },
          { completedAt: { gte: trendFrom } },
          { failedAt: { gte: trendFrom } },
        ],
      },
      select: { status: true, createdAt: true, completedAt: true, failedAt: true },
      take: 50000,
    }),
  ]);

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

  const agentTaskTrend = _buildAgentTaskTrend(trendRows, now);

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    sampleSize: total,
    sampleCap: SAMPLE_CAP,
    success,
    failed,
    successRate: finished ? Math.round((success / finished) * 1000) / 1000 : 0,
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    agentTaskTrend,
  };
}

async function aggregateProductQualityStats(prisma, range) {
  const parsedRange = parseRange(range);
  const spanDays = (parsedRange.to.getTime() - parsedRange.from.getTime()) / (24 * 60 * 60 * 1000);
  if (spanDays > MAX_PRODUCT_QUALITY_WINDOW_DAYS) {
    throw new RangeError(
      `Product quality range cannot exceed ${MAX_PRODUCT_QUALITY_WINDOW_DAYS} days`,
    );
  }

  const dateFilter = { gte: parsedRange.from, lte: parsedRange.to };
  const eligibleUserWhere = excludeRbacSystemPrincipalsWhere({
    isSuperAdmin: false,
    deletedAt: null,
  });
  const activeUserWhere = excludeRbacSystemPrincipalsWhere({
    isSuperAdmin: false,
    deletedAt: null,
    OR: [
      { lastActiveAt: dateFilter },
      { chatRuns: { some: { createdAt: dateFilter } } },
      { agentTasks: { some: { createdAt: dateFilter } } },
    ],
  });
  const assistantMessageWhere = {
    role: 'ASSISTANT',
    deletedAt: null,
    timestamp: dateFilter,
    chat: { user: eligibleUserWhere },
  };

  const [
    eligibleUsers,
    activeUsers,
    adopters,
    chatAdopters,
    agentAdopters,
    chatOutcomeRows,
    agentOutcomeRows,
    assistantMessages,
    feedbackRows,
    trendRows,
  ] = await Promise.all([
    prisma.user.count({ where: eligibleUserWhere }),
    prisma.user.count({ where: activeUserWhere }),
    prisma.user.count({
      where: excludeRbacSystemPrincipalsWhere({
        isSuperAdmin: false,
        deletedAt: null,
        OR: [
          { chatRuns: { some: { createdAt: dateFilter } } },
          { agentTasks: { some: { createdAt: dateFilter } } },
        ],
      }),
    }),
    prisma.user.count({
      where: excludeRbacSystemPrincipalsWhere({
        isSuperAdmin: false,
        deletedAt: null,
        chatRuns: { some: { createdAt: dateFilter } },
      }),
    }),
    prisma.user.count({
      where: excludeRbacSystemPrincipalsWhere({
        isSuperAdmin: false,
        deletedAt: null,
        agentTasks: { some: { createdAt: dateFilter } },
      }),
    }),
    prisma.chatRun.groupBy({
      by: ['status'],
      where: { createdAt: dateFilter, user: eligibleUserWhere },
      _count: { _all: true },
    }),
    prisma.agentTask.groupBy({
      by: ['status'],
      where: { createdAt: dateFilter, user: eligibleUserWhere },
      _count: { _all: true },
    }),
    prisma.message.count({ where: assistantMessageWhere }),
    prisma.message.groupBy({
      by: ['feedback'],
      where: {
        ...assistantMessageWhere,
        feedback: { in: ['liked', 'disliked'] },
      },
      _count: { _all: true },
    }),
    _loadProductQualityTrendRows(prisma, parsedRange),
  ]);

  const chat = _summarizeOutcomeRows(chatOutcomeRows);
  const agents = _summarizeOutcomeRows(agentOutcomeRows);
  const combined = {
    started: chat.started + agents.started,
    completed: chat.completed + agents.completed,
    failed: chat.failed + agents.failed,
    cancelled: chat.cancelled + agents.cancelled,
    inProgress: chat.inProgress + agents.inProgress,
    terminal: chat.terminal + agents.terminal,
  };
  const outcomesSuppressed = combined.terminal < PRODUCT_QUALITY_MINIMUM_COHORT;
  const withRates = (surface) => ({
    ...surface,
    successRate: cohortRatio(
      surface.completed,
      surface.terminal,
      PRODUCT_QUALITY_MINIMUM_COHORT,
    ),
    failureRate: cohortRatio(
      surface.failed,
      surface.terminal,
      PRODUCT_QUALITY_MINIMUM_COHORT,
    ),
    cancellationRate: cohortRatio(
      surface.cancelled,
      surface.terminal,
      PRODUCT_QUALITY_MINIMUM_COHORT,
    ),
    suppressed: surface.terminal < PRODUCT_QUALITY_MINIMUM_COHORT,
  });

  const feedbackCounts = { liked: 0, disliked: 0 };
  for (const row of feedbackRows || []) {
    const feedback = String(row?.feedback || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(feedbackCounts, feedback)) {
      feedbackCounts[feedback] += safeNumber(row?._count?._all);
    }
  }
  const feedbackResponses = feedbackCounts.liked + feedbackCounts.disliked;
  const satisfactionSuppressed = feedbackResponses < PRODUCT_QUALITY_MINIMUM_COHORT;
  const adoptionSuppressed = activeUsers < PRODUCT_QUALITY_MINIMUM_COHORT;
  const { trend, suppressedBuckets } = _buildProductQualityTrend(
    trendRows,
    parsedRange,
    PRODUCT_QUALITY_MINIMUM_COHORT,
  );

  return {
    range: {
      from: parsedRange.from.toISOString(),
      to: parsedRange.to.toISOString(),
    },
    adoption: {
      eligibleUsers,
      activeUsers,
      adopters,
      chatAdopters,
      agentAdopters,
      adoptionRate: cohortRatio(adopters, activeUsers),
      chatAdoptionRate: cohortRatio(chatAdopters, activeUsers),
      agentAdoptionRate: cohortRatio(agentAdopters, activeUsers),
      suppressed: adoptionSuppressed,
    },
    outcomes: withRates(combined),
    surfaces: {
      chat: withRates(chat),
      agents: withRates(agents),
    },
    satisfaction: {
      assistantMessages,
      feedbackResponses,
      liked: satisfactionSuppressed ? null : feedbackCounts.liked,
      disliked: satisfactionSuppressed ? null : feedbackCounts.disliked,
      satisfactionRate: cohortRatio(feedbackCounts.liked, feedbackResponses),
      feedbackCoverageRate: cohortRatio(feedbackResponses, assistantMessages),
      suppressed: satisfactionSuppressed,
    },
    trend,
    privacy: {
      containsPii: false,
      aggregationOnly: true,
      minimumCohort: PRODUCT_QUALITY_MINIMUM_COHORT,
      suppressed: {
        adoption: adoptionSuppressed,
        outcomes: outcomesSuppressed,
        satisfaction: satisfactionSuppressed,
        dailyBuckets: suppressedBuckets,
      },
    },
  };
}

module.exports = {
  PLAN_MRR_USD,
  MAX_PRODUCT_QUALITY_WINDOW_DAYS,
  PRODUCT_QUALITY_MINIMUM_COHORT,
  parseRange,
  percentile,
  safeNumber,
  roundedRatio,
  aggregateUserStats,
  aggregateUsageStats,
  aggregateFileStats,
  aggregateAgentStats,
  aggregateProductQualityStats,
};
