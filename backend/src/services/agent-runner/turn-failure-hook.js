'use strict';

/**
 * Hook from the office tools to the admin turn-failure tracker
 * (`services/observability/turn-failures`, Admin → Logs → «Fallos de
 * respuesta»). The tracker ships in its own PR; this module lazy-requires it
 * and stays a silent no-op until it exists.
 *
 * Tracker contract (PR #818): deep code calls
 *   noteTurn('tool_failure', { tool, reason, fatal, message })
 * inside the request's turn context (AsyncLocalStorage). When the turn
 * closes, a `fatal` note classifies it as `herramienta_fallida`; non-fatal
 * notes travel as context in the failed turn's detail. A tracker exposing
 * only `recordTurnFailure(payload)` is still supported (superset payload).
 *
 * Reported:
 *   - infrastructure, NON-fatal (the model may still recover in the loop):
 *     the office engine is missing, crashed, timed out or the sandbox refused
 *     the command;
 *   - FATAL (changes what the user gets): the turn ended with its last
 *     `verify_visual` failed, or with no renderer to verify at all.
 * NOT reported: operation errors the model corrects in the loop (a `find`
 * that is not in the document, a wrong sheet name…).
 *
 * Never throws, never blocks the turn, and reports each (tool, reason) at
 * most once per turn.
 */

const CATEGORY = 'herramienta_fallida';
const NOTE_KIND = 'tool_failure';

function loadTurnFailureTracker() {
  try {
    const mod = require('../observability/turn-failures');
    if (!mod) return null;
    if (typeof mod.noteTurn === 'function' || typeof mod.recordTurnFailure === 'function') return mod;
    return null;
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
  return function reportOfficeFailure({ tool, code, error, detail, fatal = false } = {}) {
    const reason = String(code || 'engine_error');
    const key = `${tool || 'office'}:${reason}`;
    if (seen.has(key)) return Promise.resolve(false);
    seen.add(key);
    let tracker = null;
    try { tracker = loader(); } catch (_) { tracker = null; }
    if (!tracker) return Promise.resolve(false);
    const message = String(error || reason).slice(0, 500);
    try {
      if (typeof tracker.noteTurn === 'function') {
        tracker.noteTurn(NOTE_KIND, {
          tool: tool || 'office',
          reason,
          fatal: Boolean(fatal),
          message,
          source,
          ...(detail ? { detail } : {}),
        });
        return Promise.resolve(true);
      }
      return Promise.resolve(tracker.recordTurnFailure({
        category: CATEGORY,
        source,
        tool: tool || null,
        reason,
        code: reason,
        message,
        error: message,
        fatal: Boolean(fatal),
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
 * it failing). Returns the FATAL failure to report, or null.
 */
function verificationFailureFromSteps(steps = []) {
  const list = Array.isArray(steps) ? steps : [];
  const edited = list.some((s) => s && s.tool === 'office_edit' && s.ok !== false);
  if (!edited) return null;
  const verifies = list.filter((s) => s && s.tool === 'verify_visual');
  if (!verifies.length) return null;
  const last = verifies[verifies.length - 1];
  if (last.ok !== false) return null;
  if (last.renderUnavailable) {
    return {
      tool: 'verify_visual',
      code: 'renderizador_no_disponible',
      fatal: true,
      error: 'No hubo verificación visual: el renderizador de documentos no está disponible en el sandbox.',
      detail: { attempts: verifies.length },
    };
  }
  return {
    tool: 'verify_visual',
    code: 'verificacion_fallida',
    fatal: true,
    error: `La verificación visual no pasó (intentos: ${verifies.length}).`,
    detail: { attempts: verifies.length, lastPreview: String(last.resultPreview || '').slice(0, 400) },
  };
}

module.exports = {
  CATEGORY,
  NOTE_KIND,
  createOfficeFailureReporter,
  loadTurnFailureTracker,
  verificationFailureFromSteps,
};
