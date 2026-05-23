/**
 * Database probe — issues `SELECT 1` against a Prisma client.
 * The Prisma client is injected to keep this module decoupled from the
 * project's database wiring (and trivially testable).
 */

'use strict';

const { Probe, CATEGORY } = require('../probe');

function createDbProbe({
  prisma,
  name = 'database',
  category = CATEGORY.CRITICAL,
  timeoutMs = 1500,
  ttlMs = 5000,
} = {}) {
  if (!prisma || typeof prisma.$queryRaw !== 'function') {
    throw new TypeError('createDbProbe: a Prisma client with $queryRaw is required');
  }

  return new Probe({
    name,
    category,
    timeoutMs,
    ttlMs,
    check: async () => {
      // Prisma exposes $queryRaw as a tagged template; we invoke it as a
      // function with a raw "string-like" array to keep the probe agnostic.
      const t0 = Date.now();
      const rows = await prisma.$queryRaw`SELECT 1 as ok`;
      const elapsedMs = Date.now() - t0;
      const okValue = Array.isArray(rows) && rows.length ? rows[0].ok ?? rows[0].OK : null;
      return {
        status: okValue === 1 || okValue === '1' || okValue === true ? 'pass' : 'warn',
        details: { driverElapsedMs: elapsedMs, sampleRows: Array.isArray(rows) ? rows.length : 0 },
      };
    },
  });
}

module.exports = { createDbProbe };
