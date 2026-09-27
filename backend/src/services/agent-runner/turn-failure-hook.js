'use strict';

/**
 * Hook from the office tools to the admin turn-failure tracker
 * (`services/observability/turn-failures.js` → `recordTurnFailure`, AuditLog
 * action `turn_failed`, admin logs UI). The tracker ships in its own PR; this
 * module lazy-requires it and stays a silent no-op until it exists.
 *
 * Reported (category `herramienta_fallida`): failures that change what the
 * user gets —
 *   - infrastructure: the office engine is missing, crashed, timed out or the
 *     sandbox refused the command (the user may get an unverified file);
 *   - verification: the turn ended with the last `verify_visual` failed.
 * NOT reported: operation errors the model corrects in the loop (a `find`
 * that is not in the document, a wrong sheet name…).
 *
 * The payload is a superset (`reason` + `code`, `message` + `error`) so it
 * keeps working whichever names the tracker settles on. Never throws, never
 * blocks the turn, and reports each (tool, reason) at most once per turn.
 */

const CATEGORY = 'herramienta_fallida';

function loadTurnFailureTracker() {
  try {
    const mod = require('../observability/turn-failures');
    return mod && typeof mod.recordTurnFailure === 'function' ? mod : null;
  } catch (_) {
    return null;
  }
}

function createOfficeFailureReporter({
  userId = null,
  chatId = null,
  source = 'agent-runner',
  loader = loadTurnFailureTracker,
} = {}) {
  const seen = new Set();
  return function reportOfficeFailure({ tool, code, error, detail } = {}) {
    const reason = String(code || 'engine_error');
    const key = `${tool || 'office'}:${reason}`;
    if (seen.has(key)) return Promise.resolve(false);
    seen.add(key);
    let tracker = null;
    try { tracker = loader(); } catch (_) { tracker = null; }
    if (!tracker) return Promise.resolve(false);
    const message = String(error || reason).slice(0, 500);
    try {
      return Promise.resolve(tracker.recordTurnFailure({
        category: CATEGORY,
        source,
        tool: tool || null,
        reason,
        code: reason,
        message,
        error: message,
        userId,
        chatId,
        detail: detail || null,
      })).then(() => true, () => false);
    } catch (_) {
      return Promise.resolve(false);
    }
  };
}

/**
 * Turn-level check: the user asked for an edit, the runner produced one, and
 * the LAST visual verification failed (or the turn ran out of attempts with
 * it failing). Returns the failure to report, or null.
 */
function verificationFailureFromSteps(steps = []) {
  const list = Array.isArray(steps) ? steps : [];
  const edited = list.some((s) => s && s.tool === 'office_edit' && s.ok !== false);
  if (!edited) return null;
  const verifies = list.filter((s) => s && s.tool === 'verify_visual');
  if (!verifies.length) return null;
  const last = verifies[verifies.length - 1];
  if (last.ok !== false) return null;
  return {
    tool: 'verify_visual',
    code: 'verificacion_fallida',
    error: `La verificación visual no pasó (intentos: ${verifies.length}).`,
    detail: { attempts: verifies.length, lastPreview: String(last.resultPreview || '').slice(0, 400) },
  };
}

module.exports = {
  CATEGORY,
  createOfficeFailureReporter,
  loadTurnFailureTracker,
  verificationFailureFromSteps,
};
