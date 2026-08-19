/**
 * sweep-old-audit-archives — ratchet 45 SystemSettings audit_archive retention.
 *
 * `archive-audit-logs` (cycle 73) folds AuditLog rows past the 1-year
 * online retention into monthly JSON archives keyed
 * `audit_archive:YYYY-MM` in the `SystemSettings` key/value table. The
 * archive bucket lets compliance recover the original rows without a DB
 * restore, but the docs/data-retention.md window is bounded at **3 years
 * total**: after that the archive itself is purged.
 *
 * This sweep is the enforcement. Every `audit_archive:YYYY-MM` row whose
 * embedded year-month is older than the configured archive retention
 * (default 3 years / 36 months) is hard-deleted in a single
 * `deleteMany`. The cutoff compares against the *end* of the archived
 * month so an archive covering "2023-04" is only purged once the entire
 * month of April 2023 sits outside the retention window — operators get
 * the full configured horizon, never a partial month off-by-one.
 *
 * The cron registry (`system-cron.js`) schedules this daily at 07:15 UTC,
 * sitting between the SystemSettings drift sweep (07:00) and the next
 * day's scrub cascade. It's a cheap, single-statement deleteMany and
 * does not contend with the heavier retention passes.
 *
 * Configuration:
 *   SIRAGPT_AUDIT_ARCHIVE_RETENTION_MONTHS (default 36)
 *   SIRAGPT_AUDIT_ARCHIVE_SWEEP_DRY_RUN    — count-only run when "true".
 *
 * Metrics:
 *   siragpt_audit_archives_swept_total — counter, per successful run.
 *
 * Manual usage:
 *   $ node backend/src/jobs/sweep-old-audit-archives.js
 *   $ node backend/src/jobs/sweep-old-audit-archives.js --dry-run
 */

'use strict';

const ARCHIVE_PREFIX = 'audit_archive:';
const DEFAULT_RETENTION_MONTHS = 36; // 3 years

function _resolveMonths(optsValue, envName, fallback) {
  if (Number.isFinite(optsValue) && optsValue > 0) {
    return Math.floor(optsValue);
  }
  const envRaw = process.env[envName];
  if (envRaw != null && envRaw !== '') {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function _bumpCounter(delta) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter('siragpt_audit_archives_swept_total', {}, delta);
    }
  } catch { /* metrics best-effort */ }
}

/**
 * Compute the end-of-month boundary (UTC, last ms of the month) for an
 * `audit_archive:YYYY-MM` key. Returns null when the key tail can't be
 * parsed as a year-month — the row is left alone in that case so a
 * malformed key never gets swept by accident.
 */
function _archiveEndOfMonth(key) {
  if (typeof key !== 'string' || !key.startsWith(ARCHIVE_PREFIX)) return null;
  const ym = key.slice(ARCHIVE_PREFIX.length);
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return null;
  const year = Number.parseInt(m[1], 10);
  const month = Number.parseInt(m[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  // `Date.UTC(year, month, 0, ...)` returns the last day of `month`
  // because day 0 of month+1 == last day of month.
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
}

/**
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   dryRun?: boolean,
 *   now?: Date,
 *   retentionMonths?: number,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  // eslint-disable-next-line global-require
  const prisma = opts.prisma || require('../config/database');
  const dryRun = opts.dryRun != null
    ? Boolean(opts.dryRun)
    : String(process.env.SIRAGPT_AUDIT_ARCHIVE_SWEEP_DRY_RUN || '').toLowerCase() === 'true';
  const now = opts.now instanceof Date ? opts.now : new Date();
  const retentionMonths = _resolveMonths(
    opts.retentionMonths,
    'SIRAGPT_AUDIT_ARCHIVE_RETENTION_MONTHS',
    DEFAULT_RETENTION_MONTHS,
  );

  // Cutoff = `now` rolled back `retentionMonths`. We compare each
  // archive's end-of-month against this cutoff, so anything whose entire
  // month sits before the cutoff is eligible for sweep.
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - retentionMonths);

  logger.info?.(
    `[sweep-old-audit-archives] starting now=${now.toISOString()} `
      + `cutoff=${cutoff.toISOString()} retentionMonths=${retentionMonths} dryRun=${dryRun}`,
  );

  if (!prisma?.systemSettings?.findMany) {
    logger.warn?.('[sweep-old-audit-archives] prisma.systemSettings.findMany unavailable — skipping');
    return {
      scanned: 0,
      candidates: 0,
      deleted: 0,
      dryRun,
      now: now.toISOString(),
      cutoff: cutoff.toISOString(),
      retentionMonths,
    };
  }

  const rows = await prisma.systemSettings.findMany({
    where: { key: { startsWith: ARCHIVE_PREFIX } },
    select: { key: true },
  });

  const expiredKeys = [];
  for (const row of rows || []) {
    const end = _archiveEndOfMonth(row?.key);
    if (!end) continue; // un-parseable — leave alone
    if (end < cutoff) expiredKeys.push(row.key);
  }

  if (dryRun) {
    logger.info?.(
      `[sweep-old-audit-archives] dry-run scanned=${rows?.length || 0} candidates=${expiredKeys.length}`,
    );
    return {
      scanned: rows?.length || 0,
      candidates: expiredKeys.length,
      deleted: 0,
      dryRun: true,
      now: now.toISOString(),
      cutoff: cutoff.toISOString(),
      retentionMonths,
    };
  }

  let deleted = 0;
  if (expiredKeys.length) {
    const res = await prisma.systemSettings.deleteMany({
      where: { key: { in: expiredKeys } },
    });
    deleted = typeof res?.count === 'number' ? res.count : 0;
    _bumpCounter(deleted);
  }

  logger.info?.(
    `[sweep-old-audit-archives] done scanned=${rows?.length || 0} deleted=${deleted}`,
  );

  return {
    scanned: rows?.length || 0,
    candidates: expiredKeys.length,
    deleted,
    dryRun: false,
    now: now.toISOString(),
    cutoff: cutoff.toISOString(),
    retentionMonths,
  };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      // eslint-disable-next-line no-console
      console.log('[sweep-old-audit-archives] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[sweep-old-audit-archives] fatal:', err);
      process.exit(1);
    });
}

module.exports = {
  run,
  ARCHIVE_PREFIX,
  DEFAULT_RETENTION_MONTHS,
  _archiveEndOfMonth,
};
