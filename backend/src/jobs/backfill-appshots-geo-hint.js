/**
 * backfill-appshots-geo-hint — Task 24.
 *
 * Task 19 added `Session.geoHint` (human-readable "City, CC") but only
 * populates it inside POST /api/appshots/pair. Devices linked before
 * that deploy keep `geoHint = NULL` and the settings UI shows only the
 * /24 ipHint. This one-shot pass walks every appshots-scoped Session
 * whose `geoHint IS NULL` AND `ipHint IS NOT NULL` and fills the column
 * via `resolveGeoHint`, leaving the device list uniform.
 *
 * Design choices:
 *   - We page through Session rows in batches (default 200) so a user
 *     with thousands of stale rows doesn't pin the connection or the
 *     upstream rate limit. Each batch awaits a configurable inter-call
 *     delay to stay polite with the keyless ipwho.is endpoint.
 *   - Scope filter is applied in JS. Versioned hashes are classified from
 *     their bounded scope prefix; compat plaintext rows require a verified
 *     JWT signature. A one-way digest is never decoded.
 *   - `ipHint` is a /24 or /64 prefix from reduceIp(). We re-hydrate it
 *     to a representative usable address (`a.b.c.1` / `…::1`) before
 *     calling resolveGeoHint — the keyless lookup returns the same
 *     city/country for any host inside the network, and the .0 form
 *     is rejected by some providers as the network address.
 *   - Degrades in silence: if resolveGeoHint returns null (private,
 *     unresolvable, upstream down) we leave the row untouched and bump
 *     the skipped counter. A row is never marked with an empty string.
 *   - Idempotent: re-runs only touch rows that are still NULL.
 *
 * Configuration (env):
 *   APPSHOTS_GEO_BACKFILL_DRY_RUN=true   count-only, no writes
 *   APPSHOTS_GEO_BACKFILL_LIMIT=N        cap rows touched per invocation
 *   APPSHOTS_GEO_BACKFILL_BATCH=N        page size (default 200)
 *   APPSHOTS_GEO_BACKFILL_DELAY_MS=N     sleep between lookups (default 100)
 *
 * Manual usage:
 *   $ node backend/src/jobs/backfill-appshots-geo-hint.js
 *   $ node backend/src/jobs/backfill-appshots-geo-hint.js --dry-run
 *   $ node backend/src/jobs/backfill-appshots-geo-hint.js --limit=500
 *
 * See docs/operations/backfill-appshots-geo-hint.md for the operator
 * runbook (when to run, expected duration, how to monitor).
 */

'use strict';

const jwt = require('jsonwebtoken');
const {
  SESSION_TOKEN_SCOPE_APPSHOTS,
  parseSessionTokenHash,
} = require('../services/auth/session-token-persistence');
const { resolveGeoHint: defaultResolveGeoHint } = require('../utils/geo-lookup');

const DEFAULT_BATCH = 200;
const DEFAULT_DELAY_MS = 100;

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convert a stored ipHint ("81.45.30.0/24" or "2a01:e0a:abc:def::/64")
 * back to a representative usable IP we can hand to resolveGeoHint.
 * Returns null when the shape doesn't look like one of the two prefixes
 * reduceIp emits (defensive — pre-migration rows might carry odd values).
 */
function ipFromHint(hint) {
  if (!hint || typeof hint !== 'string') return null;
  const slash = hint.indexOf('/');
  const base = slash >= 0 ? hint.slice(0, slash) : hint;
  if (!base) return null;
  if (base.includes(':')) {
    // IPv6 /64 stored as "xxxx:xxxx:xxxx:xxxx::" — pick host ::1
    return base.endsWith('::') ? `${base}1` : base;
  }
  const m = base.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  // Swap the host octet from .0 (network) to .1 (representative host).
  // Any other trailing octet (rare) is left untouched.
  if (m[4] === '0') return `${m[1]}.${m[2]}.${m[3]}.1`;
  return base;
}

function isAppshotsSession(row, secret) {
  const token = row?.token;
  if (!token || typeof token !== 'string') return false;
  const storedHash = parseSessionTokenHash(token);
  if (storedHash) return storedHash.scope === SESSION_TOKEN_SCOPE_APPSHOTS;
  if (!secret) return false;
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      ignoreExpiration: true,
    });
    return decoded?.scope === 'appshots:capture';
  } catch (_) {
    return false;
  }
}

