/**
 * growth-gauges — daily growth gauges for the «1.000 clientes» dashboard.
 *
 * Emits the growth KPI family (C2 of the KPI tree) as zero-cardinality
 * Prometheus gauges, so the route to 1.000 customers is measurable
 * without any new storage: the values are read from the existing User /
 * Organization tables and live only in the in-process registry that
 * Prometheus scrapes via /internal/metrics.
 *
 *   siragpt_users_registered_total — non-deleted, non-super-admin users.
 *   siragpt_users_active_7d        — users with lastActiveAt within 7d.
 *   siragpt_orgs_registered_total  — organizations created (no soft-delete
 *                                    exists on Organization).
 *
 * Runs daily right after the idle-user detector (which owns the same
 * User-table scan window), so growth numbers refresh in the same nightly
 * pass. Same contract as every other system-cron job: best-effort,
 * failure-isolated, retried via wrapWithRetry, and stamped with the
 * standard siragpt_cron_last_success_timestamp{job="growth-gauges"}.
 *
 * Configuration:
 *   SIRAGPT_GROWTH_ACTIVE_DAYS — override the 7d active window.
 *
 * Metric notes:
 *   - These are gauges (absolute counts), not counters — the name
 *     `_total` follows the existing house style of
 *     siragpt_users_idle_total / siragpt_org_members_total, which are
 *     also point-in-time counts. PromQL `increase()` is meaningless on
 *     them; use `siragpt_users_registered_total` directly, and
 *     `deriv()`/`delta()` for growth rates.
 *
 * Manual usage:
 *   $ node backend/src/jobs/growth-gauges.js
 *   $ node backend/src/jobs/growth-gauges.js --dry-run
 */

'use strict';

const DEFAULT_ACTIVE_DAYS = 7;

function _resolveActiveDays(opts) {
  if (Number.isFinite(opts?.activeDays) && opts.activeDays > 0) {
    return Math.floor(opts.activeDays);
  }
  const envRaw = process.env.SIRAGPT_GROWTH_ACTIVE_DAYS;
  if (envRaw != null && envRaw !== '') {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_ACTIVE_DAYS;
}

function _emitMetrics({ usersRegistered, usersActive7d, orgsRegistered }) {
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (!metrics) return;
    if (typeof metrics.gauge !== 'function') return;
    if (Number.isFinite(usersRegistered)) {
      metrics.gauge('siragpt_users_registered_total', {}, usersRegistered);
    }
    if (Number.isFinite(usersActive7d)) {
      metrics.gauge('siragpt_users_active_7d', {}, usersActive7d);
    }
    if (Number.isFinite(orgsRegistered)) {
      metrics.gauge('siragpt_orgs_registered_total', {}, orgsRegistered);
    }
  } catch { /* metrics best-effort */ }
}

/**
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   dryRun?: boolean,
 *   now?: Date,
 *   activeDays?: number,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  const prisma = opts.prisma || require('../config/database');
  const dryRun = opts.dryRun != null
    ? Boolean(opts.dryRun)
    : String(process.env.SIRAGPT_GROWTH_DRY_RUN || '').toLowerCase() === 'true';
  const now = opts.now instanceof Date ? opts.now : new Date();
  const activeDays = _resolveActiveDays(opts);
  const activeCutoff = new Date(now.getTime() - activeDays * 24 * 60 * 60 * 1000);

  logger.info?.(
    `[growth-gauges] starting now=${now.toISOString()} `
      + `activeCutoff=${activeCutoff.toISOString()} activeDays=${activeDays} dryRun=${dryRun}`,
  );

  // Same population as detect-idle-users: soft-deleted users are already
  // in the hard-delete grace window and super-admins are operational
  // accounts — neither belongs in a growth funnel.
  const [usersRegistered, usersActive7d, orgsRegistered] = await Promise.all([
    prisma.user.count({ where: { deletedAt: null, isSuperAdmin: false } }),
    prisma.user.count({
      where: {
        deletedAt: null,
        isSuperAdmin: false,
        lastActiveAt: { gte: activeCutoff },
      },
    }),
    prisma.organization.count(),
  ]);

  if (!dryRun) {
    _emitMetrics({ usersRegistered, usersActive7d, orgsRegistered });
  }

  logger.info?.(
    `[growth-gauges] done usersRegistered=${usersRegistered} usersActive7d=${usersActive7d} `
      + `orgsRegistered=${orgsRegistered} dryRun=${dryRun}`,
  );

  return {
    usersRegistered,
    usersActive7d,
    orgsRegistered,
    activeDays,
    activeCutoff: activeCutoff.toISOString(),
    now: now.toISOString(),
    dryRun,
  };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      console.log('[growth-gauges] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[growth-gauges] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run, DEFAULT_ACTIVE_DAYS };
