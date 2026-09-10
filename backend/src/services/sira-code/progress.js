'use strict';

/**
 * Verifiable coding-task progress for SiraCode / /agentes chat.
 *
 * Bands match the webdev MVP contract. 100% is reserved for a proven
 * run + preview + tests. Labels stay Spanish; this module only assigns
 * the integer.
 */

const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ls', 'diagnostics', 'webfetch']);
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch']);
const RUN_TOOLS = new Set(['bash']);

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function isComplete(proof = {}) {
  return proof.executed === true && proof.previewOk === true && proof.testsOk === true;
}

function progressForStage(step, extra = {}) {
  const tool = String(extra.tool || '');
  switch (String(step || '')) {
    case 'thinking':
      return 8;
    case 'executing':
      if (READ_TOOLS.has(tool)) return 22;
      if (WRITE_TOOLS.has(tool)) return 48;
      if (RUN_TOOLS.has(tool)) return 72;
      return 40;
    case 'verifying':
      return 88;
    case 'retrying':
      return extra.lastProgress != null ? clamp(extra.lastProgress, 1, 94) : 30;
    case 'cancelled':
    case 'error':
    case 'budgetExceeded':
      return extra.lastProgress != null ? clamp(extra.lastProgress, 1, 94) : 0;
    case 'done':
      return isComplete(extra.proof) ? 100 : 95;
    default:
      return extra.lastProgress != null ? clamp(extra.lastProgress, 0, 95) : 0;
  }
}

function withProgress(session, step, extra = {}) {
  const last = Number(session && session.progress) || 0;
  let next = progressForStage(step, { ...extra, lastProgress: last });
  if (step !== 'done' && step !== 'cancelled' && step !== 'error') {
    next = Math.max(last, next);
  }
  if (session) session.progress = next;
  return next;
}

module.exports = {
  READ_TOOLS,
  WRITE_TOOLS,
  RUN_TOOLS,
  isComplete,
  progressForStage,
  withProgress,
};