/**
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   dryRun?: boolean,
 *   limit?: number,
 *   batchSize?: number,
 *   delayMs?: number,
 *   resolveGeoHint?: (ip: string) => Promise<string|null>,
 *   jwtSecret?: string,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  const prisma = opts.prisma || require('../config/database');
  const dryRun = Boolean(opts.dryRun);
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : Infinity;
  const batchSize = Number.isFinite(opts.batchSize) && opts.batchSize > 0
    ? opts.batchSize
    : DEFAULT_BATCH;
  const delayMs = Number.isFinite(opts.delayMs) && opts.delayMs >= 0
    ? opts.delayMs
    : DEFAULT_DELAY_MS;
  const resolveGeoHint = typeof opts.resolveGeoHint === 'function'
    ? opts.resolveGeoHint
    : defaultResolveGeoHint;
  const jwtSecret = opts.jwtSecret || process.env.JWT_SECRET || '';

  logger.info?.(
    `[backfill-appshots-geo-hint] starting dryRun=${dryRun} batchSize=${batchSize} limit=${
      Number.isFinite(limit) ? limit : 'none'
    } delayMs=${delayMs}`,
  );

  if (!jwtSecret) {
    logger.warn?.('[backfill-appshots-geo-hint] JWT_SECRET not set — cannot verify token scope, aborting');
    return {
      scanned: 0,
      appshotsCandidates: 0,
      filled: 0,
      skippedNonAppshots: 0,
      skippedUnresolvable: 0,
      skippedBadIpHint: 0,
      dryRun,
      aborted: 'missing_jwt_secret',
    };
  }

  const summary = {
    scanned: 0,
    appshotsCandidates: 0,
    filled: 0,
    skippedNonAppshots: 0,
    skippedUnresolvable: 0,
    skippedBadIpHint: 0,
    dryRun,
  };

  let cursor = null;
  // Hard cap on iterations so a malformed cursor / driver bug can't
  // turn this into an infinite loop.
  const maxIterations = 10_000;
  let iterations = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    iterations += 1;
    if (iterations > maxIterations) {
      logger.warn?.('[backfill-appshots-geo-hint] iteration cap reached, stopping');
      break;
    }
    if (summary.filled >= limit) break;

    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.session.findMany({
      where: { geoHint: null, ipHint: { not: null } },
      select: { id: true, token: true, userAgent: true, ipHint: true },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    summary.scanned += rows.length;

    for (const row of rows) {
      if (summary.filled >= limit) break;

      if (!isAppshotsSession(row, jwtSecret)) {
        summary.skippedNonAppshots += 1;
        continue;
      }
      summary.appshotsCandidates += 1;

      const ip = ipFromHint(row.ipHint);
      if (!ip) {
        summary.skippedBadIpHint += 1;
        continue;
      }

      let geoHint = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        geoHint = await resolveGeoHint(ip);
      } catch (err) {
        logger.warn?.(
          `[backfill-appshots-geo-hint] lookup threw for session=${row.id}: ${err?.message || err}`,
        );
        geoHint = null;
      }

      if (!geoHint) {
        summary.skippedUnresolvable += 1;
      } else if (dryRun) {
        summary.filled += 1;
      } else {
        try {
          // eslint-disable-next-line no-await-in-loop
          await prisma.session.update({
            where: { id: row.id },
            data: { geoHint },
          });
          summary.filled += 1;
        } catch (err) {
          // Row may have been revoked between findMany and update —
          // treat as a silent skip rather than failing the whole pass.
          logger.warn?.(
            `[backfill-appshots-geo-hint] update failed for session=${row.id}: ${err?.message || err}`,
          );
          summary.skippedUnresolvable += 1;
        }
      }

      if (delayMs) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(delayMs);
      }
    }

    if (rows.length < batchSize) break;
  }

  logger.info?.(
    `[backfill-appshots-geo-hint] done ${JSON.stringify(summary)}`,
  );
  return summary;
}

function parseCliArgs(argv) {
  const opts = {};
  if (argv.includes('--dry-run')) opts.dryRun = true;
  if (process.env.APPSHOTS_GEO_BACKFILL_DRY_RUN === 'true') opts.dryRun = true;
  for (const arg of argv) {
    const m = arg.match(/^--(limit|batch-size|delay-ms)=(\d+)$/);
    if (!m) continue;
    const val = parseInt(m[2], 10);
    if (m[1] === 'limit') opts.limit = val;
    if (m[1] === 'batch-size') opts.batchSize = val;
    if (m[1] === 'delay-ms') opts.delayMs = val;
  }
  if (opts.limit == null && process.env.APPSHOTS_GEO_BACKFILL_LIMIT) {
    const v = parseInt(process.env.APPSHOTS_GEO_BACKFILL_LIMIT, 10);
    if (Number.isFinite(v) && v > 0) opts.limit = v;
  }
  if (opts.batchSize == null && process.env.APPSHOTS_GEO_BACKFILL_BATCH) {
    const v = parseInt(process.env.APPSHOTS_GEO_BACKFILL_BATCH, 10);
    if (Number.isFinite(v) && v > 0) opts.batchSize = v;
  }
  if (opts.delayMs == null && process.env.APPSHOTS_GEO_BACKFILL_DELAY_MS) {
    const v = parseInt(process.env.APPSHOTS_GEO_BACKFILL_DELAY_MS, 10);
    if (Number.isFinite(v) && v >= 0) opts.delayMs = v;
  }
  return opts;
}

if (require.main === module) {
  const opts = parseCliArgs(process.argv.slice(2));
  run(opts)
    .then((summary) => {
      // eslint-disable-next-line no-console
      console.log('[backfill-appshots-geo-hint] result:', summary);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[backfill-appshots-geo-hint] fatal:', err);
      process.exit(1);
    });
}

module.exports = {
  run,
  ipFromHint,
  isAppshotsSession,
  // Backward-compatible unit-test/export surface for legacy plaintext rows.
  isAppshotsToken: (token, secret) => isAppshotsSession({ token }, secret),
};
