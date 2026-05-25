'use strict';

/**
 * attribution-stack-runner.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single-call orchestrator that runs the full attribution stack for one
 * chat turn and returns a unified bundle. Wraps the older `attribution-
 * suite.js` (concept + graph + multi-hop + plan + suppression +
 * faithfulness) PLUS the round-3 modules:
 *
 *   • concept-extractor + supernode-merger
 *   • intent-attribution-graph
 *   • context-attribution-engine summary
 *   • domain-calibration (per-domain thresholds)
 *   • ambiguity-flagger (when ≥ 2 intents)
 *   • adversarial-prompt-detector
 *   • saliency-decay-tracker (observe + classify)
 *   • attribution-anomaly-detector (observe + score)
 *   • conversational-momentum-tracker (record + compute)
 *   • attribution-snapshot-store (persist)
 *   • attribution-rollup-aggregator (record)
 *   • attribution-recommendation-engine (over the rollup)
 *   • attribution-natural-language-explainer (for UI)
 *   • attribution-performance-profiler (auto-instruments every stage)
 *   • attribution-provenance-stamper (signs the bundle)
 *
 * Every dependency is lazy-loaded and wrapped in safeRun so a missing
 * optional module degrades silently. Returns a structured bundle that
 * downstream consumers (ai.js, /api/attribution-explainer, debug tools)
 * can pick from selectively.
 *
 * Pure JS, no LLM call. Synchronous (most modules are), but tolerates
 * async returns from any individual stage. Hot path < 30 ms typical.
 *
 * Public API:
 *   run({ userId, chatId, turnIndex?, prompt, history?, files?,
 *          memories?, ragSnippets?, response?, opts? })
 *       → Promise<StackBundle>
 */

const perf = (() => { try { return require('./attribution-performance-profiler'); } catch (_) { return null; } })();
const conceptExtractor = (() => { try { return require('./concept-extractor'); } catch (_) { return null; } })();
const supernodeMerger = (() => { try { return require('./attribution-supernode-merger'); } catch (_) { return null; } })();
const contextEngine = (() => { try { return require('./context-attribution-engine'); } catch (_) { return null; } })();
const intentAttributionGraph = (() => { try { return require('./intent-attribution-graph'); } catch (_) { return null; } })();
const domainCal = (() => { try { return require('./domain-calibration'); } catch (_) { return null; } })();
const flagger = (() => { try { return require('./ambiguity-flagger'); } catch (_) { return null; } })();
const adversarial = (() => { try { return require('./adversarial-prompt-detector'); } catch (_) { return null; } })();
const saliency = (() => { try { return require('./saliency-decay-tracker'); } catch (_) { return null; } })();
const anomaly = (() => { try { return require('./attribution-anomaly-detector'); } catch (_) { return null; } })();
const momentum = (() => { try { return require('./conversational-momentum-tracker'); } catch (_) { return null; } })();
const snapshot = (() => { try { return require('./attribution-snapshot-store'); } catch (_) { return null; } })();
const rollup = (() => { try { return require('./attribution-rollup-aggregator'); } catch (_) { return null; } })();
const recommender = (() => { try { return require('./attribution-recommendation-engine'); } catch (_) { return null; } })();
const nle = (() => { try { return require('./attribution-natural-language-explainer'); } catch (_) { return null; } })();
const provenance = (() => { try { return require('./attribution-provenance-stamper'); } catch (_) { return null; } })();

function safeRun(label, fn) {
  try {
    if (perf?.measure) return perf.measure(`stack.${label}`, fn);
    return fn();
  } catch (err) {
    return { __error: err?.message || String(err) };
  }
}

async function safeRunAsync(label, fn) {
  try {
    if (perf?.measure) return await perf.measure(`stack.${label}`, fn);
    return await fn();
  } catch (err) {
    return { __error: err?.message || String(err) };
  }
}

function extractFeaturesForObserve(iagReport) {
  if (!iagReport?.features) return [];
  return iagReport.features.map((f) => ({
    kind: f.category || f.kind || 'feature',
    label: f.label || f.surface || f.value || '',
    weight: f.weight ?? f.confidence ?? 0.5,
  }));
}

