'use strict';

/**
 * Lightweight bridge from chat thumbs / regenerate → routing-feedback.
 *
 * Intelligent routing already consumes `penaltyProvider` (getModelPenalties).
 * This module only records outcomes. Fail-open: missing model, missing
 * routing-feedback, or any throw is a no-op.
 */

function extractModel(meta = {}, agentMeta = {}) {
  return meta.model || meta.selectedModel || meta.actualModel
    || agentMeta.model || agentMeta.selectedModel || agentMeta.actualModel
    || null;
}

function extractIntent(meta = {}, agentMeta = {}) {
  return meta.intent || agentMeta.intent || 'chat';
}

function extractDifficulty(meta = {}, agentMeta = {}) {
  return meta.difficulty || agentMeta.difficulty || null;
}

function loadRoutingFeedback(impl) {
  if (impl) return impl;
  try {
    return require('../routing-feedback');
  } catch {
    return null;
  }
}

function outcomeForFeedback(feedback) {
  const s = String(feedback || '').toLowerCase().trim();
  if (s === 'liked' || s === 'up' || s === 'chosen' || s === 'helpful') return 'success';
  if (s === 'disliked' || s === 'down' || s === 'rejected' || s === 'unhelpful') return 'disliked';
  if (s === 'regenerate' || s === 'regenerated') return 'regenerated';
  return null;
}

/**
 * Record a routing outcome from a thumb or regenerate.
 *
 * @returns {{ recorded: boolean, outcome?: string, reason?: string }}
 */
function recordFromUserSignal(args) {
  try {
    const {
      feedback,
      outcome,
      model,
      intent,
      difficulty,
      metadata,
      agentMetadata,
      routingFeedback,
    } = args || {};
    const meta = metadata && typeof metadata === 'object' ? metadata : {};
    const agentMeta = agentMetadata && typeof agentMetadata === 'object' ? agentMetadata : {};
    const resolvedModel = model || extractModel(meta, agentMeta);
    const resolvedOutcome = outcome || outcomeForFeedback(feedback);
    if (!resolvedOutcome) return { recorded: false, reason: 'unknown_outcome' };
    if (!resolvedModel) return { recorded: false, reason: 'no_model' };
    const rf = loadRoutingFeedback(routingFeedback);
    if (!rf || typeof rf.recordOutcome !== 'function') {
      return { recorded: false, reason: 'unavailable' };
    }
    rf.recordOutcome({
      model: resolvedModel,
      intent: intent || extractIntent(meta, agentMeta),
      difficulty: difficulty || extractDifficulty(meta, agentMeta),
      outcome: resolvedOutcome,
    });
    return { recorded: true, outcome: resolvedOutcome };
  } catch {
    return { recorded: false, reason: 'fail_open' };
  }
}

function recordFromThumb(args) {
  return recordFromUserSignal(args);
}

function recordFromRegenerate(args) {
  return recordFromUserSignal({ ...args, outcome: 'regenerated', feedback: 'regenerated' });
}

/**
 * Implicit negative signal: the software itself saw the turn fail. No thumb
 * involved. `code` is the public generate error code
 * (`connection_unavailable`, `sira_mini_unavailable`, `provider_fallback`,
 * `partial_stream`) or `ttfb_abort` when the first-byte watchdog cut the turn.
 * Never writes a preference row: there is no answer text worth training on.
 */
function outcomeForFailure(code) {
  const c = String(code || '').toLowerCase().trim();
  if (!c) return 'provider_failure';
  if (c === 'ttfb_abort') return 'ttfb_abort';
  return 'provider_failure';
}

function recordFromProviderFailure(args) {
  const a = args && typeof args === 'object' ? args : {};
  const outcome = outcomeForFailure(a.code);
  const out = recordFromUserSignal({ ...a, outcome, feedback: null });
  try {
    require('./metrics').recordImplicitSignal({
      kind: outcome,
      code: a.code || outcome,
    });
  } catch {
    /* telemetry is optional */
  }
  return { ...out, outcome: out.recorded ? out.outcome : outcome };
}

module.exports = {
  extractModel,
  outcomeForFeedback,
  outcomeForFailure,
  recordFromUserSignal,
  recordFromThumb,
  recordFromRegenerate,
  recordFromProviderFailure,
};
