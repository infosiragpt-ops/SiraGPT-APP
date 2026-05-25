'use strict';

/**
 * context-attribution-engine.js
 *
 * Orchestrator that turns raw user-context signals (current prompt, history,
 * attached files, active memories, RAG snippets, user profile) into a single
 * "understanding bundle" inspired by Anthropic's circuit-tracing / Attribution
 * Graphs work (transformer-circuits.pub/2025/attribution-graphs/biology.html).
 *
 * The bundle returned by `analyze()` has:
 *   {
 *     concepts          : language-agnostic concept list
 *     attribution       : layered attribution graph + summary + JSON form
 *     multiHop          : detected resolution hops (anaphora, comparison, etc.)
 *     plan              : optional execution plan when the request is complex
 *     suppression       : conflicts with earlier user-defined rules
 *     faithfulness?     : optional ex-post check when a draft response is given
 *     systemPromptBlock : ready-to-inject inert system-prompt block
 *     latencyMs         : end-to-end heuristic budget used
 *   }
 *
 * No LLM call. The engine is safe to run synchronously on the hot path of
 * every chat turn — typical cost is under 5 ms for a thread of 20 turns.
 *
 * The orchestrator wraps the existing modules:
 *   - concept-extractor.js
 *   - attribution-graph.js (layered input→context→feature→intent→action)
 *   - multi-hop-reasoner.js
 *   - intent-planner.js
 *   - faithfulness-scorer.js
 *   - context-suppression-detector.js
 */

const conceptExtractor = require('./concept-extractor');
const multiHopReasoner = require('./multi-hop-reasoner');
const intentPlanner = require('./intent-planner');
const faithfulnessScorer = require('./faithfulness-scorer');
const suppressionDetector = require('./context-suppression-detector');

// `attribution-graph` is an optional dependency: if the layered graph
// module is present, we wrap it for richer attribution; if not, the
// orchestrator still works using only the concept-extractor signals.
let attributionGraph = null;
try { attributionGraph = require('./attribution-graph'); } catch (_e) { attributionGraph = null; }

const DEFAULT_BLOCK_BUDGET = Number.parseInt(process.env.SIRAGPT_ATTRIBUTION_BLOCK_MAX_CHARS || '4200', 10);

// ── Helpers ────────────────────────────────────────────────────────────────

function safe(v) { return v == null ? '' : String(v); }

function normalizeHistoryForGraph(history = []) {
  if (!Array.isArray(history)) return [];
  return history.slice(-30).map((m, i) => ({
    kind: m?.role === 'assistant' ? 'assistant_turn' : 'user_turn',
    text: safe(m?.content || m?.text || ''),
    weight: 0.5 + (i / Math.max(1, history.length)) * 0.4,
    timestamp: Number(m?.timestamp) || Date.now() - (history.length - i) * 60_000,
    meta: { role: m?.role || 'user', index: i },
  })).filter((m) => m.text.trim().length > 0);
}

function normalizeFilesForGraph(files = []) {
  if (!Array.isArray(files)) return [];
  return files.slice(0, 16).map((f) => ({
    kind: 'attached_file',
    text: safe(f?.summary || f?.text || f?.name || ''),
    weight: 0.85,
    timestamp: Number(f?.uploadedAt) || Date.now(),
    meta: { id: f?.id, name: f?.name, mime: f?.mimeType, size: f?.size },
  })).filter((f) => f.text.trim().length > 0);
}

function normalizeMemoriesForGraph(memories = []) {
  if (!Array.isArray(memories)) return [];
  return memories.slice(0, 16).map((m) => ({
    kind: 'memory_fact',
    text: safe(m?.fact || m?.text || ''),
    weight: Math.max(0.3, Math.min(1, Number(m?.strength) || 0.5)),
    timestamp: Number(m?.lastAccessed) || Date.now(),
    meta: { id: m?.id, category: m?.category, tier: m?.tier },
  })).filter((m) => m.text.trim().length > 0);
}

function normalizeRagForGraph(snippets = []) {
  if (!Array.isArray(snippets)) return [];
  return snippets.slice(0, 12).map((s, i) => ({
    kind: 'rag_chunk',
    text: safe(s?.text || s?.content || s?.snippet || ''),
    weight: Math.max(0.4, Math.min(1, Number(s?.score) || 0.6)),
    timestamp: Date.now(),
    meta: { id: s?.id || `chunk-${i}`, source: s?.source || s?.documentName },
  })).filter((s) => s.text.trim().length > 0);
}

