'use strict';

/**
 * F2 — document-routing telemetry.
 *
 * Every document entry point (chat agentic loop, /api/doc/generate,
 * /api/ai/generate gate, /api/agent/task) logs ONE structured line per
 * document turn stating WHICH path actually served it. This is the F2
 * "telemetría de qué camino respondió" gate: a grep over
 * `[doc-routing]` lines answers "did any document request reach the
 * generic pipeline without passing through the AgentRunner?".
 *
 * Paths:
 *   agent_runner            — the AgentRunner delivered a verified file.
 *   agent_runner_failed     — the runner CLAIMED the turn but could not
 *                             deliver; the user got the honest Spanish
 *                             error (never the generic template).
 *   source_preserving_edit  — the surgical source-preserving editor
 *                             served the turn (edits the user's REAL
 *                             file; never the generic pipeline).
 *   advanced_pipeline       — the legacy advanced-document-pipeline
 *                             served the turn (allowed ONLY when the
 *                             runner did not claim it).
 *   skipped                 — a document-looking turn bypassed every
 *                             document path (agentic loop disabled,
 *                             runner module unavailable, …). `reason`
 *                             says why.
 */

const DOCUMENT_ROUTING_PATHS = Object.freeze([
  'agent_runner',
  'agent_runner_failed',
  'source_preserving_edit',
  'advanced_pipeline',
  'skipped',
]);

/**
 * Emit one structured `[doc-routing]` log line + a best-effort metrics
 * counter. Never throws — telemetry must not be able to break a turn.
 *
 * @param {object} opts
 * @param {string} opts.entry  — 'chat' | 'doc_generate' | 'ai_generate' | 'agent_task'
 * @param {string} opts.path   — one of DOCUMENT_ROUTING_PATHS
 * @param {string} [opts.reason] — skip/fail reason (no_llm, llm_402, …)
 * @param {string} [opts.chatId]
 * @returns {object} the record that was logged
 */
function logDocumentRouting({ entry, path, reason = null, chatId = null } = {}) {
  const record = {
    entry: String(entry || 'unknown'),
    path: DOCUMENT_ROUTING_PATHS.includes(path) ? path : 'skipped',
    ...(reason ? { reason: String(reason).slice(0, 120) } : {}),
    ...(chatId ? { chatId: String(chatId) } : {}),
    ts: new Date().toISOString(),
  };
  try {
    console.log(`[doc-routing] ${JSON.stringify(record)}`);
  } catch (_) { /* telemetry never breaks a turn */ }
  try {
    require('../agents/metrics').counter('document_turn_path_total', {
      entry: record.entry,
      path: record.path,
    });
  } catch (_) { /* metrics optional */ }
  return record;
}

module.exports = {
  DOCUMENT_ROUTING_PATHS,
  logDocumentRouting,
};
