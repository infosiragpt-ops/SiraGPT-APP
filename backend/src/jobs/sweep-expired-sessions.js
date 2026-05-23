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
  const emailService = opts.emailService || _tryRequireEmailService();
  const isAppshotsToken = opts.isAppshotsToken || _tryRequireIsAppshotsToken();

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

  // Task 21 — before the bulk deleteMany, look up the rows we're about to
  // remove so we can fan a `sendAppshotsDeviceAutoRevoked` email to the
  // owner of every Appshots-scoped session that this sweep is about to
  // delete. The user otherwise gets logged out silently: the auth
  // middleware Task 17 path doesn't fire here because the session row
  // never reaches authenticateToken — the cron deletes it first.
  //
  // We deliberately scope the lookup to sessions whose user still
  // exists and isn't soft-deleted; emailing the owner of a deleted
  // account would just bounce.
  let appshotsNotices = 0;
  let appshotsCandidates = [];
  if (isAppshotsToken && typeof prisma.session.findMany === 'function') {
    try {
      appshotsCandidates = await prisma.session.findMany({
        where: { expiresAt: { lte: now } },
        select: {
          id: true,
          token: true,
          expiresAt: true,
          user: { select: { id: true, email: true, name: true, deletedAt: true } },
        },
      });
    } catch (err) {
      logger.warn?.(
        `[sweep-expired-sessions] findMany for appshots notice failed: ${err?.message || err}`,
      );
      appshotsCandidates = [];
    }
  }

  const res = await prisma.session.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  const deleted = typeof res?.count === 'number' ? res.count : 0;
  _bumpCounter(deleted);

  if (emailService && typeof emailService.sendAppshotsDeviceAutoRevoked === 'function') {
    // Dedup by user+session id so a single sweep doesn't email twice for
    // the same row even if findMany somehow returned duplicates.
    const seen = new Set();
    for (const row of appshotsCandidates) {
      if (!row || !row.user || !row.user.email || row.user.deletedAt) continue;
      if (!isAppshotsToken(row.token)) continue;
      const key = `${row.user.id}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      appshotsNotices += 1;
      Promise.resolve(
        emailService.sendAppshotsDeviceAutoRevoked(row.user, {
          when: now,
          reason: 'token_expired',
        }),
      ).catch((err) => {
        logger.warn?.(
          `[sweep-expired-sessions] auto-revoked email failed user=${row.user.id}: ${err?.message || err}`,
        );
      });
    }
  }

  logger.info?.(
    `[sweep-expired-sessions] done deleted=${deleted} appshotsNotices=${appshotsNotices}`,
  );

  return {
    deleted,
    dryRun: false,
    cutoff: now.toISOString(),
    appshotsNotices,
  };
}

function _tryRequireEmailService() {
  try {
    // eslint-disable-next-line global-require
    return require('../services/email');
  } catch (_) {
    return null;
  }
}

function _tryRequireIsAppshotsToken() {
  try {
    // eslint-disable-next-line global-require
    return require('../utils/appshots-token').isAppshotsToken;
  } catch (_) {
    return null;
  }
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
