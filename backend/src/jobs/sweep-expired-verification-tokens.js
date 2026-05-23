/**
 * sweep-expired-verification-tokens — enforces EmailVerificationToken retention.
 *
 * Magic-link verification tokens are short-lived; once consumed (or once
 * past their `expiresAt`) they have no further use. We hold onto them
 * for 30 days for forensic/debugging purposes (e.g. "did the user ever
 * verify?") and then delete them outright.
 *
 * This job deletes rows where:
 *   - (consumedAt IS NOT NULL  AND consumedAt < now - 30d) OR
 *   - (expiresAt  < now - 30d)
 *
 * i.e. any row that is "consumed-or-expired" *and* older than 30 days.
 *
 * Configuration:
 *   SIRAGPT_EVT_SWEEP_DRY_RUN     — set to "true" for a count-only run.
 *   SIRAGPT_EVT_SWEEP_RETENTION_DAYS — override the 30-day window.
 *
 * Manual usage:
 *   $ node backend/src/jobs/sweep-expired-verification-tokens.js
 *   $ node backend/src/jobs/sweep-expired-verification-tokens.js --dry-run
 */

'use strict';

const DEFAULT_RETENTION_DAYS = 30;

function _retentionDays() {
  const raw = process.env.SIRAGPT_EVT_SWEEP_RETENTION_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

function _bumpCounter(delta) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter('siragpt_verification_tokens_swept_total', {}, delta);
    }
  } catch { /* metrics best-effort */ }
}

/**
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   dryRun?: boolean,
 *   now?: Date,
 *   retentionDays?: number,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  const prisma = opts.prisma || require('../config/database');
  const dryRun = Boolean(opts.dryRun);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const retentionDays = Number.isFinite(opts.retentionDays) && opts.retentionDays > 0
    ? opts.retentionDays
    : _retentionDays();

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const where = {
    OR: [
      { consumedAt: { not: null, lt: cutoff } },
      { expiresAt: { lt: cutoff } },
    ],
  };

  logger.info?.(
    `[sweep-expired-verification-tokens] starting cutoff=${cutoff.toISOString()} retentionDays=${retentionDays} dryRun=${dryRun}`,
  );

  let candidates = 0;
  if (dryRun) {
    candidates = await prisma.emailVerificationToken.count({ where });
    logger.info?.(
      `[sweep-expired-verification-tokens] dry-run candidates=${candidates}`,
    );
    return {
      deleted: 0,
      candidates,
      dryRun: true,
      cutoff: cutoff.toISOString(),
      retentionDays,
    };
  }

  const res = await prisma.emailVerificationToken.deleteMany({ where });
  const deleted = typeof res?.count === 'number' ? res.count : 0;
  _bumpCounter(deleted);

  logger.info?.(`[sweep-expired-verification-tokens] done deleted=${deleted}`);

  return {
    deleted,
    dryRun: false,
    cutoff: cutoff.toISOString(),
    retentionDays,
  };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      console.log('[sweep-expired-verification-tokens] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[sweep-expired-verification-tokens] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run };
