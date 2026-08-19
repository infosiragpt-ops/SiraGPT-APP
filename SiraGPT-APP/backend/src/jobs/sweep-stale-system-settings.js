/**
 * sweep-stale-system-settings — ratchet 45 SystemSettings drift cleanup.
 *
 * Several housekeeping jobs persist their flag set into the `SystemSettings`
 * key/value table (it doubles as a low-frequency, schema-less side-table so
 * we don't need a Prisma migration every time we add a retention worker):
 *
 *   - `org_idle:<orgId>`            — detect-idle-orgs flag (180d retention)
 *   - `user_idle:<userId>`          — detect-idle-users flag (180d retention)
 *   - `apiusage:summary:<YM>:<uid>:<model>` — prune-api-usage rollup (730d / 2y)
 *
 * The owning jobs already self-heal when an entity *returns* to activity
 * (detect-idle-{orgs,users}) or when summaries are re-upserted. But none of
 * them clean up rows whose owning entity has been hard-deleted (orphans)
 * nor enforce a hard age cap on stale summaries that never get touched
 * again. This sweep is the safety net.
 *
 * Conservative deletion policy — we only clear:
 *
 *   1. Rows whose embedded timestamp (detectedAt / yearMonth) is older
 *      than the configured retention for the prefix, AND
 *   2. Rows whose owning entity (org / user) no longer exists in the DB
 *      (orphans). For `apiusage:summary:*`, the user portion of the key
 *      is treated as the owning entity. Summaries belonging to live users
 *      are left alone — operators may still want them for billing audits.
 *
 * Both conditions must be true. A merely-old row whose user still exists
 * is preserved; an orphan row younger than the retention is also preserved
 * (give the owning job's cascade a chance to land first).
 *
 * Configuration:
 *   SIRAGPT_STALE_SYSTEM_SETTINGS_ORG_IDLE_DAYS   (default 180)
 *   SIRAGPT_STALE_SYSTEM_SETTINGS_USER_IDLE_DAYS  (default 180)
 *   SIRAGPT_STALE_SYSTEM_SETTINGS_APIUSAGE_DAYS   (default 730)
 *   SIRAGPT_STALE_SYSTEM_SETTINGS_DRY_RUN         — count-only run.
 *
 * Metrics:
 *   siragpt_stale_system_settings_deleted_total{prefix} — counter per prefix
 *
 * Manual usage:
 *   $ node backend/src/jobs/sweep-stale-system-settings.js
 *   $ node backend/src/jobs/sweep-stale-system-settings.js --dry-run
 */

'use strict';

const ORG_IDLE_PREFIX = 'org_idle:';
const USER_IDLE_PREFIX = 'user_idle:';
const APIUSAGE_SUMMARY_PREFIX = 'apiusage:summary:';

const DEFAULT_ORG_IDLE_DAYS = 180;
const DEFAULT_USER_IDLE_DAYS = 180;
const DEFAULT_APIUSAGE_DAYS = 730;

const DAY_MS = 24 * 60 * 60 * 1000;

function _resolveDays(optsValue, envName, fallback) {
  if (Number.isFinite(optsValue) && optsValue > 0) {
    return Math.floor(optsValue);
  }
  const envRaw = process.env[envName];
  if (envRaw != null && envRaw !== '') {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function _bumpCounter(prefix, delta) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter('siragpt_stale_system_settings_deleted_total', { prefix }, delta);
    }
  } catch { /* metrics best-effort */ }
}

