'use strict';

/**
 * Turn contract for /api/ai/generate: every turn ends with visible text or an
 * explicit, honest Spanish error — never a silent end.
 *
 * Prod 2026-09-26 (Grok 4.7, image of "(a+b)² =" + «resolver este problema»):
 * the first-byte watchdog aborted the turn while an attachment was still being
 * prepared, the provider call then returned '' on the already-aborted signal,
 * and the chat was left on «Pensando…» with no reply and nothing persisted.
 *
 * `classifyEmptyTurn` decides what to tell the user when a turn produced no
 * content. A user Stop (or a closed tab) is not a failure: it returns null.
 */

const TURN_OUTCOME_MESSAGES = Object.freeze({
  adjunto_perdido:
    'No pude leer la imagen adjunta, así que no llegó al modelo. Vuelve a adjuntarla y envía el mensaje de nuevo.',
  cancelado_por_sistema:
    'El modelo no empezó a responder a tiempo y cancelé la espera. Vuelve a enviar tu mensaje; si se repite, prueba con otro modelo.',
  sin_respuesta:
    'El modelo terminó sin dar una respuesta. Vuelve a enviar tu mensaje; si se repite, prueba con otro modelo.',
});

/**
 * @param {object} state
 * @param {boolean} [state.userCancelled]  the user pressed Stop / left
 * @param {boolean} [state.ttfbAborted]    the first-byte watchdog cancelled it
 * @param {number}  [state.imageLoadFailures] attached images that never loaded
 * @returns {null | { category: string, message: string }}
 */
function classifyEmptyTurn(state = {}) {
  if (state.userCancelled) return null;
  let category = 'sin_respuesta';
  if (Number(state.imageLoadFailures) > 0) category = 'adjunto_perdido';
  else if (state.ttfbAborted) category = 'cancelado_por_sistema';
  return { category, message: TURN_OUTCOME_MESSAGES[category] };
}

/** One structured log line per non-silent failed turn. */
function logTurnOutcome(fields = {}, logger = console) {
  const line = {
    reason: fields.reason || null,
    chatId: fields.chatId || null,
    messageId: fields.messageId || null,
    reqId: fields.reqId || null,
    model: fields.model || null,
  };
  try { logger.warn(`[turn-outcome] ${JSON.stringify(line)}`); } catch (_) { /* logging is advisory */ }
  return line;
}

module.exports = {
  TURN_OUTCOME_MESSAGES,
  classifyEmptyTurn,
  logTurnOutcome,
};
