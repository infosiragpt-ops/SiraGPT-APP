/**
 * prune-api-usage — enforces the 90-day ApiUsage row-level retention.
 *
 * docs/data-retention.md (cycle 56) declares that per-call ApiUsage rows
 * are kept for 90 days "to support cost dashboards and abuse
 * investigations", and that "[a]fter 90 days the detailed rows are
 * summarised into the daily / monthly aggregation tables and the source
 * rows are dropped."
 *
 * This job is the actual enforcement. It runs in two phases:
 *
 *   1. Aggregate. Every row older than the cutoff is folded into a
 *      monthly summary keyed by (yearMonth, userId, model). The
 *      aggregate stores total tokens (BigInt), total cost, and the
 *      number of calls. Summaries are persisted as JSON blobs in
 *      `SystemSettings` under the key
 *      `apiusage:summary:YYYY-MM:<userId>:<model>` so we don't need a
 *      Prisma migration to land the retention worker — operators can
 *      later swap the store for a dedicated `ApiUsageMonthly` table
 *      without touching this job's surface (`opts.summaryStore`).
 *
 *   2. Delete. Once every row past the cutoff is folded into a summary
 *      we delete those rows in batches.
 *
 * The aggregate is *additive*: re-running the job is a no-op because the
 * source rows have been removed. If a partial run dies between phase 1
 * and phase 2 the next run will pick up the same rows and add them on
 * top — so we always upsert summaries before deleting.
 *
 * Configuration:
 *   APIUSAGE_RAW_DAYS / SIRAGPT_APIUSAGE_RAW_DAYS (default 90)
 *   APIUSAGE_PRUNE_BATCH (default 1000)
 *
 * Manual usage:
 *   $ node backend/src/jobs/prune-api-usage.js
 *   $ node backend/src/jobs/prune-api-usage.js --dry-run
 */

'use strict';

const DEFAULT_RAW_DAYS = Number(
  process.env.SIRAGPT_APIUSAGE_RAW_DAYS || process.env.APIUSAGE_RAW_DAYS || 90,
);
const DEFAULT_BATCH = Number(process.env.APIUSAGE_PRUNE_BATCH || 1000);

function _bumpCounter(kind, delta) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter('siragpt_apiusage_pruned_total', { kind }, delta);
    }
  } catch { /* metrics best-effort */ }
}