function _safeParseValue(value) {
  if (typeof value !== 'string' || !value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Extract the embedded timestamp from a SystemSettings row payload.
 * - `org_idle:`/`user_idle:` rows carry `detectedAt` (ISO string).
 * - `apiusage:summary:<YYYY-MM>:...` rows carry the year/month in the key
 *   itself; we synthesise a date at the end of that month so the cutoff
 *   compares against the latest moment the summary covers.
 */
function _extractTimestamp(key, parsed) {
  if (key.startsWith(APIUSAGE_SUMMARY_PREFIX)) {
    const rest = key.slice(APIUSAGE_SUMMARY_PREFIX.length);
    const ym = rest.split(':')[0];
    const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
    if (!m) return null;
    const year = Number.parseInt(m[1], 10);
    const month = Number.parseInt(m[2], 10);
    if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
    // End-of-month UTC — covers the entire month before we declare it stale.
    return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const ts = parsed.detectedAt;
  if (typeof ts !== 'string') return null;
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d : null;
}

function _ownerIdFromKey(key) {
  if (key.startsWith(ORG_IDLE_PREFIX)) {
    return { kind: 'org', id: key.slice(ORG_IDLE_PREFIX.length) };
  }
  if (key.startsWith(USER_IDLE_PREFIX)) {
    return { kind: 'user', id: key.slice(USER_IDLE_PREFIX.length) };
  }
  if (key.startsWith(APIUSAGE_SUMMARY_PREFIX)) {
    // apiusage:summary:YYYY-MM:<userId>:<model>
    const parts = key.split(':');
    // parts = ['apiusage','summary','YYYY-MM','<userId>','<model>', ...]
    if (parts.length >= 4) return { kind: 'user', id: parts[3] };
  }
  return null;
}

async function _loadExistingIds(prisma, kind, ids) {
  if (!ids.size) return new Set();
  const arr = Array.from(ids);
  const live = new Set();
  if (kind === 'org') {
    if (!prisma?.organization?.findMany) return live;
    const rows = await prisma.organization.findMany({
      where: { id: { in: arr } },
      select: { id: true },
    });
    for (const r of rows) if (r?.id) live.add(r.id);
  } else if (kind === 'user') {
    if (!prisma?.user?.findMany) return live;
    const rows = await prisma.user.findMany({
      where: { id: { in: arr } },
      select: { id: true },
    });
    for (const r of rows) if (r?.id) live.add(r.id);
  }
  return live;
}

/**
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   dryRun?: boolean,
 *   now?: Date,
 *   orgIdleDays?: number,
 *   userIdleDays?: number,
 *   apiusageDays?: number,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  const prisma = opts.prisma || require('../config/database');
  const dryRun = opts.dryRun != null
    ? Boolean(opts.dryRun)
    : String(process.env.SIRAGPT_STALE_SYSTEM_SETTINGS_DRY_RUN || '').toLowerCase() === 'true';
  const now = opts.now instanceof Date ? opts.now : new Date();

  const orgIdleDays = _resolveDays(
    opts.orgIdleDays,
    'SIRAGPT_STALE_SYSTEM_SETTINGS_ORG_IDLE_DAYS',
    DEFAULT_ORG_IDLE_DAYS,
  );
  const userIdleDays = _resolveDays(
    opts.userIdleDays,
    'SIRAGPT_STALE_SYSTEM_SETTINGS_USER_IDLE_DAYS',
    DEFAULT_USER_IDLE_DAYS,
  );
  const apiusageDays = _resolveDays(
    opts.apiusageDays,
    'SIRAGPT_STALE_SYSTEM_SETTINGS_APIUSAGE_DAYS',
    DEFAULT_APIUSAGE_DAYS,
  );

  const cutoffs = {
    [ORG_IDLE_PREFIX]: new Date(now.getTime() - orgIdleDays * DAY_MS),
    [USER_IDLE_PREFIX]: new Date(now.getTime() - userIdleDays * DAY_MS),
    [APIUSAGE_SUMMARY_PREFIX]: new Date(now.getTime() - apiusageDays * DAY_MS),
  };

  logger.info?.(
    `[sweep-stale-system-settings] starting now=${now.toISOString()} `
      + `orgIdleDays=${orgIdleDays} userIdleDays=${userIdleDays} `
      + `apiusageDays=${apiusageDays} dryRun=${dryRun}`,
  );

  if (!prisma?.systemSettings?.findMany) {
    logger.warn?.('[sweep-stale-system-settings] prisma.systemSettings.findMany unavailable — skipping');
    return {
      scanned: 0,
      deleted: 0,
      candidates: 0,
      perPrefix: { org_idle: 0, user_idle: 0, 'apiusage:summary': 0 },
      dryRun,
      now: now.toISOString(),
      orgIdleDays,
      userIdleDays,
      apiusageDays,
    };
  }

  const prefixes = [ORG_IDLE_PREFIX, USER_IDLE_PREFIX, APIUSAGE_SUMMARY_PREFIX];
  const allRows = [];
  for (const prefix of prefixes) {
    // One query per prefix — keeps the WHERE narrow and lets the index on
    // `key` do the heavy lifting. Each set is small (≤ tens of thousands).
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.systemSettings.findMany({
      where: { key: { startsWith: prefix } },
      select: { key: true, value: true },
    });
    for (const row of rows || []) allRows.push({ ...row, prefix });
  }

  // First pass — filter to rows past the age cutoff. Capture the owner ids
  // we'll need to dereference so we can batch the existence lookup.
  const aged = [];
  const orgIds = new Set();
  const userIds = new Set();
  for (const row of allRows) {
    const parsed = _safeParseValue(row.value);
    const ts = _extractTimestamp(row.key, parsed);
    if (!ts) continue; // un-parseable timestamp — leave alone
    if (ts >= cutoffs[row.prefix]) continue; // still within retention
    const owner = _ownerIdFromKey(row.key);
    if (!owner || !owner.id) continue;
    aged.push({ key: row.key, prefix: row.prefix, owner });
    if (owner.kind === 'org') orgIds.add(owner.id);
    else if (owner.kind === 'user') userIds.add(owner.id);
  }

  // Resolve which owners still exist — orphans are the diff.
  const [liveOrgs, liveUsers] = await Promise.all([
    _loadExistingIds(prisma, 'org', orgIds),
    _loadExistingIds(prisma, 'user', userIds),
  ]);

  // Second pass — keep only orphans.
  const orphanKeys = {
    [ORG_IDLE_PREFIX]: [],
    [USER_IDLE_PREFIX]: [],
    [APIUSAGE_SUMMARY_PREFIX]: [],
  };
  for (const row of aged) {
    const live = row.owner.kind === 'org' ? liveOrgs : liveUsers;
    if (live.has(row.owner.id)) continue; // owner still exists — skip
    orphanKeys[row.prefix].push(row.key);
  }

  const perPrefix = {
    org_idle: 0,
    user_idle: 0,
    'apiusage:summary': 0,
  };
  const labels = {
    [ORG_IDLE_PREFIX]: 'org_idle',
    [USER_IDLE_PREFIX]: 'user_idle',
    [APIUSAGE_SUMMARY_PREFIX]: 'apiusage:summary',
  };

  let deleted = 0;
  const candidates = orphanKeys[ORG_IDLE_PREFIX].length
    + orphanKeys[USER_IDLE_PREFIX].length
    + orphanKeys[APIUSAGE_SUMMARY_PREFIX].length;

  if (dryRun) {
    perPrefix.org_idle = orphanKeys[ORG_IDLE_PREFIX].length;
    perPrefix.user_idle = orphanKeys[USER_IDLE_PREFIX].length;
    perPrefix['apiusage:summary'] = orphanKeys[APIUSAGE_SUMMARY_PREFIX].length;
    logger.info?.(
      `[sweep-stale-system-settings] dry-run scanned=${allRows.length} `
        + `candidates=${candidates} `
        + `org_idle=${perPrefix.org_idle} user_idle=${perPrefix.user_idle} `
        + `apiusage:summary=${perPrefix['apiusage:summary']}`,
    );
    return {
      scanned: allRows.length,
      deleted: 0,
      candidates,
      perPrefix,
      dryRun: true,
      now: now.toISOString(),
      orgIdleDays,
      userIdleDays,
      apiusageDays,
    };
  }

  for (const prefix of prefixes) {
    const keys = orphanKeys[prefix];
    if (!keys.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const res = await prisma.systemSettings.deleteMany({ where: { key: { in: keys } } });
    const count = typeof res?.count === 'number' ? res.count : 0;
    perPrefix[labels[prefix]] = count;
    deleted += count;
    _bumpCounter(labels[prefix], count);
  }

  logger.info?.(
    `[sweep-stale-system-settings] done scanned=${allRows.length} deleted=${deleted} `
      + `org_idle=${perPrefix.org_idle} user_idle=${perPrefix.user_idle} `
      + `apiusage:summary=${perPrefix['apiusage:summary']}`,
  );

  return {
    scanned: allRows.length,
    deleted,
    candidates,
    perPrefix,
    dryRun: false,
    now: now.toISOString(),
    orgIdleDays,
    userIdleDays,
    apiusageDays,
  };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      // eslint-disable-next-line no-console
      console.log('[sweep-stale-system-settings] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[sweep-stale-system-settings] fatal:', err);
      process.exit(1);
    });
}

module.exports = {
  run,
  ORG_IDLE_PREFIX,
  USER_IDLE_PREFIX,
  APIUSAGE_SUMMARY_PREFIX,
  DEFAULT_ORG_IDLE_DAYS,
  DEFAULT_USER_IDLE_DAYS,
  DEFAULT_APIUSAGE_DAYS,
  _extractTimestamp,
  _ownerIdFromKey,
};
