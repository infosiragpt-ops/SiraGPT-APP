/**
 * detect-idle-users — ratchet 45 (Task 1) user idleness detector.
 *
 * Companion to `detect-idle-orgs` — same shape, but at the User level.
 * Walks every (non-deleted, non-super-admin) User and flags those whose
 * `lastActiveAt` sits beyond the idle window (default 90d, vs orgs' 60d
 * — individuals churn slower than tenants). Useful for lifecycle ops
 * (re-engagement emails, free-tier reclamation, dormant-account audits).
 *
 * Result persistence: for every idle user we upsert a SystemSettings row
 * keyed `user_idle:<userId>` with a small JSON payload:
 *
 *   {
 *     userId, email, plan,
 *     daysIdle, lastActiveAt, detectedAt
 *   }
 *
 * Users that *return* to activity (lastActiveAt within the window) have
 * their existing `user_idle:<userId>` row deleted on the same pass, so
 * the SystemSettings table is the source of truth for the current flag
 * set and never accumulates stale entries.
 *
 * Configuration:
 *   SIRAGPT_USER_IDLE_DAYS — override the 90d threshold.
 *   SIRAGPT_USER_IDLE_DRY_RUN — count-only run (no upserts/deletes).
 *
 * Metric:
 *   siragpt_users_idle_total — gauge of currently-flagged users.
 *   siragpt_users_idle_detected_total — counter, # of new flags per run.
 *   siragpt_users_idle_cleared_total — counter, # of cleared flags per run.
 *
 * Manual usage:
 *   $ node backend/src/jobs/detect-idle-users.js
 *   $ node backend/src/jobs/detect-idle-users.js --dry-run
 */

'use strict';

const DEFAULT_IDLE_DAYS = 90;
const KEY_PREFIX = 'user_idle:';

function _resolveIdleDays(opts) {
  if (Number.isFinite(opts?.idleDays) && opts.idleDays > 0) {
    return Math.floor(opts.idleDays);
  }
  const envRaw = process.env.SIRAGPT_USER_IDLE_DAYS;
  if (envRaw != null && envRaw !== '') {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_IDLE_DAYS;
}

function _emitMetrics({ detected, cleared, totalIdle }) {
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (!metrics) return;
    if (typeof metrics.counter === 'function') {
      if (detected) metrics.counter('siragpt_users_idle_detected_total', {}, detected);
      if (cleared) metrics.counter('siragpt_users_idle_cleared_total', {}, cleared);
    }
    if (typeof metrics.gauge === 'function' && Number.isFinite(totalIdle)) {
      metrics.gauge('siragpt_users_idle_total', {}, totalIdle);
    }
  } catch { /* metrics best-effort */ }
}

function _daysBetween(now, then) {
  if (!(then instanceof Date)) return null;
  const ms = now.getTime() - then.getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

async function _loadExistingFlagKeys(prisma) {
  if (!prisma?.systemSettings || typeof prisma.systemSettings.findMany !== 'function') {
    return new Set();
  }
  const rows = await prisma.systemSettings.findMany({
    where: { key: { startsWith: KEY_PREFIX } },
    select: { key: true },
  });
  return new Set(
    (rows || [])
      .map((row) => row && row.key)
      .filter((key) => typeof key === 'string' && key.startsWith(KEY_PREFIX)),
  );
}

/**
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   dryRun?: boolean,
 *   now?: Date,
 *   idleDays?: number,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  const prisma = opts.prisma || require('../config/database');
  const dryRunOpt = opts.dryRun != null
    ? Boolean(opts.dryRun)
    : String(process.env.SIRAGPT_USER_IDLE_DRY_RUN || '').toLowerCase() === 'true';
  const now = opts.now instanceof Date ? opts.now : new Date();
  const idleDays = _resolveIdleDays(opts);
  const cutoff = new Date(now.getTime() - idleDays * 24 * 60 * 60 * 1000);

  logger.info?.(
    `[detect-idle-users] starting now=${now.toISOString()} `
      + `cutoff=${cutoff.toISOString()} idleDays=${idleDays} dryRun=${dryRunOpt}`,
  );

  // Pull every non-deleted, non-super-admin user. Super-admins are
  // operational accounts (us) and shouldn't be flagged; soft-deleted
  // users are already in the hard-delete grace window so flagging them
  // is noise. The table is small enough that a single pass is fine.
  const users = await prisma.user.findMany({
    where: { deletedAt: null, isSuperAdmin: false },
    select: { id: true, email: true, plan: true, lastActiveAt: true },
  });

  let detected = 0;
  let cleared = 0;
  let orphaned = 0;
  let scanned = 0;
  const flagged = [];
  const userIds = new Set(users.map((user) => user.id));
  const existingFlagKeys = await _loadExistingFlagKeys(prisma);

  for (const key of existingFlagKeys) {
    const userId = key.slice(KEY_PREFIX.length);
    if (userIds.has(userId)) continue;
    orphaned += 1;
    if (!dryRunOpt) {
      const del = await prisma.systemSettings.deleteMany({ where: { key } });
      if (del?.count) cleared += del.count;
    }
  }

  for (const user of users) {
    scanned += 1;
    const lastActiveAt = user.lastActiveAt || null;
    const key = `${KEY_PREFIX}${user.id}`;
    const wasFlagged = existingFlagKeys.has(key);
    const isIdle = !lastActiveAt || lastActiveAt < cutoff;

    if (isIdle) {
      const payload = {
        userId: user.id,
        email: user.email,
        plan: user.plan,
        daysIdle: lastActiveAt ? _daysBetween(now, lastActiveAt) : null,
        lastActiveAt: lastActiveAt ? lastActiveAt.toISOString() : null,
        detectedAt: now.toISOString(),
      };
      flagged.push(payload);
      if (!wasFlagged) detected += 1;
      if (!dryRunOpt) {
        const value = JSON.stringify(payload);
        await prisma.systemSettings.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        });
      }
    } else if (wasFlagged) {
      // User is active again — clear any prior flag.
      if (dryRunOpt) {
        cleared += 1;
      } else {
        const del = await prisma.systemSettings.deleteMany({ where: { key } });
        if (del?.count) cleared += del.count;
      }
    }
  }

  if (!dryRunOpt) {
    _emitMetrics({ detected, cleared, totalIdle: flagged.length });
  }

  logger.info?.(
    `[detect-idle-users] done scanned=${scanned} flagged=${flagged.length} `
      + `detected=${detected} cleared=${cleared} orphaned=${orphaned} dryRun=${dryRunOpt}`,
  );

  return {
    scanned,
    flagged: flagged.length,
    detected,
    cleared,
    orphaned,
    dryRun: dryRunOpt,
    now: now.toISOString(),
    cutoff: cutoff.toISOString(),
    idleDays,
    users: dryRunOpt ? flagged : undefined,
  };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      console.log('[detect-idle-users] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[detect-idle-users] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run, DEFAULT_IDLE_DAYS, KEY_PREFIX };