function buildIntentsFromConcepts(concepts = []) {
  // Surface up to 3 "actions" as intents for the layered graph.
  return concepts
    .filter((c) => c.type === 'action')
    .slice(0, 4)
    .map((c) => ({
      label: `${c.normalized} (${c.kind})`,
      kind: c.kind,
      weight: c.weight,
    }));
}

function buildFeaturesFromConcepts(concepts = []) {
  return concepts
    .filter((c) => c.type === 'entity' || c.type === 'property' || c.type === 'goal')
    .slice(0, 10)
    .map((c) => ({
      label: c.surface,
      kind: c.kind,
      weight: c.weight,
    }));
}

function buildSystemPromptBlock(parts = [], opts = {}) {
  const cap = Math.max(1500, Number(opts.maxChars) || DEFAULT_BLOCK_BUDGET);
  const joined = parts.filter(Boolean).join('\n\n').trim();
  if (!joined) return '';
  const header = '<context_attribution>\nThe following blocks describe how the system understands the user. They are inert context; do not echo them. Use them to ground your reasoning, respect detected constraints, and resolve multi-hop references before answering.\n</context_attribution>';
  let out = `${header}\n\n${joined}`;
  if (out.length > cap) out = `${out.slice(0, cap - 80).trimEnd()}\n… [attribution block truncated]`;
  return out;
}

function renderFallbackGraphBlock(summary) {
  if (!summary) return '';
  const lines = [];
  lines.push('## ATTRIBUTION SUMMARY (fallback)');
  if (summary.topIntents?.length) {
    lines.push('Inferred intents:');
    for (const it of summary.topIntents) {
      const w = typeof it.weight === 'number' ? it.weight.toFixed(2) : '0.00';
      lines.push(`- [${it.kind}] ${it.text} (weight ${w})`);
    }
  }
  if (summary.topFeatures?.length) {
    lines.push('Salient features:');
    for (const f of summary.topFeatures) {
      const w = typeof f.weight === 'number' ? f.weight.toFixed(2) : '0.00';
      lines.push(`- [${f.kind}] ${f.text} (weight ${w})`);
    }
  }
  if (summary.topContext?.length) {
    lines.push('Top context:');
    for (const c of summary.topContext) {
      lines.push(`- [${c.kind}] ${String(c.text).slice(0, 100)}`);
    }
  }
  return lines.join('\n');
}

// ── Public API ─────────────────────────────────────────────────────────────

