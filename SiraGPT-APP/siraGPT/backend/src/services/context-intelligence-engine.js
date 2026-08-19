'use strict';

/**
 * Context Intelligence Engine
 *
 * Orchestrator that ties the five attribution-inspired modules together
 * into a single call. Inspired by Anthropic's attribution-graphs research
 * (transformer-circuits.pub/2025/attribution-graphs/biology.html), it lets
 * the rest of SiraGPT understand WHY the system interpreted a request a
 * particular way, what is grounded vs invented, and what the user is likely
 * to ask next.
 *
 * Public surface:
 *
 *   analyzeContext(userId, query, context) → full report
 *   buildSystemPromptBlock(report)         → string for system prompt
 *   summariseForLog(report)                → compact telemetry payload
 *
 * Each subsystem is loaded lazily so a circular require never blows up.
 */

const attributionGraph = require('./context-attribution-graph');
const multiHop = require('./multi-hop-intent-reasoner');
const lookahead = require('./lookahead-planner');
const knowledgeBoundary = require('./knowledge-boundary-detector');
const reasoningFaithfulness = require('./reasoning-faithfulness-check');
const entityGrounding = require('./entity-grounding-tracker');
const crossTurn = require('./cross-turn-attribution-chain');
const hiddenGoal = require('./hidden-goal-extractor');
const counterfactual = require('./counterfactual-query-rewriter');

const MAX_PROMPT_BLOCK_CHARS = Number.parseInt(
  process.env.SIRAGPT_CONTEXT_INTELLIGENCE_BLOCK_MAX || '3500',
  10,
);

let activeMemory = null;
function getActiveMemory() {
  if (activeMemory) return activeMemory;
  try {
    activeMemory = require('./active-memory');
  } catch (_e) {
    activeMemory = null;
  }
  return activeMemory;
}

function pullMemoryFacts(userId) {
  if (!userId) return [];
  const mem = getActiveMemory();
  if (!mem || typeof mem.getMemoryContext !== 'function') return [];
  try {
    const ctx = mem.getMemoryContext(userId, { limit: 15 });
    return [...(ctx?.longTermFacts || []), ...(ctx?.shortTermFacts || [])];
  } catch (_e) {
    return [];
  }
}

function normaliseContext(userId, query, context = {}) {
  const normalized = {
    userQuery: String(query || ''),
    documents: Array.isArray(context.documents) ? context.documents : [],
    history: Array.isArray(context.history) ? context.history : [],
    toolResults: Array.isArray(context.toolResults) ? context.toolResults : [],
    webResults: Array.isArray(context.webResults) ? context.webResults : [],
    memoryFacts: Array.isArray(context.memoryFacts) ? context.memoryFacts : [],
    systemPrompt: context.systemPrompt || '',
  };

  if (!normalized.memoryFacts.length && userId) {
    normalized.memoryFacts = pullMemoryFacts(userId);
  }

  return normalized;
}

function safeRun(label, fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: err.message || String(err), label };
  }
}

