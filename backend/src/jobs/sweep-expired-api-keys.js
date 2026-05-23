/**
 * sweep-expired-api-keys — ratchet 45 ApiKey retention.
 *
 * Cycle 88's ApiKey model carries an optional `expiresAt`. Once that
 * deadline has passed the key is already rejected by the auth middleware
 * (`apiKeysService.isExpired`), so there is no reason to keep the row
 * around. This sweep hard-deletes any ApiKey whose `expiresAt` is set
 * and strictly less than `now`. Keys with `expiresAt = null` (no
 * expiry) are left untouched.
 *
 * Why hard-delete (no soft-delete column)?
 *   ApiKey carries no PII beyond the user FK; the token is already
 *   hashed and the prefix alone is not sensitive. The owning User row
 *   keeps the audit trail for "who minted this key" via the
 *   AuditLog entries emitted on creation.
 *
 * Configuration:
 *   SIRAGPT_API_KEY_SWEEP_DRY_RUN — set to "true" for a count-only run.
 *
 * Manual usage:
 *   $ node backend/src/jobs/sweep-expired-api-keys.js
 *   $ node backend/src/jobs/sweep-expired-api-keys.js --dry-run
 */

'use strict';

function _bumpCounter(delta) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter('siragpt_api_keys_swept_total', {}, delta);
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
    `[sweep-expired-api-keys] starting now=${now.toISOString()} dryRun=${dryRun}`,
  );

  if (dryRun) {
    const candidates = await prisma.apiKey.count({ where });
    logger.info?.(`[sweep-expired-api-keys] dry-run candidates=${candidates}`);
    return { deleted: 0, candidates, dryRun: true, now: now.toISOString() };
  }

  const res = await prisma.apiKey.deleteMany({ where });
  const deleted = typeof res?.count === 'number' ? res.count : 0;
  _bumpCounter(deleted);

  logger.info?.(`[sweep-expired-api-keys] done deleted=${deleted}`);

  return { deleted, dryRun: false, now: now.toISOString() };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      console.log('[sweep-expired-api-keys] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[sweep-expired-api-keys] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run };
