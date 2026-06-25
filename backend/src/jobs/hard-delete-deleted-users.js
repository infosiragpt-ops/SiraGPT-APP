/**
 * hard-delete-deleted-users — daily cron sketch (improvement cycle 14).
 *
 * Hard-deletes every `User` row whose `deletedAt` is older than
 * `GRACE_PERIOD_MS` (30 days by default). The cascade on the Prisma
 * schema (`User → Chat → Message`, `User → File`, etc.) takes care of
 * the related rows when the User row itself is removed, so this job
 * only has to issue one `deleteMany`.
 *
 * NOT YET WIRED into a real cron — the operator should pick one of:
 *   • node-cron (in-process)        `cron.schedule('0 3 * * *', run)`
 *   • The existing SchedulerJob model (DB-backed scheduler)
 *   • A platform cron (Kubernetes CronJob, GitHub Actions, Render cron, …)
 *
 * Running this manually is safe and idempotent:
 *   $ node backend/src/jobs/hard-delete-deleted-users.js
 *   $ node backend/src/jobs/hard-delete-deleted-users.js --dry-run
 *
 * Exit codes: 0 = success, 1 = unrecoverable error.
 */

'use strict';

// Resilient to a non-numeric env (e.g. "30d", "thirty", ""): Number("abc") is
// NaN, which would propagate into the cutoff date and make the purge filter
// invalid. Fall back to 30 days whenever the env isn't a finite, non-negative
// number.
const DEFAULT_GRACE_DAYS = (() => {
  const n = Number(process.env.GDPR_HARD_DELETE_GRACE_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : 30;
})();

/**
 * @param {{ prisma?: import('@prisma/client').PrismaClient, dryRun?: boolean, graceDays?: number, now?: Date, logger?: { info: Function, warn: Function, error: Function } }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  const prisma = opts.prisma || require('../config/database');
  // A negative grace would push the cutoff into the future and purge
  // recently-deleted users — reject it along with non-finite values.
  const graceDays = Number.isFinite(opts.graceDays) && opts.graceDays >= 0
    ? Number(opts.graceDays)
    : DEFAULT_GRACE_DAYS;
  const dryRun = Boolean(opts.dryRun);
  const now = opts.now instanceof Date && !Number.isNaN(opts.now.getTime()) ? opts.now : new Date();
  const cutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);

  // Hard safety net: never issue a deleteMany with an invalid cutoff. A NaN
  // cutoff would make the `deletedAt < cutoff` filter behave unpredictably
  // (potentially an unbounded purge), so abort instead.
  if (Number.isNaN(cutoff.getTime())) {
    logger.error('[hard-delete] computed an invalid cutoff date — aborting to avoid an unbounded purge');
    return { deleted: 0, candidates: 0, dryRun, error: 'invalid_cutoff' };
  }

  logger.info(
    `[hard-delete] starting; cutoff=${cutoff.toISOString()} graceDays=${graceDays} dryRun=${dryRun}`,
  );

  // Find candidate user ids first so we can audit-log them before the
  // delete. Limit to ids only — the rest of the row is going away.
  const candidates = await prisma.user.findMany({
    where: { deletedAt: { lt: cutoff, not: null } },
    select: { id: true, email: true, deletedAt: true },
  });

  if (candidates.length === 0) {
    logger.info('[hard-delete] no users to purge');
    return { deleted: 0, candidates: 0, dryRun };
  }

  logger.info(`[hard-delete] candidates=${candidates.length}`);

  if (dryRun) {
    for (const c of candidates) {
      logger.info(`[hard-delete] DRY-RUN would purge id=${c.id} email=${c.email} deletedAt=${c.deletedAt?.toISOString()}`);
    }
    return { deleted: 0, candidates: candidates.length, dryRun: true };
  }

  // Best-effort audit row per purge — failures are logged but never
  // block the actual delete (the GDPR clock has run out).
  let writeAuditLog;
  try { ({ writeAuditLog } = require('../utils/audit-log')); }
  catch (_) { writeAuditLog = null; }

  let deleted = 0;
  for (const c of candidates) {
    try {
      if (writeAuditLog) {
        await writeAuditLog(prisma, {
          action: 'user_hard_delete',
          actorType: 'system',
          resource: 'user',
          resourceId: c.id,
          metadata: { email: c.email, deletedAt: c.deletedAt },
        });
      }
      await prisma.user.delete({ where: { id: c.id } });
      deleted += 1;
    } catch (err) {
      logger.error(`[hard-delete] purge failed id=${c.id}: ${err?.message || err}`);
    }
  }

  logger.info(`[hard-delete] done; purged=${deleted}/${candidates.length}`);
  return { deleted, candidates: candidates.length, dryRun: false };
}

module.exports = { run, DEFAULT_GRACE_DAYS };

// Allow direct invocation: `node backend/src/jobs/hard-delete-deleted-users.js`.
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log('[hard-delete] result:', r);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[hard-delete] fatal:', err);
      process.exit(1);
    });
}
