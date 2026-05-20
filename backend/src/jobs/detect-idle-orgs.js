/**
 * detect-idle-orgs — ratchet 45 (Task 1) org idleness detector.
 *
 * Walks every Organization and flags those whose membership has shown
 * no User.lastActiveAt activity within the last `IDLE_DAYS` window
 * (default 60d). Useful for billing/lifecycle decisions — a flagged
 * org is a candidate for downgrade, dormancy notice, or seat cleanup.
 *
 * Result persistence: for every idle org we upsert a SystemSettings
 * row keyed `org_idle:<orgId>` with a small JSON payload:
 *
 *   {
 *     orgId, slug, name, plan,
 *     daysIdle, lastMemberActiveAt, detectedAt
 *   }
 *
 * Orgs that *return* to activity (any member with lastActiveAt within
 * the window) have their existing `org_idle:<orgId>` row deleted on
 * the same pass, so the SystemSettings table is the source of truth
 * for the current flag set and never accumulates stale entries.
 *
 * Configuration:
 *   SIRAGPT_ORG_IDLE_DAYS — override the 60d threshold.
 *   SIRAGPT_ORG_IDLE_DRY_RUN — count-only run (no upserts/deletes).
 *
 * Metric:
 *   siragpt_orgs_idle_total — gauge of currently-flagged orgs.
 *   siragpt_orgs_idle_detected_total — counter, # of new flags per run.
 *   siragpt_orgs_idle_cleared_total — counter, # of cleared flags per run.
 *
 * Manual usage:
 *   $ node backend/src/jobs/detect-idle-orgs.js
 *   $ node backend/src/jobs/detect-idle-orgs.js --dry-run
 */

'use strict';

const DEFAULT_IDLE_DAYS = 60;
const KEY_PREFIX = 'org_idle:';

function _resolveIdleDays(opts) {
  if (Number.isFinite(opts?.idleDays) && opts.idleDays > 0) {
    return Math.floor(opts.idleDays);
  }
  const envRaw = process.env.SIRAGPT_ORG_IDLE_DAYS;
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
      if (detected) metrics.counter('siragpt_orgs_idle_detected_total', {}, detected);
      if (cleared) metrics.counter('siragpt_orgs_idle_cleared_total', {}, cleared);
    }
    if (typeof metrics.gauge === 'function' && Number.isFinite(totalIdle)) {
      metrics.gauge('siragpt_orgs_idle_total', {}, totalIdle);
    }
  } catch { /* metrics best-effort */ }
}

function _daysBetween(now, then) {
  if (!(then instanceof Date)) return null;
  const ms = now.getTime() - then.getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
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
    : String(process.env.SIRAGPT_ORG_IDLE_DRY_RUN || '').toLowerCase() === 'true';
  const now = opts.now instanceof Date ? opts.now : new Date();
  const idleDays = _resolveIdleDays(opts);
  const cutoff = new Date(now.getTime() - idleDays * 24 * 60 * 60 * 1000);

  logger.info?.(
    `[detect-idle-orgs] starting now=${now.toISOString()} `
      + `cutoff=${cutoff.toISOString()} idleDays=${idleDays} dryRun=${dryRunOpt}`,
  );

  // Pull every org (id + display attrs needed for the flag payload). The
  // table is small (10^3-10^4 rows even in a busy tenant), so a single
  // pass with per-org aggregate is cheap and far simpler than a raw SQL
  // GROUP BY across the membership join.
  const orgs = await prisma.organization.findMany({
    select: { id: true, slug: true, name: true, billingPlan: true },
  });

  let detected = 0;
  let cleared = 0;
  let scanned = 0;
  const flagged = [];

  for (const org of orgs) {
    scanned += 1;
    // Find the most recent member activity. We don't aggregate in SQL
    // here because we need both the lastActiveAt *and* a fast emptiness
    // check (orgs whose only memberships have lastActiveAt = null are
    // idle by definition). `take: 1` + index on (orgId) gives us O(1).
    const recent = await prisma.orgMembership.findFirst({
      where: { orgId: org.id, user: { lastActiveAt: { not: null } } },
      select: { user: { select: { lastActiveAt: true } } },
      orderBy: { user: { lastActiveAt: 'desc' } },
    });
    const lastMemberActiveAt = recent?.user?.lastActiveAt || null;

    const key = `${KEY_PREFIX}${org.id}`;
    const isIdle = !lastMemberActiveAt || lastMemberActiveAt < cutoff;

    if (isIdle) {
      const payload = {
        orgId: org.id,
        slug: org.slug,
        name: org.name,
        plan: org.billingPlan,
        daysIdle: lastMemberActiveAt ? _daysBetween(now, lastMemberActiveAt) : null,
        lastMemberActiveAt: lastMemberActiveAt ? lastMemberActiveAt.toISOString() : null,
        detectedAt: now.toISOString(),
      };
      flagged.push(payload);
      if (!dryRunOpt) {
        const value = JSON.stringify(payload);
        await prisma.systemSettings.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        });
      }
      detected += 1;
    } else if (!dryRunOpt) {
      // Org is active again — clear any prior flag.
      const del = await prisma.systemSettings.deleteMany({ where: { key } });
      if (del?.count) cleared += del.count;
    }
  }

  _emitMetrics({ detected, cleared, totalIdle: detected });

  logger.info?.(
    `[detect-idle-orgs] done scanned=${scanned} flagged=${detected} `
      + `cleared=${cleared} dryRun=${dryRunOpt}`,
  );

  return {
    scanned,
    flagged: detected,
    cleared,
    dryRun: dryRunOpt,
    now: now.toISOString(),
    cutoff: cutoff.toISOString(),
    idleDays,
    orgs: dryRunOpt ? flagged : undefined,
  };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      console.log('[detect-idle-orgs] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[detect-idle-orgs] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run, DEFAULT_IDLE_DAYS, KEY_PREFIX };