function analyzeContext(userId, query, context = {}) {
  const startedAt = Date.now();
  const normalized = normaliseContext(userId, query, context);

  const graphRes = safeRun('attribution_graph', () =>
    attributionGraph.buildGraph(query, normalized),
  );
  const multiHopRes = safeRun('multi_hop', () => multiHop.reason(query, normalized));
  const lookaheadRes = safeRun('lookahead', () => lookahead.planNextSteps(query, normalized));
  const knowledgeRes = safeRun('knowledge_boundary', () =>
    knowledgeBoundary.detectBoundaries(query, normalized),
  );

  const reasoningTrace = Array.isArray(context.reasoningTrace) ? context.reasoningTrace : [];
  const faithfulnessRes = reasoningTrace.length
    ? safeRun('faithfulness', () =>
        reasoningFaithfulness.checkFaithfulness(reasoningTrace, normalized),
      )
    : { ok: true, value: null };

  const draftAnswer = context.draftAnswer || '';
  const entityRes = safeRun('entity_grounding', () =>
    entityGrounding.trackEntities(draftAnswer || query, normalized),
  );

  const crossTurnRes = safeRun('cross_turn', () =>
    crossTurn.buildChain(normalized.history, query, {
      maxTurns: context.crossTurnMaxTurns || 10,
      topK: context.crossTurnTopK || 3,
    }),
  );

  const hiddenGoalRes = safeRun('hidden_goal', () => hiddenGoal.extractHiddenGoals(query, normalized));

  let counterfactualRes = { ok: true, value: null };
  if (context.runCounterfactual !== false && (graphRes.value?.primaryIntent || query)) {
    counterfactualRes = safeRun('counterfactual', () =>
      counterfactual.probeRobustness(
        query,
        (q) => {
          const g = attributionGraph.buildGraph(q, normalized);
          return g.primaryIntent
            ? { intent: g.primaryIntent.kind, confidence: g.primaryIntent.weight }
            : { intent: null, confidence: 0 };
        },
        { context: normalized, limit: context.counterfactualLimit || 6 },
      ),
    );
  }

  const elapsedMs = Date.now() - startedAt;

  const report = {
    userId: userId || null,
    elapsedMs,
    attributionGraph: graphRes.value || null,
    multiHop: multiHopRes.value || null,
    lookahead: lookaheadRes.value || null,
    knowledgeBoundary: knowledgeRes.value || null,
    reasoningFaithfulness: faithfulnessRes.value || null,
    entityGrounding: entityRes.value || null,
    crossTurn: crossTurnRes.value || null,
    hiddenGoal: hiddenGoalRes.value || null,
    counterfactual: counterfactualRes.value || null,
    errors: [
      graphRes, multiHopRes, lookaheadRes, knowledgeRes, faithfulnessRes,
      entityRes, crossTurnRes, hiddenGoalRes, counterfactualRes,
    ]
      .filter((r) => !r.ok)
      .map((r) => ({ label: r.label, error: r.error })),
    confidence: computeOverallConfidence({
      graph: graphRes.value,
      multiHop: multiHopRes.value,
      knowledge: knowledgeRes.value,
      faithfulness: faithfulnessRes.value,
      entity: entityRes.value,
      crossTurn: crossTurnRes.value,
      counterfactual: counterfactualRes.value,
    }),
    recommendations: buildRecommendations({
      graph: graphRes.value,
      multiHop: multiHopRes.value,
      lookahead: lookaheadRes.value,
      knowledge: knowledgeRes.value,
      faithfulness: faithfulnessRes.value,
      entity: entityRes.value,
      crossTurn: crossTurnRes.value,
      hiddenGoal: hiddenGoalRes.value,
      counterfactual: counterfactualRes.value,
    }),
  };

  return report;
}

function computeOverallConfidence(parts) {
  let total = 0;
  let n = 0;
  if (parts.graph?.confidence != null) {
    total += parts.graph.confidence;
    n += 1;
  }
  if (parts.knowledge?.riskScore != null) {
    total += 1 - parts.knowledge.riskScore;
    n += 1;
  }
  if (parts.faithfulness?.faithfulness != null) {
    total += parts.faithfulness.faithfulness;
    n += 1;
  }
  if (parts.entity?.groundingRate != null) {
    total += parts.entity.groundingRate;
    n += 1;
  }
  if (parts.multiHop && !parts.multiHop.needsClarification) {
    total += 0.8;
    n += 1;
  } else if (parts.multiHop?.needsClarification) {
    total += 0.45;
    n += 1;
  }
  if (parts.crossTurn) {
    if (parts.crossTurn.needsCorefResolution) total += 0.4;
    else if (parts.crossTurn.hasContinuity) total += 0.85;
    else total += 0.7;
    n += 1;
  }
  if (parts.counterfactual?.robustnessScore != null) {
    total += parts.counterfactual.robustnessScore;
    n += 1;
  }
  if (n === 0) return 0;
  const avg = total / n;
  return Number(Math.max(0, Math.min(1, avg)).toFixed(3));
}

