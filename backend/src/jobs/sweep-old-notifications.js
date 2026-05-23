/**
 * sweep-old-notifications — ratchet 45 Notification retention.
 *
 * The in-app inbox accumulates rows quickly (every payment / org event
 * fans out via trigger-registry → user-notifications). Old rows have
 * no operational value once the user has acknowledged them, and
 * unread-but-stale rows are almost certainly abandoned.
 *
 * This sweep hard-deletes any Notification whose:
 *   - read = true  AND readAt    < now - READ_RETENTION_DAYS   (default 30d)
 *   - read = false AND createdAt < now - UNREAD_RETENTION_DAYS (default 90d)
 *
 * The two conditions are ORed into a single `deleteMany` so we hit
 * the index `(userId, createdAt)` / `(userId, read)` only once.
 *
 * Configuration:
 *   SIRAGPT_NOTIFICATION_READ_RETENTION_DAYS   — override read cutoff (default 30)
 *   SIRAGPT_NOTIFICATION_UNREAD_RETENTION_DAYS — override unread cutoff (default 90)
 *   SIRAGPT_NOTIFICATION_SWEEP_DRY_RUN         — set to "true" for a count-only run.
 *
 * Manual usage:
 *   $ node backend/src/jobs/sweep-old-notifications.js
 *   $ node backend/src/jobs/sweep-old-notifications.js --dry-run
 */

'use strict';

const DEFAULT_READ_RETENTION_DAYS = 30;
const DEFAULT_UNREAD_RETENTION_DAYS = 90;

function _resolveDays(optsValue, envName, fallback) {
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
      metrics.counter('siragpt_notifications_swept_total', {}, delta);
    }
  } catch { /* metrics best-effort */ }
}

function _buildWhere(now, readCutoff, unreadCutoff) {
  return {
    OR: [
      { read: true, readAt: { lt: readCutoff, not: null } },
      { read: false, createdAt: { lt: unreadCutoff } },
    ],
  };
}

/**
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   dryRun?: boolean,
 *   now?: Date,
 *   readRetentionDays?: number,
 *   unreadRetentionDays?: number,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  const prisma = opts.prisma || require('../config/database');
  const dryRun = Boolean(opts.dryRun);
  const now = opts.now instanceof Date ? opts.now : new Date();

  const readDays = _resolveDays(
    opts.readRetentionDays,
    'SIRAGPT_NOTIFICATION_READ_RETENTION_DAYS',
    DEFAULT_READ_RETENTION_DAYS,
  );
  const unreadDays = _resolveDays(
    opts.unreadRetentionDays,
    'SIRAGPT_NOTIFICATION_UNREAD_RETENTION_DAYS',
    DEFAULT_UNREAD_RETENTION_DAYS,
  );

  const readCutoff = new Date(now.getTime() - readDays * 24 * 60 * 60 * 1000);
  const unreadCutoff = new Date(now.getTime() - unreadDays * 24 * 60 * 60 * 1000);
  const where = _buildWhere(now, readCutoff, unreadCutoff);

  logger.info?.(
    `[sweep-old-notifications] starting now=${now.toISOString()} `
      + `readCutoff=${readCutoff.toISOString()} unreadCutoff=${unreadCutoff.toISOString()} `
      + `readDays=${readDays} unreadDays=${unreadDays} dryRun=${dryRun}`,
  );

  if (dryRun) {
    const candidates = await prisma.notification.count({ where });
    logger.info?.(`[sweep-old-notifications] dry-run candidates=${candidates}`);
    return {
      deleted: 0,
      candidates,
      dryRun: true,
      now: now.toISOString(),
      readCutoff: readCutoff.toISOString(),
      unreadCutoff: unreadCutoff.toISOString(),
      readRetentionDays: readDays,
      unreadRetentionDays: unreadDays,
    };
  }

  const res = await prisma.notification.deleteMany({ where });
  const deleted = typeof res?.count === 'number' ? res.count : 0;
  _bumpCounter(deleted);

  logger.info?.(`[sweep-old-notifications] done deleted=${deleted}`);

  return {
    deleted,
    dryRun: false,
    now: now.toISOString(),
    readCutoff: readCutoff.toISOString(),
    unreadCutoff: unreadCutoff.toISOString(),
    readRetentionDays: readDays,
    unreadRetentionDays: unreadDays,
  };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      // eslint-disable-next-line no-console
      console.log('[sweep-old-notifications] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[sweep-old-notifications] fatal:', err);
      process.exit(1);
    });
}

module.exports = {
  run,
  DEFAULT_READ_RETENTION_DAYS,
  DEFAULT_UNREAD_RETENTION_DAYS,
  _buildWhere,
};
