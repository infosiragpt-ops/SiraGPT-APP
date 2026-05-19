/**
 * archive-audit-logs — enforces the 1-year online AuditLog retention.
 *
 * docs/data-retention.md (cycle 56) declares that `AuditLog` rows are
 * retained online for **1 year**, after which they must be exported to
 * the archive bucket and pruned from the operational database.
 *
 * This job is the actual enforcement and is wired into the
 * `system-cron` registry to run daily at 04:00 UTC (after the
 * scrub / hard-delete / prune-api-usage cascade so the archive picks
 * up any cascade-emitted audit events the same day).
 *
 * It runs in two phases, mirroring `prune-api-usage.js`:
 *
 *   1. Aggregate. Every AuditLog row older than the cutoff is folded
 *      into a monthly JSON archive keyed by `audit_archive:YYYY-MM`.
 *      The archive value is a JSON array of the original rows so that
 *      compliance can still recover the full history without a DB
 *      restore. Persisted via the existing `SystemSettings` key/value
 *      table so this lands without a Prisma migration.
 *
 *   2. Delete. Once the rows are archived we `deleteMany()` everything
 *      past the cutoff in a single statement.
 *
 * The job is *additive*: re-running merges into existing archives by
 * `id`, so a partial run that died between phase 1 and phase 2 will
 * not lose data on the next attempt.
 *
 * Configuration:
 *   AUDIT_RETENTION_DAYS / SIRAGPT_AUDIT_RETENTION_DAYS (default 365)
 *   AUDIT_ARCHIVE_BATCH (default 500)
 *
 * Manual usage:
 *   $ node backend/src/jobs/archive-audit-logs.js
 *   $ node backend/src/jobs/archive-audit-logs.js --dry-run
 */

'use strict';

const DEFAULT_RETENTION_DAYS = Number(
  process.env.SIRAGPT_AUDIT_RETENTION_DAYS || process.env.AUDIT_RETENTION_DAYS || 365,
);
const DEFAULT_BATCH = Number(process.env.AUDIT_ARCHIVE_BATCH || 500);

function _bumpCounter(kind, delta) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter('siragpt_audit_archived_total', { kind }, delta);
    }
  } catch { /* metrics best-effort */ }
}

function _yearMonth(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function _archiveKey(yearMonth) {
  return `audit_archive:${yearMonth}`;
}

/**
 * Default archive store backed by Prisma's `SystemSettings` table.
 * Each month lives under one key. The value is a JSON-encoded object:
 *   { yearMonth, count, rows: [...], updatedAt }
 * `rows` carries the original AuditLog rows (createdAt serialised as
 * ISO 8601). Merging is keyed by `id` so additive re-runs stay
 * idempotent even when the cutoff moves forward across runs.
 */
function _defaultArchiveStore(prisma) {
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

function _serialiseRow(row) {
  return {
    id: row.id,
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    action: row.action,
    before: row.before,
    after: row.after,
    diff: row.diff,
    metadata: row.metadata,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

/**
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   dryRun?: boolean,
 *   retentionDays?: number,
 *   batchSize?: number,
 *   now?: Date,
 *   logger?: { info: Function, warn: Function, error: Function },
 *   archiveStore?: { get: (key: string) => Promise<any>, upsert: (key: string, value: any) => Promise<void> },
 * }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  // Lazy-require Prisma so importers (and tests) can run without DB.
  // eslint-disable-next-line global-require
  const prisma = opts.prisma || require('../config/database');
  const retentionDays = Number.isFinite(opts.retentionDays)
    ? Number(opts.retentionDays)
    : DEFAULT_RETENTION_DAYS;
  const batchSize = Number.isFinite(opts.batchSize) ? Number(opts.batchSize) : DEFAULT_BATCH;
  const dryRun = Boolean(opts.dryRun);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const archiveStore = opts.archiveStore || _defaultArchiveStore(prisma);

  logger.info?.(
    `[archive-audit-logs] starting cutoff=${cutoff.toISOString()} retentionDays=${retentionDays} batchSize=${batchSize} dryRun=${dryRun}`,
  );

  // ── Phase 1: archive ──
  let archived = 0;
  const archivesTouched = new Set();
  let pageCursor = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await prisma.auditLog.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      ...(pageCursor ? { cursor: { id: pageCursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

    // Group this page by yearMonth.
    const groups = new Map();
    for (const r of rows) {
      const ym = _yearMonth(r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt));
      if (!groups.has(ym)) groups.set(ym, []);
      groups.get(ym).push(_serialiseRow(r));
    }

    if (!dryRun) {
      for (const [ym, newRows] of groups) {
        const key = _archiveKey(ym);
        const existing = await archiveStore.get(key);
        const prevRows = existing && Array.isArray(existing.rows) ? existing.rows : [];
        // Dedupe by id so an interrupted run that already archived a
        // batch but failed to delete it doesn't double-store the rows.
        const byId = new Map();
        for (const r of prevRows) byId.set(r.id, r);
        for (const r of newRows) byId.set(r.id, r);
        const merged = Array.from(byId.values());
        await archiveStore.upsert(key, {
          yearMonth: ym,
          count: merged.length,
          rows: merged,
          updatedAt: now.toISOString(),
        });
        archivesTouched.add(key);
      }
    } else {
      for (const ym of groups.keys()) archivesTouched.add(_archiveKey(ym));
    }

    archived += rows.length;
    pageCursor = rows[rows.length - 1].id;
    if (rows.length < batchSize) break;
  }

  // ── Phase 2: delete ──
  let deleted = 0;
  if (!dryRun && archived > 0) {
    const res = await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    deleted = typeof res?.count === 'number' ? res.count : 0;
    _bumpCounter('row', deleted);
    _bumpCounter('archive', archivesTouched.size);
  }

  logger.info?.(
    `[archive-audit-logs] done archived=${archived} deleted=${deleted} archives=${archivesTouched.size} dryRun=${dryRun}`,
  );

  return {
    archived,
    deleted,
    archives: archivesTouched.size,
    dryRun,
    cutoff: cutoff.toISOString(),
  };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      console.log('[archive-audit-logs] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[archive-audit-logs] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run, _yearMonth, _archiveKey };