function buildRecommendations(parts) {
  const out = [];

  if (parts.multiHop?.needsClarification) {
    out.push({
      severity: 'medium',
      category: 'clarification',
      message:
        'Request is under-specified or has missing prerequisites. Ask one targeted clarifying question.',
      prerequisites: parts.multiHop.missingPrerequisites || [],
    });
  }

  if (parts.knowledge?.severity === 'high') {
    out.push({
      severity: 'high',
      category: 'grounding',
      message:
        'Several ungrounded claims detected. Either fetch real sources or hedge explicitly before asserting.',
    });
  }

  if (parts.faithfulness?.severity === 'high') {
    out.push({
      severity: 'high',
      category: 'faithfulness',
      message:
        'Stated reasoning does not match available evidence. Remove unsupported steps or re-derive from real evidence.',
    });
  }

  if (parts.entity?.severity === 'high') {
    out.push({
      severity: 'high',
      category: 'entities',
      message:
        'Most named entities lack grounding. They may be hallucinated; verify each before stating as fact.',
    });
  }

  if (parts.lookahead?.nextSteps?.length) {
    out.push({
      severity: 'low',
      category: 'lookahead',
      message: `Likely next user action: ${parts.lookahead.nextSteps[0].label}. Consider offering it proactively.`,
    });
  }

  if (parts.crossTurn?.needsCorefResolution) {
    out.push({
      severity: 'medium',
      category: 'coreference',
      message: `${parts.crossTurn.unresolvedCoreferences.length} unresolved reference(s) in the current turn — ask a disambiguation question before answering.`,
    });
  }

  if (parts.crossTurn?.domainShift) {
    out.push({
      severity: 'low',
      category: 'domain_shift',
      message: parts.crossTurn.domainShift.message,
    });
  }

  if (parts.hiddenGoal?.topCandidate) {
    const top = parts.hiddenGoal.topCandidate;
    out.push({
      severity: parts.hiddenGoal.needsClarification ? 'medium' : 'info',
      category: 'hidden_goal',
      message: `Underlying goal likely "${top.name.replace(/_/g, ' ')}" (confidence ${Math.round(top.score * 100)}%). ${parts.hiddenGoal.needsClarification ? `Consider asking: ${parts.hiddenGoal.clarifyingQuestion}` : ''}`.trim(),
    });
  }

  if (parts.counterfactual && (parts.counterfactual.verdict === 'brittle' || parts.counterfactual.verdict === 'unstable')) {
    out.push({
      severity: 'high',
      category: 'robustness',
      message: `Intent is ${parts.counterfactual.verdict} (${Math.round(parts.counterfactual.robustnessScore * 100)}% of rewrites preserved it). Ask a disambiguation question.`,
    });
  }

  if (parts.graph?.primaryIntent) {
    out.push({
      severity: 'info',
      category: 'intent',
      message: `Primary intent inferred: ${parts.graph.primaryIntent.kind} (confidence ${Math.round(parts.graph.primaryIntent.weight * 100)}%).`,
    });
  }

  return out;
}

function buildSystemPromptBlock(report, opts = {}) {
  if (!report) return '';
  const blocks = [];

  if (report.attributionGraph) {
    const block = attributionGraph.buildAttributionPrompt(report.attributionGraph, {
      limit: opts.attributionLimit || 5,
    });
    if (block) blocks.push(block);
  }

  if (report.multiHop) {
    const block = multiHop.buildMultiHopPrompt(report.multiHop, {
      allowClarification: opts.allowClarification !== false,
    });
    if (block) blocks.push(block);
  }

  if (report.lookahead) {
    const block = lookahead.buildLookaheadPrompt(report.lookahead, {
      proactiveHints: opts.proactiveHints !== false,
    });
    if (block) blocks.push(block);
  }

  if (report.knowledgeBoundary) {
    const block = knowledgeBoundary.buildKnowledgeBoundaryPrompt(report.knowledgeBoundary, {
      limit: opts.boundaryLimit || 5,
    });
    if (block) blocks.push(block);
  }

  if (report.reasoningFaithfulness) {
    const block = reasoningFaithfulness.buildFaithfulnessPrompt(report.reasoningFaithfulness, {
      limit: opts.faithfulnessLimit || 4,
    });
    if (block) blocks.push(block);
  }

  if (report.entityGrounding) {
    const block = entityGrounding.buildEntityGroundingPrompt(report.entityGrounding, {
      limit: opts.entityLimit || 5,
    });
    if (block) blocks.push(block);
  }

  if (report.crossTurn) {
    const block = crossTurn.buildCrossTurnPrompt(report.crossTurn, {
      includeChain: opts.includeCrossTurnChain !== false,
    });
    if (block) blocks.push(block);
  }

  if (report.hiddenGoal) {
    const block = hiddenGoal.buildHiddenGoalPrompt(report.hiddenGoal, {
      allowClarification: opts.allowClarification !== false,
    });
    if (block) blocks.push(block);
  }

  if (report.counterfactual) {
    const block = counterfactual.buildCounterfactualPrompt(report.counterfactual, {
      limit: opts.counterfactualLimit || 3,
    });
    if (block) blocks.push(block);
  }

  if (report.recommendations?.length) {
    const recLines = ['### Context Intelligence Recommendations'];
    for (const rec of report.recommendations.slice(0, opts.recommendationsLimit || 6)) {
      recLines.push(`- [${rec.severity}] (${rec.category}) ${rec.message}`);
    }
    blocks.push(recLines.join('\n'));
  }

  const combined = blocks.join('\n\n');
  if (combined.length > MAX_PROMPT_BLOCK_CHARS) {
    return combined.slice(0, MAX_PROMPT_BLOCK_CHARS - 3) + '...';
  }
  return combined;
}

