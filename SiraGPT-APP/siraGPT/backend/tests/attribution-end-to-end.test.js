'use strict';

/**
 * attribution-end-to-end.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Wires the full attribution stack into a single chat-turn scenario and
 * verifies it produces sane, consistent outputs. Each module is exercised
 * with realistic input shapes, and module-to-module compatibility is
 * checked (e.g. anomaly-detector consuming a profile derived from
 * attribution-graph; rollup aggregating telemetry from a debug report).
 *
 * This is a smoke test, not a correctness test — its purpose is to
 * catch the kind of regression where a single module's shape changes
 * and breaks every downstream consumer.
 */

const test = require('node:test');
const assert = require('node:assert');

const conceptExtractor = require('../src/services/concept-extractor');
const supernodeMerger = require('../src/services/attribution-supernode-merger');
const domainCal = require('../src/services/domain-calibration');
const anomaly = require('../src/services/attribution-anomaly-detector');
const rollup = require('../src/services/attribution-rollup-aggregator');
const momentum = require('../src/services/conversational-momentum-tracker');
const saliency = require('../src/services/saliency-decay-tracker');
const nle = require('../src/services/attribution-natural-language-explainer');
const viz = require('../src/services/attribution-graph-visualizer');
const debugReport = require('../src/services/attribution-debug-report');
const replay = require('../src/services/attribution-replay-engine');
const validator = require('../src/services/attribution-config-validator');
const reflection = require('../src/services/self-reflection-loop');
const fuzzer = require('../src/services/attribution-prompt-fuzzer');
const crossModal = require('../src/services/cross-modal-attribution');
const detector = require('../src/services/adversarial-prompt-detector');
const flagger = require('../src/services/ambiguity-flagger');
const cache = require('../src/services/attribution-cache');
const decayPolicy = require('../src/services/feature-decay-policy');
const perf = require('../src/services/attribution-performance-profiler');

test.beforeEach(() => {
  anomaly.__resetForTests();
  rollup.__resetForTests();
  momentum.__resetForTests();
  saliency.__resetForTests();
  cache.__resetForTests();
  perf.__resetForTests();
});

