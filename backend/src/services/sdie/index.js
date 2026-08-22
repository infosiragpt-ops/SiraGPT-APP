'use strict';

/**
 * SIRA Document Intelligence Engine — SDIE v2 (Phase 1).
 *
 * Compile RequestSpec → plan full-document walk (no top-k) → generate with
 * DeepSeek V4 Flash/Pro → deterministic validators → repair ≤3 → only the
 * approved plain answer reaches the user.
 */

const { isSdieV2Enabled, isDocEngineEnabled, FLAG_NAME } = require('./flags');
const { compileIntent, shouldHandle, hasDocumentText } = require('./request-spec');
const { extractDocuments } = require('./extract');
const { buildPlan } = require('./planner');
const { validateAnswer } = require('./validators');
const { generateApprovedAnswer } = require('./generate');
const { collectEditorialSnippets } = require('./editorial');

function shouldSkipTopK(spec) {
  return spec?.strategy === 'summarize_full' || spec?.scope?.coverage === 'full';
}

async function runSdieTurn({
  prompt,
  files = [],
  surface = 'chat',
  env = process.env,
  complete,
  signal,
} = {}) {
  if (!isSdieV2Enabled(env)) {
    return { handled: false, reason: 'flag_off' };
  }
  const spec = compileIntent(prompt);
  if (!shouldHandle({ prompt, files, spec, env })) {
    return { handled: false, reason: 'not_sdie_turn', spec };
  }

  const plan = buildPlan(spec, files);
  if (!plan.docs.length || !(plan.draft || plan.sectionNotes.length)) {
    return { handled: false, reason: 'empty_document', spec, plan };
  }

  const generated = await generateApprovedAnswer({
    spec,
    plan,
    complete,
    env,
    signal,
  });

  if (!generated.ok || !generated.answer) {
    return {
      handled: false,
      reason: 'validation_failed',
      spec,
      plan,
      generated,
    };
  }

  return {
    handled: true,
    surface,
    spec,
    plan,
    answer: generated.answer,
    model: generated.model,
    repairs: generated.repairs,
    engine: 'sdie-v2',
  };
}

module.exports = {
  FLAG_NAME,
  isSdieV2Enabled,
  isDocEngineEnabled,
  compileIntent,
  shouldHandle,
  hasDocumentText,
  shouldSkipTopK,
  extractDocuments,
  buildPlan,
  validateAnswer,
  generateApprovedAnswer,
  collectEditorialSnippets,
  runSdieTurn,
};
