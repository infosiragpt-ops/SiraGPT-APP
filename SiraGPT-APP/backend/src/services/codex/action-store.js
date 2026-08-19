'use strict';

/**
 * codex/action-store — persistence for CodexAction rows (feature 06). Each tool
 * call the build loop runs is recorded here (kind, command/path, status,
 * outputSummary capped, durationMs, linesRead, groupId) so the timeline can be
 * reconstructed and metrics (feature 08) counted. prisma is injectable.
 */

const defaultPrisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();

const OUTPUT_SUMMARY_CAP = 30_000;

function requireDb(db) {
  if (!db || !db.codexAction) throw new Error('database unavailable');
  return db;
}

function cap(str, n = OUTPUT_SUMMARY_CAP) {
  if (str == null) return null;
  const s = String(str);
  return s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s;
}

async function recordAction({
  runId,
  kind,
  command = null,
  path = null,
  status = 'done',
  outputSummary = null,
  durationMs = null,
  linesRead = null,
  groupId = null,
  prisma = defaultPrisma,
}) {
  const db = requireDb(prisma);
  return db.codexAction.create({
    data: {
      runId,
      kind,
      command: command ? cap(command, 4000) : null,
      path: path ? String(path).slice(0, 1024) : null,
      status,
      outputSummary: cap(outputSummary),
      durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
      linesRead: Number.isFinite(linesRead) ? linesRead : null,
      groupId,
    },
  });
}

module.exports = { recordAction, cap, OUTPUT_SUMMARY_CAP };
