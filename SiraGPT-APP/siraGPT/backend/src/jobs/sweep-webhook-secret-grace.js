/**
 * sweep-webhook-secret-grace — ratchet 45 (Task 1) WebhookEndpoint
 * rotate-secret grace window cleanup.
 *
 * Cycle 103 added `previousSecret` + `previousSecretExpiresAt` to
 * `WebhookEndpoint`. When an operator rotates the HMAC secret, the
 * prior value is parked there so downstream consumers have a short
 * window to roll their stored copy without dropped deliveries.
 *
 * Once `previousSecretExpiresAt` is in the past the parked secret is
 * dead weight — and a small liability — so this sweep nulls out both
 * `previousSecret` and `previousSecretExpiresAt` for every endpoint
 * whose grace window has elapsed. The endpoint row itself is left
 * intact; only the carry-over secret material is cleared.
 *
 * Configuration:
 *   SIRAGPT_WEBHOOK_SECRET_GRACE_DRY_RUN — set to "true" for a
 *     count-only run (no writes).
 *
 * Manual usage:
 *   $ node backend/src/jobs/sweep-webhook-secret-grace.js
 *   $ node backend/src/jobs/sweep-webhook-secret-grace.js --dry-run
 */

'use strict';

function _bumpCounter(delta) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter('siragpt_webhook_secret_grace_cleared_total', {}, delta);
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

  const where = { previousSecretExpiresAt: { lt: now, not: null } };

  logger.info?.(
    `[sweep-webhook-secret-grace] starting now=${now.toISOString()} dryRun=${dryRun}`,
  );

  if (dryRun) {
    const candidates = await prisma.webhookEndpoint.count({ where });
    logger.info?.(`[sweep-webhook-secret-grace] dry-run candidates=${candidates}`);
    return { cleared: 0, candidates, dryRun: true, now: now.toISOString() };
  }

  const res = await prisma.webhookEndpoint.updateMany({
    where,
    data: { previousSecret: null, previousSecretExpiresAt: null },
  });
  const cleared = typeof res?.count === 'number' ? res.count : 0;
  _bumpCounter(cleared);

  logger.info?.(`[sweep-webhook-secret-grace] done cleared=${cleared}`);

  return { cleared, dryRun: false, now: now.toISOString() };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      console.log('[sweep-webhook-secret-grace] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[sweep-webhook-secret-grace] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run };
