/**
 * sweep-expired-partial-sessions — ratchet 45 PartialSession retention.
 *
 * Cycle 134 / ratchet 45 introduced the PartialSession row as a
 * short-lived (5-minute TTL) handoff between the password step and the
 * second-factor step (SMS or TOTP). Once a row has expired or has been
 * consumed it is dead weight — keeping it costs an index slot and
 * leaks the (token, userId) pair into backups for no benefit.
 *
 * This sweep hard-deletes any PartialSession row that is either:
 *   1) past its `expiresAt` (TTL elapsed without redemption), OR
 *   2) consumed more than 1 hour ago (`consumedAt < now - 1h`).
 *
 * The 1-hour grace on consumed rows leaves a small forensic window
 * for post-incident audit ("did this token redeem in the last hour?")
 * without holding the rows forever.
 *
 * Why hard-delete (no soft-delete column)?
 *   PartialSession carries no PII beyond the user FK; the token is
 *   single-use and rejected by the verify handler once expired or
 *   consumed. The owning User keeps the audit trail via the
 *   `login_totp_verified` / `login_2fa_*` AuditLog entries.
 *
 * Configuration:
 *   SIRAGPT_PARTIAL_SESSION_SWEEP_DRY_RUN — set to "true" for a count-only run.
 *
 * Manual usage:
 *   $ node backend/src/jobs/sweep-expired-partial-sessions.js
 *   $ node backend/src/jobs/sweep-expired-partial-sessions.js --dry-run
 */

'use strict';

const CONSUMED_GRACE_MS = 60 * 60 * 1000; // 1 hour

function _bumpCounter(delta) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter('siragpt_partial_sessions_swept_total', {}, delta);
    }
  } catch { /* metrics best-effort */ }
}

function _buildWhere(now) {
  const consumedCutoff = new Date(now.getTime() - CONSUMED_GRACE_MS);
  return {
    OR: [
      { expiresAt: { lt: now } },
      { consumedAt: { lt: consumedCutoff, not: null } },
    ],
  };
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

  const where = _buildWhere(now);

  logger.info?.(
    `[sweep-expired-partial-sessions] starting now=${now.toISOString()} dryRun=${dryRun}`,
  );

  if (dryRun) {
    const candidates = await prisma.partialSession.count({ where });
    logger.info?.(
      `[sweep-expired-partial-sessions] dry-run candidates=${candidates}`,
    );
    return { deleted: 0, candidates, dryRun: true, now: now.toISOString() };
  }

  const res = await prisma.partialSession.deleteMany({ where });
  const deleted = typeof res?.count === 'number' ? res.count : 0;
  _bumpCounter(deleted);

  logger.info?.(`[sweep-expired-partial-sessions] done deleted=${deleted}`);

  return { deleted, dryRun: false, now: now.toISOString() };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      console.log('[sweep-expired-partial-sessions] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[sweep-expired-partial-sessions] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run, CONSUMED_GRACE_MS };
