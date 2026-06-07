'use strict';

/**
 * chat-faithfulness-gate.js — Phase 2 of the cognitive core.
 * ───────────────────────────────────────────────────────────────────────────
 * Consumes the reasoning-orchestrator's `verify` plan and runs a selective,
 * post-generation faithfulness / grounding check on the assistant's final
 * answer. When the answer makes claims (numbers, named entities, URLs, file
 * paths…) that are NOT present in the grounding context (RAG evidence, attached
 * files, memory), it produces a transparent "self-check" footer that flags the
 * unverified items — closing the hallucination-detection loop the user can act
 * on, instead of silently shipping ungrounded claims.
 *
 * This module is a thin, PURE orchestration layer over the existing
 * `faithfulness-postprocessor`. It exists so the wiring in routes/ai.js has a
 * unit-testable surface (the route handler itself is a 4k-line monolith). All
 * I/O-free; the only "dependency" is the deterministic scorer, injected for
 * tests.
 *
 * Public API:
 *   shouldVerify(decision)                         → boolean
 *   buildGroundingContext(blocks)                  → [{ kind, text }]
 *   verify({ response, decision, blocks, deps? })  → VerifyResult
 *
 * VerifyResult:
 *   {
 *     ran: boolean,             – whether a check was performed
 *     reason: string,           – why it ran / was skipped
 *     action: 'none'|'pass'|'annotate',
 *     grade?: string,           – A..F faithfulness grade
 *     score?: number,           – 0..1
 *     footer?: string,          – self-check footer to append (iff annotate)
 *     flaggedCounts?: object,   – { numbers, urls, entities, claims, total }
 *     contextSources: number,   – how many grounding sources were available
 *   }
 */

let defaultPostprocessor = null;
try { defaultPostprocessor = require('./faithfulness-postprocessor'); } catch (_) { defaultPostprocessor = null; }

// Minimum answer length to bother checking — very short replies ("Listo.",
// "Sí, correcto.") carry no checkable claims and would only add footer noise.
const MIN_RESPONSE_CHARS = Number(process.env.SIRAGPT_FAITHFULNESS_MIN_CHARS) || 240;

/** Did the orchestrator decide this turn warrants a faithfulness check? */
function shouldVerify(decision) {
  return !!(decision && decision.verify && decision.verify.faithfulness === true);
}

/**
 * Assemble the grounding context from the system-prompt blocks that carry
 * actual evidence. Order matters only for readability; the scorer treats the
 * union as the haystack. Empty/whitespace blocks are dropped.
 */
function buildGroundingContext(blocks = {}) {
  const out = [];
  const push = (kind, text) => {
    if (typeof text === 'string' && text.trim().length > 0) out.push({ kind, text });
  };
  // Strongest grounding first: retrieved evidence + attached file content.
  push('rag_evidence', blocks.evidenceBlock);
  push('file', blocks.uploadedFileContext);
  push('document', blocks.documentEnrichmentBlock);
  // Softer grounding: memory + cross-chat recall.
  push('memory', blocks.memoryBlock);
  push('active_memory', blocks.activeMemoryBlock);
  push('cross_chat', blocks.crossChatBlock);
  // Web-search results, when present, are legitimate grounding too.
  push('web', blocks.webSearchBlock);
  return out;
}

/**
 * Run the selective faithfulness check. Returns a VerifyResult; the caller is
 * responsible for streaming `footer` as an extra SSE frame + appending it to
 * the persisted content when `action === 'annotate'`.
 */
function verify({ response = '', decision = null, blocks = {}, deps = {} } = {}) {
  const postprocessor = 'postprocessor' in deps ? deps.postprocessor : defaultPostprocessor;
  const text = String(response || '');

  if (!shouldVerify(decision)) {
    return { ran: false, reason: 'not_planned', action: 'none', contextSources: 0 };
  }
  if (text.trim().length < MIN_RESPONSE_CHARS) {
    return { ran: false, reason: 'response_too_short', action: 'none', contextSources: 0 };
  }
  if (!postprocessor || typeof postprocessor.postprocess !== 'function') {
    return { ran: false, reason: 'postprocessor_unavailable', action: 'none', contextSources: 0 };
  }

  const context = buildGroundingContext(blocks);
  // No grounding to check against → skip (the faithfulness scorer would only
  // measure internal consistency, which produces noisy footers). High-risk
  // domains still benefit, but only if SOME context exists; otherwise we have
  // nothing to verify against and should not fabricate a warning.
  if (context.length === 0) {
    return { ran: false, reason: 'no_grounding_context', action: 'none', contextSources: 0 };
  }

  const threshold = decision.verify.threshold || 0.55;
  let result;
  try {
    result = postprocessor.postprocess({ response: text, context, mode: 'annotate', threshold });
  } catch (err) {
    return { ran: false, reason: `postprocess_error:${err && err.message ? err.message.slice(0, 80) : 'unknown'}`, action: 'none', contextSources: context.length };
  }

  const report = result.report || {};
  if (result.action === 'pass' || result.action === 'none') {
    return {
      ran: true,
      reason: 'passed',
      action: result.action,
      grade: report.grade,
      score: report.score,
      contextSources: context.length,
    };
  }

  // action === 'annotate' — the answer scored below threshold. Surface the
  // self-check footer the postprocessor built.
  const footer = result.repair && result.repair.userFooter
    ? `\n\n${result.repair.userFooter}`
    : '';
  return {
    ran: true,
    reason: 'below_threshold',
    action: 'annotate',
    grade: report.grade,
    score: report.score,
    footer,
    flaggedCounts: result.repair ? result.repair.flaggedCounts : null,
    contextSources: context.length,
  };
}

module.exports = {
  shouldVerify,
  buildGroundingContext,
  verify,
  MIN_RESPONSE_CHARS,
};
