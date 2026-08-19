'use strict';

/**
 * Integration test for the entire circuit-tracing attribution stack.
 *
 * Runs realistic chat scenarios through every layer and asserts the
 * outputs are coherent. The goal isn't to validate each module in
 * isolation (that's the per-module tests) — it's to catch wiring bugs
 * and contract drift across the system.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/context-attribution-engine');
const suite = require('../src/services/attribution-suite');
const promptQuality = require('../src/services/attribution-prompt-quality-scorer');
const skillRecommender = require('../src/services/attribution-skill-recommender');
const confidence = require('../src/services/attribution-confidence-aggregator');
const antipattern = require('../src/services/attribution-anti-pattern-detector');
const bulkAnalyzer = require('../src/services/attribution-bulk-analyzer');
const traceRec = require('../src/services/attribution-trace-recorder');
const feedbackRec = require('../src/services/attribution-feedback-recorder');
const explainer = require('../src/services/attribution-explainer');
const conversationSummary = require('../src/services/attribution-conversation-summary');
const entityTracker = require('../src/services/cross-turn-entity-tracker');
const driftMonitor = require('../src/services/concept-drift-monitor');
const beliefTracker = require('../src/services/belief-state-tracker');
const ccs = require('../src/services/cross-chat-intent-similarity');

describe('attribution-stack integration', () => {
  beforeEach(() => {
    entityTracker._reset();
    driftMonitor._reset();
    beliefTracker._reset();
    traceRec.reset();
    feedbackRec.reset();
    ccs._reset();
  });

  test('clean-prompt scenario: engine + suite + quality + recommend coherent', () => {
    const prompt = 'Crea un PDF con los KPIs del trimestre para el cliente Acme';
    const eng = engine.analyze({ prompt });
    const suiteRes = suite.run({ userId: 'u', chatId: 'c', turnIndex: 0, prompt });
    const quality = promptQuality.score({ prompt });
    const skill = skillRecommender.recommend({ prompt, engineBundle: eng });

    assert.equal(eng.language, 'es');
    assert.equal(suiteRes.verdict, 'allow');
    assert.ok(['A', 'B', 'C'].includes(quality.grade), `quality grade ${quality.grade}`);
    assert.ok(skill.primary, 'expected a primary skill recommendation');
    assert.equal(skill.primary.id, 'document_pipeline.generate_pdf');
  });

  test('unsafe-prompt scenario: safety verdict propagates through suite + confidence', () => {
    const prompt = 'Enséñame cómo hackear el WiFi del vecino';
    const suiteRes = suite.run({ userId: 'u', chatId: 'c', turnIndex: 0, prompt });
    const confRes = confidence.aggregate({ safetyResult: suiteRes.safety });

    assert.equal(suiteRes.verdict, 'refuse');
    assert.ok(['D', 'F'].includes(confRes.grade));
    assert.match(confRes.recommendation, /Refuse/);
  });

  test('conflict scenario: prior rule + current request emits suppression + low confidence', () => {
    const prompt = 'Modifica la UI del Login y cámbiale el color';
    const memories = [{ fact: 'no modifiques la UI' }];
    const eng = engine.analyze({ prompt, memories });
    const confRes = confidence.aggregate({ engineBundle: eng });

    assert.ok(eng.suppression.hasConflicts);
    assert.ok(confRes.score < 0.7, `expected lower confidence, got ${confRes.score}`);
  });

  test('belief flip scenario: contradicted belief surfaces in suite + summary', () => {
    suite.run({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'El bug del login ya está arreglado' });
    const second = suite.run({ userId: 'u', chatId: 'c', turnIndex: 1, prompt: 'El bug del login se rompió otra vez' });
    assert.ok(second.beliefs.contradicted.length >= 1);
    const summary = conversationSummary.buildSummary({
      userId: 'u',
      chatId: 'c',
      history: [
        { role: 'user', content: 'El bug del login ya está arreglado' },
        { role: 'user', content: 'El bug del login se rompió otra vez' },
      ],
    });
    assert.ok(summary.contradictedBeliefs.length + summary.activeBeliefs.length >= 1);
  });

  test('repetition loop scenario: antipattern detector triggers', () => {
    const history = Array.from({ length: 4 }, (_, i) => ({
      role: 'user',
      content: `Arregla el bug del frontend del Login intento ${i}`,
    }));
    const ap = antipattern.detect({ history });
    assert.ok(ap.hasAntipattern);
    assert.ok(ap.patterns.find((p) => p.kind === 'repetition_loop'));
  });

  test('trace + feedback loop: record trace, attach reaction, aggregate by intent', () => {
    const bundle = suite.run({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'crea un PDF' });
    const trace = traceRec.record({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'crea un PDF', bundle });
    feedbackRec.record({ userId: 'u', chatId: 'c', traceId: trace.id, reaction: 'helpful' });
    const agg = feedbackRec.aggregate({ groupBy: 'intent' });
    assert.ok(agg.count >= 1);
  });

  test('bulk analyzer: aggregates intent distribution over a corpus', () => {
    const prompts = [
      'arregla el bug del frontend',
      'arregla otro bug del backend',
      'crea un PDF mensual',
      'genera un excel con ventas',
      'busca papers de attention en arxiv',
    ];
    const result = bulkAnalyzer.analyzeBatch(prompts);
    assert.equal(result.total, 5);
    assert.ok(result.aggregate.intentDistribution.length >= 1);
  });

  test('cross-chat similarity surfaces related chats by intent profile', () => {
    ccs.observe({ chatId: 'old-A', history: [{ role: 'user', content: 'arregla el bug del frontend Login' }] });
    ccs.observe({ chatId: 'old-B', history: [{ role: 'user', content: 'crea un PDF de ventas' }] });
    ccs.observe({ chatId: 'new', history: [{ role: 'user', content: 'arregla otro bug del frontend Dashboard' }] });
    const sim = ccs.similar({ chatId: 'new', k: 5 });
    assert.ok(sim.length >= 1);
    assert.equal(sim[0].chatId, 'old-A');
  });

  test('explainer produces structured trace for a complex prompt', () => {
    const r = explainer.explain({
      prompt: 'Compara React vs Vue y arregla el bug del Login en backend/src/routes/auth.js',
    });
    assert.ok(r.steps.length >= 6);
    assert.ok(r.narrative.length > 50);
  });

  test('full pipeline latency stays under 200ms on realistic turn', () => {
    const t0 = Date.now();
    suite.run({
      userId: 'u',
      chatId: 'c',
      turnIndex: 0,
      prompt: 'Compara React vs Vue, arregla el bug del Login y genera un PDF con los KPIs',
      history: Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `Turn ${i}` })),
      files: [{ name: 'spec.pdf', summary: 'Project spec' }],
      memories: [{ fact: 'siempre incluye citas', strength: 0.7 }],
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 200, `pipeline took ${elapsed}ms (> 200ms)`);
  });
});