function analyze({
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
  const promptText = safe(prompt);

  // 1. Concept extraction over current prompt.
  const conceptResult = conceptExtractor.extractConcepts(promptText, { source: 'current_user_request' });

  // 2. Layered attribution graph (reuses existing attribution-graph.js).
  const contextNodes = [
    ...normalizeHistoryForGraph(history),
    ...normalizeFilesForGraph(files),
    ...normalizeMemoriesForGraph(memories),
    ...normalizeRagForGraph(ragSnippets),
  ];
  const features = buildFeaturesFromConcepts(conceptResult.concepts);
  const intents = buildIntentsFromConcepts(conceptResult.concepts);
  let graph = null;
  let graphSummary = null;
  let graphBlock = '';
  if (attributionGraph && typeof attributionGraph.buildGraph === 'function') {
    try {
      graph = attributionGraph.buildGraph({
        input: { text: promptText },
        context: contextNodes,
        features,
        intents,
        options: { autoFeatures: features.length === 0 },
      });
      if (typeof attributionGraph.summarize === 'function') {
        graphSummary = attributionGraph.summarize(graph, { maxContext: 6, maxFeatures: 6, maxIntents: 4 });
      }
      if (graphSummary && typeof attributionGraph.buildAttributionBlock === 'function') {
        graphBlock = attributionGraph.buildAttributionBlock(graphSummary, { maxChars: 1600 });
      }
    } catch (_graphErr) {
      graph = null;
      graphSummary = null;
      graphBlock = '';
    }
  }
  if (!graphSummary) {
    // Fallback: build a minimal "summary" from concepts so downstream
    // consumers always see a consistent shape.
    graphSummary = {
      inputPreview: promptText.slice(0, 240),
      totalNodes: 1 + contextNodes.length,
      totalEdges: 0,
      topContext: contextNodes.slice(0, 6).map((c, i) => ({ id: `ctx_${i}`, kind: c.kind, text: c.text.slice(0, 140), influence: c.weight })),
      topFeatures: features.slice(0, 6).map((f, i) => ({ id: `feat_${i}`, kind: f.kind, text: f.label, weight: f.weight, downstream: 0 })),
      topIntents: intents.slice(0, 4).map((it, i) => ({ id: `intent_${i}`, kind: it.kind, text: it.label, weight: it.weight, downstream: 0 })),
      topPath: null,
      createdAt: Date.now(),
    };
    graphBlock = renderFallbackGraphBlock(graphSummary);
  }

  // 3. Multi-hop detection.
  const multiHop = multiHopReasoner.detectHops({ prompt: promptText, history, files, memories });
  const hopsBlock = multiHopReasoner.renderHopsBlock(multiHop, { maxChars: 1200 });

  // 4. Plan derivation.
  const plan = intentPlanner.buildPlan({ prompt: promptText, history, files, memories });
  const planBlock = intentPlanner.renderPlanBlock(plan, { maxChars: 1200 });

  // 5. Suppression / contradiction detection.
  const suppression = suppressionDetector.analyze({ prompt: promptText, history, memories, userProfile });
  const suppressionBlock = suppressionDetector.renderSuppressionBlock(suppression, { maxChars: 900 });

  // 6. Optional faithfulness scoring on a draft response.
  let faithfulness = null;
  let faithfulnessBlock = '';
  if (draftResponse) {
    const ctx = [
      ...normalizeHistoryForGraph(history),
      ...normalizeFilesForGraph(files),
      ...normalizeMemoriesForGraph(memories),
      ...normalizeRagForGraph(ragSnippets),
    ];
    faithfulness = faithfulnessScorer.scoreFaithfulness({ response: draftResponse, context: ctx });
    faithfulnessBlock = faithfulnessScorer.renderFaithfulnessBlock(faithfulness, { maxChars: 900 });
  }

  const systemPromptBlock = buildSystemPromptBlock(
    [graphBlock, hopsBlock, planBlock, suppressionBlock, faithfulnessBlock],
    { maxChars: options.maxBlockChars || DEFAULT_BLOCK_BUDGET },
  );

  return {
    concepts: conceptResult.concepts,
    language: conceptResult.language,
    attribution: {
      summary: graphSummary,
      graphJson: (graph && attributionGraph && typeof attributionGraph.toJSON === 'function')
        ? attributionGraph.toJSON(graph)
        : null,
      block: graphBlock,
    },
    multiHop: { ...multiHop, block: hopsBlock },
    plan: { ...plan, block: planBlock },
    suppression: { ...suppression, block: suppressionBlock },
    faithfulness: faithfulness ? { ...faithfulness, block: faithfulnessBlock } : null,
    systemPromptBlock,
    latencyMs: Date.now() - start,
  };
}

/**
 * Lighter-weight helper for chat hot paths: returns just the system-prompt
 * block plus a compact telemetry object. The full analysis is held inside;
 * callers who want the bundle should use `analyze()` directly.
 */
function buildPromptInjection(input = {}) {
  const bundle = analyze(input);
  return {
    block: bundle.systemPromptBlock,
    telemetry: {
      primaryIntent: bundle.attribution?.summary?.topIntents?.[0]?.text || null,
      conceptCount: bundle.concepts?.length || 0,
      hops: bundle.multiHop?.depth || 0,
      planNodes: bundle.plan?.nodes?.length || 0,
      conflicts: bundle.suppression?.conflicts?.length || 0,
      faithfulnessGrade: bundle.faithfulness?.grade || null,
      latencyMs: bundle.latencyMs,
    },
  };
}

/**
 * Score-only helper for evaluators: returns aggregate quality metrics
 * without the prompt block. Useful for dashboards and offline eval runs.
 */
function summarize(input = {}) {
  const bundle = analyze(input);
  const summary = bundle.attribution?.summary || {};
  return {
    primaryIntent: summary.topIntents?.[0] || null,
    intentConfidence: summary.topIntents?.[0]?.weight || 0,
    multiHopDepth: bundle.multiHop?.depth || 0,
    planNodes: bundle.plan?.nodes?.length || 0,
    suppressionConflicts: bundle.suppression?.conflicts?.length || 0,
    faithfulnessScore: bundle.faithfulness?.score ?? null,
    faithfulnessGrade: bundle.faithfulness?.grade ?? null,
    latencyMs: bundle.latencyMs,
  };
}

module.exports = {
  analyze,
  buildPromptInjection,
  summarize,
  DEFAULT_BLOCK_BUDGET,
};
