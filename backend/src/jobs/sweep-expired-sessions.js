/**
 * sweep-expired-sessions — enforces the Session retention contract.
 *
 * docs/data-retention.md (Session section) declares that "[t]he session
 * sweep job removes rows where `expiresAt <= now()`. There is no
 * tombstone — expired sessions are deleted outright."
 *
 * This job is the actual enforcement. It runs as a single
 * `Session.deleteMany({ expiresAt: { lte: now } })` — the
 * `@@index([expiresAt])` on the `Session` model makes this cheap, and
 * we don't need to page through rows because expired sessions cannot
 * be re-issued (the auth path always stamps a future `expiresAt`).
 *
 * Configuration:
 *   SIRAGPT_SESSION_SWEEP_DRY_RUN — set to "true" for a count-only run.
 *
 * Manual usage:
 *   $ node backend/src/jobs/sweep-expired-sessions.js
 *   $ node backend/src/jobs/sweep-expired-sessions.js --dry-run
 */

'use strict';

function _bumpCounter(delta) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter('siragpt_sessions_swept_total', {}, delta);
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

  logger.info?.(
    `[sweep-expired-sessions] starting cutoff=${now.toISOString()} dryRun=${dryRun}`,
  );

  let candidates = 0;
  if (dryRun) {
    candidates = await prisma.session.count({
      where: { expiresAt: { lte: now } },
    });
    logger.info?.(
      `[sweep-expired-sessions] dry-run candidates=${candidates}`,
    );
    return { deleted: 0, candidates, dryRun: true, cutoff: now.toISOString() };
  }

  const res = await prisma.session.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  const deleted = typeof res?.count === 'number' ? res.count : 0;
  _bumpCounter(deleted);

  logger.info?.(`[sweep-expired-sessions] done deleted=${deleted}`);

  return { deleted, dryRun: false, cutoff: now.toISOString() };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      console.log('[sweep-expired-sessions] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[sweep-expired-sessions] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run };
