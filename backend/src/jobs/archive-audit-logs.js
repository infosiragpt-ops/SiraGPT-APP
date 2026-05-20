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
 * Per-org overrides (ratchet 44, task 1):
 *   Each Organization can set `settings.audit.retentionMonths` (1..60,
 *   default 12 → matches the global 365-day default). Before the global
 *   pass runs, the job iterates every org with an override and archives
 *   that org's members' AuditLog rows using the org's custom cutoff.
 *   `actorId` is matched against `OrgMembership.userId` (+ ownerId) so
 *   the per-org pass only touches rows authored by members. The global
 *   pass that follows handles every remaining row (users not in any
 *   override-equipped org) using the default retention.
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
 * Read per-org retentionMonths overrides. Returns an array of
 *   { orgId, retentionDays, actorIds }
 * for each Organization whose `settings.audit.retentionMonths` resolves
 * to a positive integer. `actorIds` is the union of `ownerId` and every
 * `OrgMembership.userId`, deduped — these are the user actorIds whose
 * AuditLog rows the per-org pass owns.
 *
 * Returns an empty list when the Prisma client does not expose the
 * organization / orgMembership delegates (older test stubs).
 */
async function _loadOrgOverrides(prisma, logger) {
  if (!prisma?.organization?.findMany) return [];
  let orgs;
  try {
    orgs = await prisma.organization.findMany({
      select: { id: true, settings: true, ownerId: true },
    });
  } catch (err) {
    logger.warn?.(`[archive-audit-logs] org override scan failed: ${err && err.message}`);
    return [];
  }
  const overrides = [];
  for (const org of orgs || []) {
    const settings = org && org.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) continue;
    const audit = settings.audit;
    if (!audit || typeof audit !== 'object' || Array.isArray(audit)) continue;
    const months = Number(audit.retentionMonths);
    if (!Number.isFinite(months) || months <= 0) continue;
    // Hard-clamp [1, 60] to mirror the zod schema — drift from older
    // settings rows is silently bounded here.
    const clamped = Math.min(60, Math.max(1, Math.floor(months)));
    let memberIds = [];
    if (prisma.orgMembership?.findMany) {
      try {
        const memberships = await prisma.orgMembership.findMany({
          where: { orgId: org.id },
          select: { userId: true },
        });
        memberIds = (memberships || []).map((m) => m.userId).filter(Boolean);
      } catch (err) {
        logger.warn?.(`[archive-audit-logs] org=${org.id} membership scan failed: ${err && err.message}`);
        continue;
      }
    }
    const actorIds = Array.from(new Set([org.ownerId, ...memberIds].filter(Boolean)));
    if (actorIds.length === 0) continue;
    // retentionDays computed from months as a 30-day approximation —
    // matches docs/data-retention.md where 12 months ≈ 365 days.
    overrides.push({
      orgId: org.id,
      retentionDays: clamped * 30,
      retentionMonths: clamped,
      actorIds,
    });
  }
  return overrides;
}

/**
 * Run the archive+delete cycle for a single `where` clause. Mutates
 * `archivesTouched` (a Set) so the caller can aggregate the total
 * number of distinct monthly archives touched across passes. Returns
 * `{ archived, deleted }`.
 */
async function _archiveAndDelete({
  prisma,
  where,
  batchSize,
  dryRun,
  archiveStore,
  now,
  archivesTouched,
}) {
  let archived = 0;
  let pageCursor = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      ...(pageCursor ? { cursor: { id: pageCursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

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

  let deleted = 0;
  if (!dryRun && archived > 0) {
    const res = await prisma.auditLog.deleteMany({ where });
    deleted = typeof res?.count === 'number' ? res.count : 0;
  }
  return { archived, deleted };
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
 *   skipOrgOverrides?: boolean,
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

  const archivesTouched = new Set();
  let totalArchived = 0;
  let totalDeleted = 0;
  const perOrg = [];
  const handledActorIds = new Set();

  // ── Phase 0: per-org retention overrides ──
  const overrides = opts.skipOrgOverrides
    ? []
    : await _loadOrgOverrides(prisma, logger);
  for (const ovr of overrides) {
    const orgCutoff = new Date(now.getTime() - ovr.retentionDays * 24 * 60 * 60 * 1000);
    // Skip actorIds already handled by a prior org pass (membership in
    // two override-equipped orgs → first one wins, deterministic by
    // findMany order). Prevents double-processing the same rows.
    const eligible = ovr.actorIds.filter((id) => !handledActorIds.has(id));
    if (eligible.length === 0) continue;
    for (const id of eligible) handledActorIds.add(id);

    const where = {
      createdAt: { lt: orgCutoff },
      actorId: { in: eligible },
    };
    const { archived, deleted } = await _archiveAndDelete({
      prisma,
      where,
      batchSize,
      dryRun,
      archiveStore,
      now,
      archivesTouched,
    });
    totalArchived += archived;
    totalDeleted += deleted;
    perOrg.push({
      orgId: ovr.orgId,
      retentionMonths: ovr.retentionMonths,
      cutoff: orgCutoff.toISOString(),
      memberCount: eligible.length,
      archived,
      deleted,
    });
    logger.info?.(
      `[archive-audit-logs] org=${ovr.orgId} retentionMonths=${ovr.retentionMonths} archived=${archived} deleted=${deleted}`,
    );
  }

  // ── Phase 1+2: global pass (everything not already handled per-org) ──
  const globalWhere = { createdAt: { lt: cutoff } };
  if (handledActorIds.size > 0) {
    // Exclude actorIds whose rows were already processed under a per-org
    // override. AuditLog rows with `actorId = null` (system actions) and
    // any user not in an override-equipped org are still picked up here.
    globalWhere.NOT = { actorId: { in: Array.from(handledActorIds) } };
  }
  const { archived: globalArchived, deleted: globalDeleted } = await _archiveAndDelete({
    prisma,
    where: globalWhere,
    batchSize,
    dryRun,
    archiveStore,
    now,
    archivesTouched,
  });
  totalArchived += globalArchived;
  totalDeleted += globalDeleted;

  if (!dryRun && totalDeleted > 0) {
    _bumpCounter('row', totalDeleted);
    _bumpCounter('archive', archivesTouched.size);
  }

  logger.info?.(
    `[archive-audit-logs] done archived=${totalArchived} deleted=${totalDeleted} archives=${archivesTouched.size} dryRun=${dryRun} orgOverrides=${overrides.length}`,
  );

  return {
    archived: totalArchived,
    deleted: totalDeleted,
    archives: archivesTouched.size,
    dryRun,
    cutoff: cutoff.toISOString(),
    perOrg,
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

module.exports = { run, _yearMonth, _archiveKey, _loadOrgOverrides };
