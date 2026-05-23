/**
 * sweep-inactive-api-keys — ratchet 45 (Task 2) ApiKey inactivity GC.
 *
 * Cycle 88 wired the auth middleware to fire-and-forget update
 * `ApiKey.lastUsedAt` on every successful call. A key that has not
 * been touched for a long stretch is effectively abandoned; keeping
 * the row around is a credential-surface liability with no operational
 * upside (rotating it is a one-line `apiKeysService.create`).
 *
 * This sweep hard-deletes any ApiKey whose `lastUsedAt` is set and
 * strictly older than `now - INACTIVE_DAYS` (default 180d). Keys with
 * `lastUsedAt = null` (minted but never used) are left untouched —
 * they're cleaned up by their own `expiresAt` (see
 * `sweep-expired-api-keys.js`) or by the operator.
 *
 * Companion to `sweep-expired-api-keys.js`: that job removes rows
 * whose hard expiry has passed; this one removes rows whose owner has
 * forgotten about them.
 *
 * Configuration:
 *   SIRAGPT_API_KEY_INACTIVE_DAYS — override the 180d retention.
 *   SIRAGPT_API_KEY_INACTIVE_SWEEP_DRY_RUN — count-only run.
 *
 * Manual usage:
 *   $ node backend/src/jobs/sweep-inactive-api-keys.js
 *   $ node backend/src/jobs/sweep-inactive-api-keys.js --dry-run
 */

'use strict';

const DEFAULT_INACTIVE_DAYS = 180;

function _resolveInactiveDays(opts) {
  if (Number.isFinite(opts?.inactiveDays) && opts.inactiveDays > 0) {
    return Math.floor(opts.inactiveDays);
  }
  const envRaw = process.env.SIRAGPT_API_KEY_INACTIVE_DAYS;
  if (envRaw != null && envRaw !== '') {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_INACTIVE_DAYS;
}

function _bumpCounter(delta) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter('siragpt_api_keys_inactive_swept_total', {}, delta);
    }
  } catch { /* metrics best-effort */ }
}

/**
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   dryRun?: boolean,
 *   now?: Date,
 *   inactiveDays?: number,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  const prisma = opts.prisma || require('../config/database');
  const dryRun = Boolean(opts.dryRun);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const inactiveDays = _resolveInactiveDays(opts);
  const cutoff = new Date(now.getTime() - inactiveDays * 24 * 60 * 60 * 1000);

  const where = { lastUsedAt: { lt: cutoff, not: null } };

  logger.info?.(
    `[sweep-inactive-api-keys] starting now=${now.toISOString()} `
      + `cutoff=${cutoff.toISOString()} inactiveDays=${inactiveDays} dryRun=${dryRun}`,
  );

  if (dryRun) {
    const candidates = await prisma.apiKey.count({ where });
    logger.info?.(`[sweep-inactive-api-keys] dry-run candidates=${candidates}`);
    return {
      deleted: 0,
      candidates,
      dryRun: true,
      now: now.toISOString(),
      cutoff: cutoff.toISOString(),
      inactiveDays,
    };
  }

  const res = await prisma.apiKey.deleteMany({ where });
  const deleted = typeof res?.count === 'number' ? res.count : 0;
  _bumpCounter(deleted);

  logger.info?.(`[sweep-inactive-api-keys] done deleted=${deleted}`);

  return {
    deleted,
    dryRun: false,
    now: now.toISOString(),
    cutoff: cutoff.toISOString(),
    inactiveDays,
  };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      console.log('[sweep-inactive-api-keys] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[sweep-inactive-api-keys] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run, DEFAULT_INACTIVE_DAYS };