async function run({
  userId = null,
  chatId = null,
  turnIndex = 0,
  prompt = '',
  history = [],
  files = [],
  memories = [],
  ragSnippets = [],
  response = null,
  opts = {},
} = {}) {
  if (!prompt || typeof prompt !== 'string') {
    return { ok: false, error: 'prompt required', generatedAt: new Date().toISOString() };
  }
  const t0 = Date.now();
  const result = {
    ok: true,
    generatedAt: new Date().toISOString(),
    userId, chatId, turnIndex,
    promptPreview: prompt.slice(0, 240),
    sections: {},
  };

  // 1. Concept extraction
  if (conceptExtractor?.extractConcepts) {
    result.sections.concepts = safeRun('concepts', () => conceptExtractor.extractConcepts(prompt));
  }

  // 2. Domain calibration
  if (domainCal?.getCalibrationFor) {
    result.sections.domain = safeRun('domain', () => domainCal.getCalibrationFor(prompt));
  }

  // 3. Supernode merge (over extracted concepts)
  if (supernodeMerger?.mergeFeatures && result.sections.concepts?.concepts) {
    const cs = result.sections.concepts.concepts || [];
    result.sections.supernodes = safeRun('supernodes', () => supernodeMerger.mergeFeatures(
      cs.map((c) => ({ kind: c.kind, label: c.surface, weight: c.weight })),
    ));
  }

  // 4. Intent attribution graph
  if (intentAttributionGraph?.analyzeIntent) {
    result.sections.intent = safeRun('intent', () => intentAttributionGraph.analyzeIntent(prompt));
  }

  // 5. Context attribution engine summary
  if (contextEngine?.summarize) {
    result.sections.engine = safeRun('engine', () => contextEngine.summarize({ prompt }));
  }

  // 6. Ambiguity flagger (only fires when we have multiple intent candidates)
  if (flagger?.flagAmbiguity) {
    const iag = result.sections.intent;
    const candidates = (iag && Array.isArray(iag.features) ? iag.features : [])
      .filter((f) => (f.category || '').toLowerCase().startsWith('action'))
      .map((f) => ({
        verb: f.label || f.surface,
        text: f.surface || f.label,
        effectiveWeight: f.weight ?? 0.5,
      }));
    if (candidates.length >= 2) {
      result.sections.ambiguity = safeRun('ambiguity',
        () => flagger.flagAmbiguity({ subIntents: candidates }, { userText: prompt }));
    }
  }

  // 7. Adversarial detector
  if (adversarial?.analyzePrompt) {
    result.sections.adversarial = safeRun('adversarial', () => adversarial.analyzePrompt(prompt));
  }

  // 8. Saliency observe + classify
  if (saliency && userId && chatId) {
    const feats = extractFeaturesForObserve(result.sections.intent);
    if (feats.length > 0) {
      safeRun('saliency.observe', () => saliency.observe({ userId, chatId, turnIndex, features: feats }));
      result.sections.saliency = safeRun('saliency.classify',
        () => saliency.classify({ userId, chatId }));
    }
  }

  // 9. Anomaly observe + score (synthesise a profile from the graph summary)
  if (anomaly && userId) {
    const eng = result.sections.engine;
    const profile = {
      centroid: eng?.centroid || { feature: 0.5, intent: 0.3, context: 0.2 },
      dominantIntentKind: eng?.primaryIntent?.kind || result.sections.intent?.summary?.primaryAction?.label || null,
      featureCount: (result.sections.concepts?.concepts || []).length,
    };
    safeRun('anomaly.observe', () => anomaly.observe({ userId, profile }));
    result.sections.anomaly = safeRun('anomaly.score', () => anomaly.score({ userId, profile }));
  }

  // 10. Momentum tracker
  if (momentum && userId && chatId) {
    safeRun('momentum.record', () => momentum.recordTurn({
      userId, chatId, turnIndex,
      intentKind: result.sections.intent?.summary?.primaryAction?.label || result.sections.engine?.primaryIntent?.kind,
      features: (result.sections.concepts?.concepts || []).slice(0, 8).map((c) => ({ label: c.surface })),
    }));
    result.sections.momentum = safeRun('momentum.compute',
      () => momentum.computeMomentum({ userId, chatId }));
  }

  // 11. Rollup record (for the dashboards)
  if (rollup) {
    safeRun('rollup.record', () => rollup.record({
      userId, chatId, turnId: `t_${turnIndex}_${Date.now().toString(36)}`,
      domain: result.sections.domain?.domain,
      primaryIntent: result.sections.engine?.primaryIntent?.text
        || result.sections.intent?.summary?.primaryAction?.label,
      adversarialVerdict: result.sections.adversarial?.verdict,
    }));
    result.sections.rollupRecent = safeRun('rollup.summary', () => rollup.rollup({ scope: 'user', userId }));
  }

  // 12. Recommendation engine (over the rollup)
  if (recommender?.recommend && result.sections.rollupRecent && !result.sections.rollupRecent.__error) {
    result.sections.recommendations = safeRun('recommend',
      () => recommender.recommend({ rollup: result.sections.rollupRecent }));
  }

  // 13. Snapshot persistence (best-effort)
  if (snapshot?.saveSnapshot && userId && chatId) {
    await safeRunAsync('snapshot', () => snapshot.saveSnapshot({
      userId, chatId, turnId: `t_${turnIndex}_${Date.now().toString(36)}`,
      snapshot: {
        prompt: prompt.slice(0, 1000),
        intent: result.sections.intent?.summary?.primaryAction?.label || null,
        domain: result.sections.domain?.domain || null,
        anomaly: result.sections.anomaly?.score || null,
      },
    }));
  }

  // 14. NL explainer
  if (nle?.explain) {
    result.sections.explanation = safeRun('nl-explainer', () => nle.explain({
      primaryIntent: result.sections.engine?.primaryIntent
        ? { verb: result.sections.engine.primaryIntent.kind || 'act', object: result.sections.engine.primaryIntent.text }
        : null,
      supernodes: (result.sections.supernodes?.supernodes || []).slice(0, 4),
      domain: result.sections.domain?.domain,
      confidence: result.sections.engine?.intentConfidence,
    }));
  }

  // 15. Provenance stamp (over the request + bundle)
  if (provenance?.stamp && opts.stamp !== false) {
    result.sections.provenance = safeRun('provenance', () => provenance.stamp({
      prompt,
      systemBlocks: history,
      response: response || '',
    }));
  }

  result.durationMs = Date.now() - t0;
  return result;
}

module.exports = { run };