function summariseForLog(report) {
  if (!report) return null;
  return {
    elapsedMs: report.elapsedMs,
    confidence: report.confidence,
    primaryIntent: report.attributionGraph?.primaryIntent?.kind || null,
    intentConfidence: report.attributionGraph?.confidence || null,
    multiHopCount: report.multiHop?.hops?.length || 0,
    needsClarification: report.multiHop?.needsClarification || false,
    missingPrerequisites: report.multiHop?.missingPrerequisites || [],
    knowledgeBoundary: report.knowledgeBoundary
      ? {
          severity: report.knowledgeBoundary.severity,
          riskScore: report.knowledgeBoundary.riskScore,
          claimsTotal: report.knowledgeBoundary.counts?.total || 0,
          ungrounded: report.knowledgeBoundary.counts?.ungrounded_assertion || 0,
        }
      : null,
    faithfulness: report.reasoningFaithfulness
      ? {
          severity: report.reasoningFaithfulness.severity,
          score: report.reasoningFaithfulness.faithfulness,
          unsupported:
            (report.reasoningFaithfulness.counts?.unsupported_claim || 0) +
            (report.reasoningFaithfulness.counts?.evidence_mismatch || 0),
        }
      : null,
    entityGrounding: report.entityGrounding
      ? {
          severity: report.entityGrounding.severity,
          rate: report.entityGrounding.groundingRate,
          total: report.entityGrounding.counts?.total || 0,
          newlyIntroduced: report.entityGrounding.counts?.newly_introduced || 0,
        }
      : null,
    nextStep: report.lookahead?.nextSteps?.[0]
      ? {
          label: report.lookahead.nextSteps[0].label,
          tool: report.lookahead.nextSteps[0].tool,
          confidence: report.lookahead.nextSteps[0].confidence,
        }
      : null,
    crossTurn: report.crossTurn
      ? {
          hasContinuity: report.crossTurn.hasContinuity,
          needsCorefResolution: report.crossTurn.needsCorefResolution,
          topicDrift: report.crossTurn.topicDrift,
          domainShift: report.crossTurn.domainShift?.message || null,
          unresolvedReferences: (report.crossTurn.unresolvedCoreferences || []).length,
          topInfluence: report.crossTurn.topInfluences?.[0]?.influence ?? null,
        }
      : null,
    hiddenGoal: report.hiddenGoal?.topCandidate
      ? {
          name: report.hiddenGoal.topCandidate.name,
          score: report.hiddenGoal.topCandidate.score,
          needsClarification: report.hiddenGoal.needsClarification,
        }
      : null,
    counterfactual: report.counterfactual
      ? {
          verdict: report.counterfactual.verdict,
          robustnessScore: report.counterfactual.robustnessScore,
          flippedCount: (report.counterfactual.flippedRewrites || []).length,
        }
      : null,
    errors: report.errors,
  };
}

module.exports = {
  analyzeContext,
  buildSystemPromptBlock,
  summariseForLog,
  buildRecommendations,
  computeOverallConfidence,
  MAX_PROMPT_BLOCK_CHARS,
};
