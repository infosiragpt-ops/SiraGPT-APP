'use strict';

/**
 * codex/run-access — minimal ownership lookups for runs, shared by the SSE
 * stream route (feature 04) and the run engine (feature 05). CodexRun carries
 * `userId` denormalised, so a single scoped query proves ownership without a
 * join. prisma is injectable for offline tests.
 */

const defaultPrisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();

const TERMINAL_RUN_STATUSES = Object.freeze(['done', 'error', 'cancelled']);

function requireDb(db) {
  if (!db || !db.codexRun) throw new Error('database unavailable');
  return db;
}

/**
 * Load a run iff it belongs to `userId`. Returns the row or null (the route
 * maps null → 404, which doubles as the not-yours response — no info leak).
 */
async function findOwnedRun({ runId, userId, db = defaultPrisma }) {
  const prisma = requireDb(db);
  return prisma.codexRun.findFirst({ where: { id: runId, userId } });
}

function isTerminalStatus(status) {
  return TERMINAL_RUN_STATUSES.includes(String(status || ''));
}

module.exports = { findOwnedRun, isTerminalStatus, TERMINAL_RUN_STATUSES };