function _yearMonth(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function _summaryKey(yearMonth, userId, model) {
  return `apiusage:summary:${yearMonth}:${userId}:${model}`;
}

/**
 * Default summary store backed by Prisma's `SystemSettings` table. Each
 * summary lives under one key. The value is JSON-encoded:
 *   { yearMonth, userId, model, calls, tokens (string), cost }
 * `tokens` is stringified because BigInt does not survive JSON.
 */
function _defaultSummaryStore(prisma) {
  return {
    async get(key) {
      const row = await prisma.systemSettings.findUnique({ where: { key } });
      if (!row) return null;
      try { return JSON.parse(row.value); } catch { return null; }
    },
    async upsert(key, value) {
      const payload = JSON.stringify(value);
      await prisma.systemSettings.upsert({
        where: { key },
        update: { value: payload },
        create: { key, value: payload },
      });
    },
  };
}

/**
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   dryRun?: boolean,
 *   rawDays?: number,
 *   batchSize?: number,
 *   now?: Date,
 *   logger?: { info: Function, warn: Function, error: Function },
 *   summaryStore?: { get: (key: string) => Promise<any>, upsert: (key: string, value: any) => Promise<void> },
 * }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  const prisma = opts.prisma || require('../config/database');
  const rawDays = Number.isFinite(opts.rawDays) ? Number(opts.rawDays) : DEFAULT_RAW_DAYS;
  const batchSize = Number.isFinite(opts.batchSize) ? Number(opts.batchSize) : DEFAULT_BATCH;
  const dryRun = Boolean(opts.dryRun);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const cutoff = new Date(now.getTime() - rawDays * 24 * 60 * 60 * 1000);
  const summaryStore = opts.summaryStore || _defaultSummaryStore(prisma);

  logger.info?.(
    `[prune-api-usage] starting cutoff=${cutoff.toISOString()} rawDays=${rawDays} batchSize=${batchSize} dryRun=${dryRun}`,
  );

  // ── Phase 1: aggregate ──
  // Stream rows in pages keyed by ascending timestamp so a partial run
  // always makes forward progress on the oldest data first.
  let aggregated = 0;
  let summariesTouched = new Set();
  let pageCursor = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await prisma.apiUsage.findMany({
      where: { timestamp: { lt: cutoff } },
      orderBy: { timestamp: 'asc' },
      take: batchSize,
      ...(pageCursor ? { cursor: { id: pageCursor }, skip: 1 } : {}),
      select: { id: true, userId: true, model: true, tokens: true, cost: true, timestamp: true },
    });
    if (rows.length === 0) break;

    // Group this page by (yearMonth, userId, model) for upsert.
    const groups = new Map();
    for (const r of rows) {
      const ym = _yearMonth(r.timestamp);
      const key = _summaryKey(ym, r.userId, r.model);
      if (!groups.has(key)) {
        groups.set(key, {
          yearMonth: ym,
          userId: r.userId,
          model: r.model,
          calls: 0,
          tokens: 0n,
          cost: 0,
        });
      }
      const g = groups.get(key);
      g.calls += 1;
      // r.tokens is BigInt per the Prisma schema; coerce defensively for stubs.
      const tok = typeof r.tokens === 'bigint' ? r.tokens : BigInt(r.tokens || 0);
      g.tokens += tok;
      g.cost += typeof r.cost === 'number' ? r.cost : Number(r.cost || 0);
    }

    if (!dryRun) {
      for (const [key, g] of groups) {
        const existing = await summaryStore.get(key);
        const prevTokens = existing && existing.tokens != null
          ? BigInt(existing.tokens)
          : 0n;
        const prevCalls = existing && existing.calls != null ? Number(existing.calls) : 0;
        const prevCost = existing && existing.cost != null ? Number(existing.cost) : 0;

        const merged = {
          yearMonth: g.yearMonth,
          userId: g.userId,
          model: g.model,
          calls: prevCalls + g.calls,
          tokens: (prevTokens + g.tokens).toString(), // JSON-safe
          cost: prevCost + g.cost,
          updatedAt: now.toISOString(),
        };
        await summaryStore.upsert(key, merged);
        summariesTouched.add(key);
      }
    } else {
      for (const key of groups.keys()) summariesTouched.add(key);
    }

    aggregated += rows.length;
    pageCursor = rows[rows.length - 1].id;
    if (rows.length < batchSize) break;
  }

  // ── Phase 2: delete ──
  // We `deleteMany` by cutoff rather than tracking the exact row ids —
  // the rows we just aggregated are precisely those with
  // `timestamp < cutoff`, and any racing inserter (live traffic) will
  // by definition use `now()` which is past the cutoff.
  let deleted = 0;
  if (!dryRun && aggregated > 0) {
    const res = await prisma.apiUsage.deleteMany({ where: { timestamp: { lt: cutoff } } });
    deleted = typeof res?.count === 'number' ? res.count : 0;
    _bumpCounter('row', deleted);
    _bumpCounter('summary', summariesTouched.size);
  }

  logger.info?.(
    `[prune-api-usage] done aggregated=${aggregated} deleted=${deleted} summaries=${summariesTouched.size} dryRun=${dryRun}`,
  );

  return {
    aggregated,
    deleted,
    summaries: summariesTouched.size,
    dryRun,
    cutoff: cutoff.toISOString(),
  };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      console.log('[prune-api-usage] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[prune-api-usage] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run, _yearMonth, _summaryKey };