test('e2e: full attribution stack on a real chat turn', async () => {
  const userId = 'e2e-user';
  const chatId = 'e2e-chat';
  const prompt = 'Build me a chart of quarterly revenue and explain the growth drivers.';

  // 1. Concept extraction
  const conceptResult = perf.measure('concepts', () => conceptExtractor.extractConcepts(prompt));
  assert.ok(Array.isArray(conceptResult.concepts) && conceptResult.concepts.length > 0);

  // 2. Domain calibration
  const cal = perf.measure('domain', () => domainCal.getCalibrationFor(prompt));
  assert.ok(cal.domain);
  assert.ok(cal.faithfulnessAcceptThreshold > 0);

  // 3. Supernode merge of the extracted concepts
  const merged = perf.measure('supernodes', () => supernodeMerger.mergeFeatures(
    conceptResult.concepts.map((c) => ({ kind: c.kind, label: c.surface, weight: c.weight })),
  ));
  assert.ok(Array.isArray(merged.supernodes));
  assert.ok(merged.stats.input === conceptResult.concepts.length);

  // 4. Saliency tracker observes the features
  saliency.observe({
    userId, chatId, turnIndex: 0,
    features: conceptResult.concepts.map((c) => ({ kind: c.kind, label: c.surface, weight: c.weight })),
  });
  const saliencyClass = saliency.classify({ userId, chatId });
  assert.ok(saliencyClass.live.length >= 0);

  // 5. Anomaly detector on the profile
  const profile = {
    centroid: { feature: 0.5, intent: 0.3, context: 0.2 },
    dominantIntentKind: 'build',
    featureCount: conceptResult.concepts.length,
    featureKinds: {},
  };
  anomaly.observe({ userId, profile });
  anomaly.observe({ userId, profile });
  anomaly.observe({ userId, profile });
  const anomalyScore = anomaly.score({ userId, profile });
  assert.ok(anomalyScore.samples >= 1);

  // 6. Momentum tracker
  momentum.recordTurn({
    userId, chatId, intentKind: 'build',
    features: conceptResult.concepts.slice(0, 5).map((c) => ({ label: c.surface })),
  });
  momentum.recordTurn({
    userId, chatId, intentKind: 'build',
    features: conceptResult.concepts.slice(0, 5).map((c) => ({ label: c.surface })),
  });
  const momentumReport = momentum.computeMomentum({ userId, chatId });
  assert.ok(['high', 'medium', 'low', 'unknown'].includes(momentumReport.classification));

  // 7. Adversarial detector on prompt
  const adversarial = detector.analyzePrompt(prompt);
  assert.ok(adversarial.verdict === 'safe');

  // 8. Ambiguity flagger
  const ambiguity = flagger.flagAmbiguity({
    subIntents: [
      { verb: 'build', text: 'build chart', effectiveWeight: 0.8 },
      { verb: 'explain', text: 'explain growth', effectiveWeight: 0.7 },
    ],
  });
  assert.ok(['clear', 'preferred', 'borderline', 'ambiguous'].includes(ambiguity.classification));

  // 9. Rollup aggregator records the turn
  rollup.record({
    userId, chatId, turnId: 't0',
    domain: cal.domain,
    primaryIntent: 'build',
    faithfulness: 0.85,
    citationCoverage: 0.6,
    latencyMs: 50,
  });
  const roll = rollup.rollup({ scope: 'user', userId });
  assert.strictEqual(roll.samples, 1);

  // 10. Self-reflection loop on a hypothetical draft
  const verdict = reflection.reflect({
    draft: 'Quarterly revenue grew 12% — drivers were enterprise expansion and new SKUs.',
    faithfulnessScore: { score: 0.85 },
  });
  assert.strictEqual(verdict.accept, true);

  // 11. Cross-modal attribution against an attached file
  const cmaReport = crossModal.attribute({
    regions: [{
      id: 'r1', fileName: 'q3-report.pdf', kind: 'pdf', location: { page: 4 },
      text: 'Q3 revenue grew 12% driven by enterprise expansion.',
    }],
    response: 'Quarterly revenue grew 12% driven by enterprise expansion.',
  });
  assert.ok(cmaReport.citations.length >= 1);
  assert.ok(cmaReport.citations[0].score >= 0.4);

  // 12. Prompt fuzzer generates stable variants
  const variants = fuzzer.generateVariants(prompt, { limit: 4 });
  assert.ok(variants.length >= 2);

  // 13. Graph visualization (with a minimal graph object)
  const graph = {
    nodes: new Map([
      ['i', { id: 'i', type: 'input', text: prompt }],
      ['in', { id: 'in', type: 'intent', text: 'build chart', weight: 0.8 }],
    ]),
    edges: [{ from: 'i', to: 'in', weight: 0.7 }],
  };
  const cytoscape = viz.toCytoscape(graph);
  assert.ok(Array.isArray(cytoscape.nodes) && cytoscape.nodes.length === 2);

  // 14. NL explainer for the user-facing panel
  const explanation = nle.explain({
    primaryIntent: { verb: 'build', object: 'chart' },
    supernodes: merged.supernodes.slice(0, 3),
    citations: cmaReport.citations.slice(0, 2),
    domain: cal.domain,
    confidence: 0.85,
  });
  assert.ok(explanation.brief.length > 0);
  assert.ok(explanation.full.length > 0);

  // 15. Debug report bundles everything
  const dbg = await debugReport.buildDebugReport({ userId, chatId, prompt });
  assert.ok(dbg.markdown.includes('Attribution Debug Report'));
  assert.ok(dbg.sections);

  // 16. Replay verifies a re-run is consistent (using a deterministic runner)
  const snapshot = { prompt, primaryIntent: { text: 'build' }, confidence: 0.85, hopsDepth: 1, language: cal.detected?.evidence ? 'en' : 'en' };
  const replayReport = replay.replay({
    snapshot,
    runnerFn: () => ({ primaryIntent: { text: 'build' }, intentConfidence: 0.85, multiHopDepth: 1, language: 'en' }),
  });
  assert.strictEqual(replayReport.verdict, 'identical');

  // 17. Config validator — defaults should pass
  const config = validator.validate({});
  assert.strictEqual(config.ok, true);

  // 18. Decay policy classification
  const cls = decayPolicy.classifyKind('constraint');
  assert.strictEqual(cls, 'sticky');

  // 19. Perf aggregates after all the measure() calls
  const perfStats = perf.getAggregateStats();
  assert.ok(Array.isArray(perfStats) && perfStats.length >= 3);
});

test('e2e: cache memoization avoids duplicate work', () => {
  const slow = (text) => ({ result: text.toUpperCase() });
  let calls = 0;
  const wrapped = cache.memoize((text) => { calls += 1; return slow(text); });
  const first = wrapped('hello');
  const second = wrapped('hello');
  assert.deepStrictEqual(first, second);
  assert.strictEqual(calls, 1);
  const third = wrapped('world');
  assert.notStrictEqual(third, first);
  assert.strictEqual(calls, 2);
});

test('e2e: snapshot → replay round-trip', () => {
  const snapshot = {
    prompt: 'analyze sales',
    primaryIntent: { text: 'analyze', kind: 'action' },
    confidence: 0.7,
    hopsDepth: 1,
    language: 'en',
  };
  const r = replay.replay({
    snapshot,
    runnerFn: ({ snapshot: snap }) => ({
      primaryIntent: snap.primaryIntent,
      intentConfidence: snap.confidence,
      multiHopDepth: snap.hopsDepth,
      language: snap.language,
    }),
  });
  assert.strictEqual(r.matches, true);
});

test('e2e: domain → calibration → reflection threshold flow', () => {
  const cal = domainCal.getCalibrationFor('Review the contract clause for liability.');
  assert.strictEqual(cal.domain, 'legal');
  const v = reflection.reflect({
    draft: 'A short answer.',
    faithfulnessScore: { score: 0.5 },
    opts: { acceptThreshold: cal.faithfulnessAcceptThreshold, softThreshold: cal.faithfulnessSoftThreshold },
  });
  // legal demands ≥ 0.85 to accept; 0.5 should NOT pass
  assert.strictEqual(v.accept, false);
});
