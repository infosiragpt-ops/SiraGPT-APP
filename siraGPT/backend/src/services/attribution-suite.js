'use strict';

/**
 * attribution-suite.js
 *
 * Meta-orchestrator over the full circuit-tracing-style context
 * pipeline. Single entry point that runs:
 *
 *   - context-attribution-engine          (concepts + layered graph + plan + hops + suppression)
 *   - cross-turn-entity-tracker.register  (stable entity registry across turns)
 *   - cross-language-entity-unifier       (cross-language clusters)
 *   - concept-drift-monitor               (topic-shift signal)
 *   - belief-state-tracker                (what the user believes is fixed/pending)
 *   - refusal-safety-router               (allow/caution/route_to_human/refuse)
 *   - faithfulness-postprocessor          (optional, when draftResponse is given)
 *
 * Produces a single, deduped, length-capped system-prompt block plus a
 * structured telemetry object for metrics. Pure heuristic, no LLM, no
 * network. End-to-end cost: ~10–20 ms on a 20-turn thread.
 */

const contextEngine = require('./context-attribution-engine');
const entityTracker = require('./cross-turn-entity-tracker');
const entityUnifier = require('./cross-language-entity-unifier');
const driftMonitor = require('./concept-drift-monitor');
const beliefTracker = require('./belief-state-tracker');
const safetyRouter = require('./refusal-safety-router');
const faithfulnessPostprocessor = require('./faithfulness-postprocessor');

const DEFAULT_BLOCK_BUDGET = Number.parseInt(process.env.SIRAGPT_ATTRIBUTION_SUITE_MAX_CHARS || '6000', 10);

function compose(blocks = [], maxChars = DEFAULT_BLOCK_BUDGET) {
  const joined = blocks
    .map((b) => (typeof b === 'string' ? b.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars - 80).trimEnd()}\n… [attribution suite truncated to fit prompt budget]`;
}

function run({
  userId = null,
  chatId = null,
  turnIndex = 0,
  prompt = '',
  history = [],
  files = [],
  memories = [],
  ragSnippets = [],
  userProfile = null,
  draftResponse = null,
  options = {},
} = {}) {
  const start = Date.now();

  // 1. Safety router — runs first because a refuse verdict short-circuits
  // the rest of the pipeline.
  const safety = safetyRouter.classify({ prompt });
  if (safety.verdict === 'refuse' && options.shortCircuitOnRefuse !== false) {
    return {
      verdict: 'refuse',
      safety,
      systemPromptBlock: safetyRouter.buildSafetyBlock(safety),
      latencyMs: Date.now() - start,
    };
  }

  // 2. Core engine (concepts + graph + plan + hops + suppression).
  const engineBundle = contextEngine.analyze({
    prompt,
    history,
    files,
    memories,
    ragSnippets,
    userProfile,
    draftResponse,
    options,
  });

  // 3. Entity tracker — register and resolve cross-turn references.
  let registered = [];
  if (userId && chatId && prompt) {
    try { registered = entityTracker.register({ userId, chatId, turnIndex, role: 'user', text: prompt }); }
    catch (_e) { registered = []; }
  }

  // 4. Cross-language entity unifier — runs on top of the tracker registry.
  let unifierClusters = [];
  let unifierBlock = '';
  if (userId && chatId) {
    try {
      unifierClusters = entityUnifier.unify({ userId, chatId, limit: 6 });
      unifierBlock = entityUnifier.buildUnifierBlock({ userId, chatId, maxClusters: 6 });
    } catch (_e) { unifierClusters = []; }
  }

  // 5. Drift monitor.
  let driftObs = null;
  let driftBlock = '';
  if (userId && chatId && prompt) {
    try {
      driftObs = driftMonitor.observe({ userId, chatId, turnIndex, prompt });
      driftBlock = driftMonitor.buildDriftBlock(driftObs);
    } catch (_e) { driftObs = null; }
  }

  // 6. Belief tracker.
  let beliefResult = { observed: [], contradicted: [] };
  let beliefBlock = '';
  if (userId && chatId && prompt) {
    try {
      beliefResult = beliefTracker.observe({ userId, chatId, turnIndex, prompt });
      beliefBlock = beliefTracker.buildBeliefBlock({ userId, chatId });
    } catch (_e) { beliefResult = { observed: [], contradicted: [] }; }
  }

  // 7. Optional faithfulness postprocessor (when a draft response is supplied).
  let postprocessed = null;
  if (draftResponse) {
    try {
      const ctx = [
        ...history.map((m) => ({ text: m?.content || m?.text || '' })),
        ...files.map((f) => ({ text: f?.text || f?.summary || f?.name || '' })),
        ...memories.map((m) => ({ text: m?.fact || m?.text || '' })),
        ...ragSnippets.map((s) => ({ text: s?.text || s?.content || '' })),
      ];
      postprocessed = faithfulnessPostprocessor.postprocess({ response: draftResponse, context: ctx, mode: options.faithfulnessMode || 'annotate' });
    } catch (_e) { postprocessed = null; }
  }

  // 8. Compose final system-prompt block.
  const systemPromptBlock = compose(
    [
      safety.verdict !== 'allow' ? safetyRouter.buildSafetyBlock(safety) : '',
      engineBundle.systemPromptBlock,
      beliefBlock,
      driftBlock,
      unifierBlock,
    ],
    options.maxBlockChars || DEFAULT_BLOCK_BUDGET,
  );

  return {
    verdict: safety.verdict,
    safety,
    engine: engineBundle,
    entities: {
      newOrUpdated: registered.length,
      clusters: unifierClusters,
    },
    drift: driftObs,
    beliefs: beliefResult,
    postprocessed,
    systemPromptBlock,
    telemetry: {
      latencyMs: Date.now() - start,
      verdict: safety.verdict,
      primaryIntent: engineBundle.attribution?.summary?.topIntents?.[0]?.text || null,
      conceptCount: engineBundle.concepts?.length || 0,
      multiHopDepth: engineBundle.multiHop?.depth || 0,
      planNodes: engineBundle.plan?.nodes?.length || 0,
      conflicts: engineBundle.suppression?.conflicts?.length || 0,
      entitiesRegistered: registered.length,
      driftClass: driftObs?.classification || 'baseline',
      beliefsObserved: beliefResult.observed?.length || 0,
      beliefsContradicted: beliefResult.contradicted?.length || 0,
      faithfulnessAction: postprocessed?.action || null,
      faithfulnessGrade: postprocessed?.report?.grade || null,
    },
  };
}

module.exports = {
  run,
  compose,
  DEFAULT_BLOCK_BUDGET,
};
