'use strict';

/**
 * Intent Attribution Graph — end-to-end orchestrator.
 *
 * Top-level entry point that ties together feature extraction, graph
 * building, supernode aggregation, multi-step circuit tracing, forward
 * planning, hidden-intent detection, confidence calibration and prompt
 * formatting. Inspired by Anthropic's attribution-graphs research applied
 * to user-intent understanding instead of model-internals.
 *
 * Public surface:
 *   analyzeIntent(prompt, opts) → IntentReport
 *   formatForPrompt(report)     → ready-to-inject system-prompt block
 *   compactSummary(report)      → 1-line debug string
 *   shouldClarify(report)       → bool
 */

const { extractFeatures, FEATURE_CATEGORIES } = require('./feature-extractor');
const { buildGraph, topNodesByImportance, EDGE_TYPES } = require('./attribution-graph');
const { buildSupernodes } = require('./supernode-builder');
const { buildCircuits } = require('./circuit-tracer');
const { planAhead } = require('./intent-planner');
const { detectHiddenIntents } = require('./hidden-intent-detector');
const { calibrate } = require('./confidence-calibrator');
const { formatBlock, formatCompactSummary } = require('./prompt-formatter');
const { analyzeCounterfactuals, formatCounterfactualBlock } = require('./counterfactual-analyzer');
const { validate: validateResponse, formatValidationBlock } = require('./response-validator');
const { trackConversation, formatTrackerBlock } = require('./cross-turn-tracker');

function analyzeIntent(prompt, opts = {}) {
  const startedAt = Date.now();
  const text = (prompt || '').toString();
  if (!text.trim()) {
    return {
      ok: true,
      empty: true,
      prompt: '',
      durationMs: Date.now() - startedAt,
    };
  }

  // 1. Atomic features
  const extraction = extractFeatures(text, opts);

  // 2. Attribution graph
  const graph = buildGraph(extraction);

  // 3. Higher-level supernodes
  const { supernodes, unassigned } = buildSupernodes(graph);

  // 4. Multi-step reasoning circuits
  const circuits = buildCircuits(graph, supernodes);

  // 5. Hidden intent
  const hiddenIntents = detectHiddenIntents(text, opts);

  // 6. Forward planning
  const plan = planAhead(extraction, graph);

  // 7. Confidence calibration
  const confidence = calibrate({ extraction, graph, supernodes, hiddenIntents });

  // 8. Importance ranking (top features)
  const topFeatures = topNodesByImportance(graph, 10);

  const durationMs = Date.now() - startedAt;

  return {
    ok: true,
    empty: false,
    prompt: text.slice(0, 4000),
    language: extraction.language,
    metrics: extraction.metrics,
    features: extraction.features,
    graph: {
      nodeCount: graph.stats.nodeCount,
      edgeCount: graph.stats.edgeCount,
      avgOutdegree: graph.stats.avgOutdegree,
      rootId: graph.rootId,
      // edges are exposed for downstream callers that want to render the graph
      edges: graph.edges,
    },
    topFeatures,
    supernodes,
    unassignedFeatureIds: unassigned.map((u) => u.id),
    circuits,
    plan,
    hiddenIntents,
    confidence,
    stats: {
      featureCount: extraction.features.length,
      supernodeCount: supernodes.length,
      circuitCount: circuits.length,
      edgeCount: graph.stats.edgeCount,
      hiddenIntentCount: hiddenIntents.length,
      language: extraction.language,
    },
    durationMs,
  };
}

function formatForPrompt(report, opts = {}) {
  let block = formatBlock(report, opts);
  // Append optional sub-blocks if upstream caller asked for them
  if (opts.includeCounterfactuals && report?.counterfactuals) {
    const cf = formatCounterfactualBlock(report.counterfactuals);
    if (cf) block = `${block}\n\n${cf}`;
  }
  if (opts.includeTrajectory && report?.trajectory) {
    const tb = formatTrackerBlock(report.trajectory);
    if (tb) block = `${block}\n\n${tb}`;
  }
  return block;
}

function compactSummary(report) {
  return formatCompactSummary(report);
}

function shouldClarify(report) {
  if (!report?.confidence) return false;
  if (report.confidence.shouldAskClarification === true) return true;
  if (report?.counterfactuals?.recommendation === 'high-divergence-ask-clarification') return true;
  return false;
}

/**
 * Full-pipeline analyzer with counterfactuals and (optional) prior-turn
 * trajectory tracking. Use this when you have conversational history
 * and want the richest possible intent report.
 *
 * opts.history — array of prior IntentReports (most recent last)
 * opts.attachments — list of files attached to the current prompt
 */
function analyzeIntentFull(prompt, opts = {}) {
  const baseReport = analyzeIntent(prompt, opts);
  if (baseReport.empty) return baseReport;
  baseReport.counterfactuals = analyzeCounterfactuals(baseReport);
  if (Array.isArray(opts.history) && opts.history.length) {
    baseReport.trajectory = trackConversation(opts.history, baseReport, prompt);
  }
  return baseReport;
}

module.exports = {
  analyzeIntent,
  analyzeIntentFull,
  formatForPrompt,
  compactSummary,
  shouldClarify,
  // Phase 2 utilities exported for direct use
  analyzeCounterfactuals,
  formatCounterfactualBlock,
  validateResponse,
  formatValidationBlock,
  trackConversation,
  formatTrackerBlock,
  // Constants
  FEATURE_CATEGORIES,
  EDGE_TYPES,
};
