/**
 * sweep-expired-announcements — ratchet 45 OrgAnnouncement retention.
 *
 * Org admins can broadcast announcements with an optional `expiresAt`
 * deadline. Once that deadline has passed the announcement is already
 * hidden from the read endpoints, so there is no reason to keep the
 * row around. This sweep hard-deletes any OrgAnnouncement whose
 * `expiresAt` is set and strictly less than `now`. Announcements with
 * `expiresAt = null` (no expiry, "pinned") are left untouched.
 *
 * Configuration:
 *   SIRAGPT_ANNOUNCEMENT_SWEEP_DRY_RUN — set to "true" for a count-only run.
 *
 * Manual usage:
 *   $ node backend/src/jobs/sweep-expired-announcements.js
 *   $ node backend/src/jobs/sweep-expired-announcements.js --dry-run
 */

'use strict';

function _bumpCounter(delta) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter('siragpt_org_announcements_swept_total', {}, delta);
    }
  } catch { /* metrics best-effort */ }
}

/**
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   dryRun?: boolean,
 *   now?: Date,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  const prisma = opts.prisma || require('../config/database');
  const dryRun = Boolean(opts.dryRun);
  const now = opts.now instanceof Date ? opts.now : new Date();

  const where = { expiresAt: { lt: now, not: null } };

  logger.info?.(
    `[sweep-expired-announcements] starting now=${now.toISOString()} dryRun=${dryRun}`,
  );

  if (dryRun) {
    const candidates = await prisma.orgAnnouncement.count({ where });
    logger.info?.(`[sweep-expired-announcements] dry-run candidates=${candidates}`);
    return { deleted: 0, candidates, dryRun: true, now: now.toISOString() };
  }

  const res = await prisma.orgAnnouncement.deleteMany({ where });
  const deleted = typeof res?.count === 'number' ? res.count : 0;
  _bumpCounter(deleted);

  logger.info?.(`[sweep-expired-announcements] done deleted=${deleted}`);

  return { deleted, dryRun: false, now: now.toISOString() };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      console.log('[sweep-expired-announcements] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[sweep-expired-announcements] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run };
