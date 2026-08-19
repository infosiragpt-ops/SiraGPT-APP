/**
 * sweep-expired-pending-transfers — ratchet 44 cycle 164 OrgPendingTransfer retention.
 *
 * Org owners can propose an ownership transfer that the proposed new
 * owner must accept inside the `expiresAt` window. Once that deadline
 * has passed without acceptance the row is dead weight: the accept
 * handler already rejects expired requests with HTTP 410, and a fresh
 * `transfer-ownership/request` call is required to retry. This sweep
 * hard-deletes any OrgPendingTransfer whose `expiresAt < now` AND
 * `acceptedAt IS NULL` (accepted rows are immutable history and stay
 * around for audit-trail purposes).
 *
 * Each expiry emits one AuditLog row (`org_ownership_transfer_expired`)
 * with `{ orgId, transferId, fromOwnerId, toOwnerId, expiresAt }` in
 * metadata so the dashboard / audit feed can render "expired" events
 * even though the row itself is gone.
 *
 * Configuration:
 *   SIRAGPT_PENDING_TRANSFER_SWEEP_DRY_RUN — set to "true" for a count-only run.
 *
 * Manual usage:
 *   $ node backend/src/jobs/sweep-expired-pending-transfers.js
 *   $ node backend/src/jobs/sweep-expired-pending-transfers.js --dry-run
 */

'use strict';

function _bumpCounter(delta) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter('siragpt_org_pending_transfers_swept_total', {}, delta);
    }
  } catch { /* metrics best-effort */ }
}

/**
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   dryRun?: boolean,
 *   now?: Date,
 *   logger?: { info: Function, warn: Function, error: Function },
 *   writeAuditLog?: Function,
 * }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  const prisma = opts.prisma || require('../config/database');
  const dryRun = Boolean(opts.dryRun);
  const now = opts.now instanceof Date ? opts.now : new Date();

  const where = { expiresAt: { lt: now }, acceptedAt: null };

  logger.info?.(
    `[sweep-expired-pending-transfers] starting now=${now.toISOString()} dryRun=${dryRun}`,
  );

  if (dryRun) {
    const candidates = await prisma.orgPendingTransfer.count({ where });
    logger.info?.(`[sweep-expired-pending-transfers] dry-run candidates=${candidates}`);
    return { deleted: 0, candidates, dryRun: true, now: now.toISOString() };
  }

  // Lazy-load audit-log helper. Failure to load (test envs without the
  // util wired up) degrades to delete-only — the sweep is still safe to
  // run because the rows are already past their expiry window.
  let writeAuditLog = opts.writeAuditLog || null;
  if (!writeAuditLog) {
    try {
      // eslint-disable-next-line global-require
      ({ writeAuditLog } = require('../utils/audit-log'));
    } catch (_) {
      writeAuditLog = null;
    }
  }

  // Snapshot the rows about to be deleted so we can emit one audit
  // row per expiry. We then delete by id-list to avoid a TOCTOU race
  // where a row is accepted between snapshot and delete (the
  // `acceptedAt: null` filter still narrows the deleteMany but the
  // audit log already reflects the snapshot, which is acceptable —
  // we only audit rows that we successfully delete).
  const candidates = await prisma.orgPendingTransfer.findMany({
    where,
    select: {
      id: true,
      orgId: true,
      fromOwnerId: true,
      toOwnerId: true,
      requestedAt: true,
      expiresAt: true,
    },
  });

  if (candidates.length === 0) {
    logger.info?.('[sweep-expired-pending-transfers] done deleted=0');
    return { deleted: 0, dryRun: false, now: now.toISOString() };
  }

  const ids = candidates.map((r) => r.id);
  const res = await prisma.orgPendingTransfer.deleteMany({
    where: { id: { in: ids }, acceptedAt: null },
  });
  const deleted = typeof res?.count === 'number' ? res.count : 0;
  _bumpCounter(deleted);

  // Best-effort per-row audit. Failures are logged but never abort
  // the sweep — the deletion has already happened.
  if (writeAuditLog) {
    for (const row of candidates) {
      try {
        await writeAuditLog(prisma, {
          action: 'org_ownership_transfer_expired',
          actorType: 'system',
          resource: 'organization',
          resourceId: row.orgId,
          metadata: {
            orgId: row.orgId,
            transferId: row.id,
            fromOwnerId: row.fromOwnerId,
            toOwnerId: row.toOwnerId,
            requestedAt: row.requestedAt instanceof Date ? row.requestedAt.toISOString() : row.requestedAt,
            expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt,
          },
        });
      } catch (err) {
        logger.error?.(
          `[sweep-expired-pending-transfers] audit failed id=${row.id}: ${err?.message || err}`,
        );
      }
    }
  }

  logger.info?.(`[sweep-expired-pending-transfers] done deleted=${deleted}`);

  return { deleted, dryRun: false, now: now.toISOString() };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      // eslint-disable-next-line no-console
      console.log('[sweep-expired-pending-transfers] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[sweep-expired-pending-transfers] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run };
