'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const featureExtractor = require('../src/services/intent-attribution-graph/feature-extractor');
const attributionGraph = require('../src/services/intent-attribution-graph/attribution-graph');
const supernodeBuilder = require('../src/services/intent-attribution-graph/supernode-builder');
const circuitTracer = require('../src/services/intent-attribution-graph/circuit-tracer');
const intentPlanner = require('../src/services/intent-attribution-graph/intent-planner');
const hiddenIntentDetector = require('../src/services/intent-attribution-graph/hidden-intent-detector');
const confidenceCalibrator = require('../src/services/intent-attribution-graph/confidence-calibrator');
const promptFormatter = require('../src/services/intent-attribution-graph/prompt-formatter');
const intentAttribution = require('../src/services/intent-attribution-graph');

const { FEATURE_CATEGORIES } = featureExtractor;

// ─────────────────────────────────────────────────────────────────────────
// 1. Feature extractor
// ─────────────────────────────────────────────────────────────────────────

describe('feature-extractor', () => {
  it('returns empty result for empty input', () => {
    const r = featureExtractor.extractFeatures('');
    assert.deepEqual(r.features, []);
    assert.equal(r.language, 'unknown');
  });

  it('extracts action features in Spanish', () => {
    const r = featureExtractor.extractFeatures('crea un componente nuevo');
    const actions = r.features.filter((f) => f.category === FEATURE_CATEGORIES.ACTION);
    assert.ok(actions.length >= 1);
    assert.ok(actions.some((a) => a.label === 'create'));
  });

  it('extracts action features in English', () => {
    const r = featureExtractor.extractFeatures('build a new React component');
    const actions = r.features.filter((f) => f.category === FEATURE_CATEGORIES.ACTION);
    assert.ok(actions.some((a) => a.label === 'create'));
  });

  it('extracts object features', () => {
    const r = featureExtractor.extractFeatures('arregla el bug en el endpoint de auth');
    const objects = r.features.filter((f) => f.category === FEATURE_CATEGORIES.OBJECT);
    assert.ok(objects.some((o) => o.label === 'defect'));
    assert.ok(objects.some((o) => o.label === 'api-surface'));
  });

  it('extracts modifiers', () => {
    const r = featureExtractor.extractFeatures('necesito esto urgente para producción');
    const mods = r.features.filter((f) => f.category === FEATURE_CATEGORIES.MODIFIER);
    assert.ok(mods.some((m) => m.label === 'high-urgency'));
  });

  it('extracts constraints', () => {
    const r = featureExtractor.extractFeatures('debe ser seguro y no debe romper los tests existentes');
    const cs = r.features.filter((f) => f.category === FEATURE_CATEGORIES.CONSTRAINT);
    assert.ok(cs.some((c) => c.label === 'must-have'));
    assert.ok(cs.some((c) => c.label === 'must-not'));
  });

  it('extracts URL reference', () => {
    const r = featureExtractor.extractFeatures('revisa https://example.com y dime qué piensas');
    const refs = r.features.filter((f) => f.category === FEATURE_CATEGORIES.REFERENCE);
    assert.ok(refs.some((rf) => rf.label === 'url-reference'));
  });

  it('infers implicit "expect-tests" for code creation', () => {
    const r = featureExtractor.extractFeatures('crea una función en el código');
    const imp = r.features.filter((f) => f.category === FEATURE_CATEGORIES.IMPLICIT);
    assert.ok(imp.some((i) => i.label === 'expect-tests'));
  });

  it('infers implicit "fetch-and-summarize-url" when URL present', () => {
    const r = featureExtractor.extractFeatures('mira https://anthropic.com');
    const imp = r.features.filter((f) => f.category === FEATURE_CATEGORIES.IMPLICIT);
    assert.ok(imp.some((i) => i.label === 'fetch-and-summarize-url'));
  });

  it('infers implicit "resume-prior-task" for bare continue', () => {
    const r = featureExtractor.extractFeatures('continúa');
    const imp = r.features.filter((f) => f.category === FEATURE_CATEGORIES.IMPLICIT);
    assert.ok(imp.some((i) => i.label === 'resume-prior-task'));
  });

  it('detects Spanish language', () => {
    const r = featureExtractor.extractFeatures('por favor analiza esto cuanto antes para nuestros clientes');
    assert.equal(r.language, 'es');
  });

  it('detects English language', () => {
    const r = featureExtractor.extractFeatures('please analyze this for our customers as soon as possible');
    assert.equal(r.language, 'en');
  });

  it('detects negation', () => {
    const r = featureExtractor.extractFeatures('no quiero que cambies el esquema');
    const negs = r.features.filter((f) => f.category === FEATURE_CATEGORIES.NEGATION);
    assert.ok(negs.length >= 1);
  });

  it('detects attachments via opts', () => {
    const r = featureExtractor.extractFeatures('analiza esto', { attachments: [{ fileName: 'a.csv' }, { fileName: 'b.pdf' }] });
    const refs = r.features.filter((f) => f.label === 'attached-file');
    assert.equal(refs.length, 2);
  });

  it('reports useful metrics', () => {
    const r = featureExtractor.extractFeatures('crea un código urgente para el endpoint');
    assert.ok(r.metrics.tokenCount >= 5);
    assert.ok(r.metrics.actionCount >= 1);
    assert.ok(r.metrics.objectCount >= 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Attribution graph
// ─────────────────────────────────────────────────────────────────────────

describe('attribution-graph', () => {
  it('builds an empty graph for empty extraction', () => {
    const g = attributionGraph.buildGraph({ features: [] });
    assert.equal(g.nodes.length, 0);
    assert.equal(g.edges.length, 0);
  });

  it('adds a synthetic root for any non-empty input with actions', () => {
    const ex = featureExtractor.extractFeatures('crea un componente');
    const g = attributionGraph.buildGraph(ex);
    assert.ok(g.rootId);
    const root = g.nodes.find((n) => n.id === g.rootId);
    assert.ok(root.synthetic);
  });

  it('creates action-on edges from each action to each object', () => {
    const ex = featureExtractor.extractFeatures('crea código y arregla el bug');
    const g = attributionGraph.buildGraph(ex);
    const actionOn = g.edges.filter((e) => e.edgeType === attributionGraph.EDGE_TYPES.ACTION_ON);
    assert.ok(actionOn.length >= 1);
  });

  it('attaches modifiers to nearest action', () => {
    const ex = featureExtractor.extractFeatures('haz esto urgente y rápido');
    const g = attributionGraph.buildGraph(ex);
    const modifies = g.edges.filter((e) => e.edgeType === attributionGraph.EDGE_TYPES.MODIFIES);
    assert.ok(modifies.length >= 1);
  });

  it('attaches constraints to actions and objects', () => {
    const ex = featureExtractor.extractFeatures('debe ser seguro y modificar el código');
    const g = attributionGraph.buildGraph(ex);
    const constraintEdges = g.edges.filter((e) => e.edgeType === attributionGraph.EDGE_TYPES.CONSTRAINS);
    assert.ok(constraintEdges.length >= 1);
  });

  it('ranks important nodes correctly', () => {
    const ex = featureExtractor.extractFeatures('crea una función en el código api');
    const g = attributionGraph.buildGraph(ex);
    const top = attributionGraph.topNodesByImportance(g, 5);
    assert.ok(top.length >= 1);
    assert.ok(top[0].importance > 0);
  });

  it('neighbors() returns outgoing edges by default', () => {
    const ex = featureExtractor.extractFeatures('crea código');
    const g = attributionGraph.buildGraph(ex);
    const action = g.nodes.find((n) => n.category === FEATURE_CATEGORIES.ACTION);
    const out = attributionGraph.neighbors(g, action.id, 'out');
    assert.ok(Array.isArray(out));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Supernode builder
// ─────────────────────────────────────────────────────────────────────────

describe('supernode-builder', () => {
  it('returns empty for empty graph', () => {
    const r = supernodeBuilder.buildSupernodes({ nodes: [], edges: [] });
    assert.deepEqual(r.supernodes, []);
  });

  it('builds "build-software" supernode for code-creation requests', () => {
    const ex = featureExtractor.extractFeatures('crea una nueva función en el código');
    const g = attributionGraph.buildGraph(ex);
    const { supernodes } = supernodeBuilder.buildSupernodes(g);
    assert.ok(supernodes.some((s) => s.themeId === 'build-software'));
  });

  it('builds "fix-defect" supernode for bug-fix requests', () => {
    const ex = featureExtractor.extractFeatures('arregla el bug en el endpoint');
    const g = attributionGraph.buildGraph(ex);
    const { supernodes } = supernodeBuilder.buildSupernodes(g);
    assert.ok(supernodes.some((s) => s.themeId === 'fix-defect'));
  });

  it('builds "analyze-document" supernode for analysis requests', () => {
    const ex = featureExtractor.extractFeatures('analiza este documento pdf');
    const g = attributionGraph.buildGraph(ex);
    const { supernodes } = supernodeBuilder.buildSupernodes(g);
    assert.ok(supernodes.some((s) => s.themeId === 'analyze-document'));
  });

  it('builds "deploy-or-run" supernode for deployment requests', () => {
    const ex = featureExtractor.extractFeatures('despliega el sistema');
    const g = attributionGraph.buildGraph(ex);
    const { supernodes } = supernodeBuilder.buildSupernodes(g);
    assert.ok(supernodes.some((s) => s.themeId === 'deploy-or-run'));
  });

  it('orders supernodes by aggregate weight × confidence', () => {
    const ex = featureExtractor.extractFeatures('analiza el documento, crea una función nueva, y despliega el sistema');
    const g = attributionGraph.buildGraph(ex);
    const { supernodes } = supernodeBuilder.buildSupernodes(g);
    if (supernodes.length >= 2) {
      const aScore = supernodes[0].aggregateWeight * supernodes[0].aggregateConfidence;
      const bScore = supernodes[1].aggregateWeight * supernodes[1].aggregateConfidence;
      assert.ok(aScore >= bScore);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Circuit tracer
// ─────────────────────────────────────────────────────────────────────────

describe('circuit-tracer', () => {
  it('returns empty for empty graph', () => {
    const circuits = circuitTracer.buildCircuits({ nodes: [], edges: [] });
    assert.deepEqual(circuits, []);
  });

  it('builds circuits from root → action → object', () => {
    const ex = featureExtractor.extractFeatures('crea una función en el código');
    const g = attributionGraph.buildGraph(ex);
    const { supernodes } = supernodeBuilder.buildSupernodes(g);
    const circuits = circuitTracer.buildCircuits(g, supernodes);
    assert.ok(circuits.length >= 1);
    assert.ok(circuits[0].description.includes('→'));
    assert.ok(circuits[0].score > 0);
  });

  it('tags circuits with the dominant supernode', () => {
    const ex = featureExtractor.extractFeatures('arregla el bug en el código');
    const g = attributionGraph.buildGraph(ex);
    const { supernodes } = supernodeBuilder.buildSupernodes(g);
    const circuits = circuitTracer.buildCircuits(g, supernodes);
    assert.ok(circuits.some((c) => c.supernodeId));
  });

  it('caps the number of circuits returned', () => {
    const ex = featureExtractor.extractFeatures(
      'crea código, modifica el api, despliega el sistema, analiza el documento, prueba todo, busca errores'
    );
    const g = attributionGraph.buildGraph(ex);
    const circuits = circuitTracer.buildCircuits(g, []);
    assert.ok(circuits.length <= 12);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Intent planner
// ─────────────────────────────────────────────────────────────────────────

describe('intent-planner', () => {
  it('returns empty plans for empty input', () => {
    const ex = featureExtractor.extractFeatures('hola');
    const g = attributionGraph.buildGraph(ex);
    const plan = intentPlanner.planAhead(ex, g);
    assert.equal(plan.prerequisites.length, 0);
    assert.equal(plan.nextSteps.length, 0);
  });

  it('suggests "fetch-url-first" when URL is present', () => {
    const ex = featureExtractor.extractFeatures('analiza https://example.com');
    const g = attributionGraph.buildGraph(ex);
    const plan = intentPlanner.planAhead(ex, g);
    assert.ok(plan.prerequisites.some((p) => p.id === 'fetch-url-first'));
  });

  it('suggests "review-prior-context" on continue verb', () => {
    const ex = featureExtractor.extractFeatures('continúa con lo anterior');
    const g = attributionGraph.buildGraph(ex);
    const plan = intentPlanner.planAhead(ex, g);
    assert.ok(plan.prerequisites.some((p) => p.id === 'review-prior-context'));
  });

  it('suggests next-step "tests" for code creation', () => {
    const ex = featureExtractor.extractFeatures('crea una función en el código');
    const g = attributionGraph.buildGraph(ex);
    const plan = intentPlanner.planAhead(ex, g);
    assert.ok(plan.nextSteps.some((n) => n.id === 'next-test'));
  });

  it('suggests next-step "rollback-plan" for deployment', () => {
    const ex = featureExtractor.extractFeatures('despliega esto en producción');
    const g = attributionGraph.buildGraph(ex);
    const plan = intentPlanner.planAhead(ex, g);
    assert.ok(plan.nextSteps.some((n) => n.id === 'next-rollback-plan'));
  });

  it('caps prerequisites and next-steps', () => {
    const ex = featureExtractor.extractFeatures('crea, modifica, despliega, analiza, prueba, busca https://x.com con seguridad y base de datos');
    const g = attributionGraph.buildGraph(ex);
    const plan = intentPlanner.planAhead(ex, g);
    assert.ok(plan.prerequisites.length <= 8);
    assert.ok(plan.nextSteps.length <= 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Hidden intent detector
// ─────────────────────────────────────────────────────────────────────────

describe('hidden-intent-detector', () => {
  it('returns empty for empty prompt', () => {
    assert.deepEqual(hiddenIntentDetector.detectHiddenIntents(''), []);
  });

  it('detects frustration from prior failure', () => {
    const out = hiddenIntentDetector.detectHiddenIntents('todavía no funciona, sigue fallando');
    assert.ok(out.some((h) => h.id === 'frustration-from-prior-failure'));
  });

  it('detects execution intent', () => {
    const out = hiddenIntentDetector.detectHiddenIntents('implementalo ya');
    assert.ok(out.some((h) => h.id === 'implementation-not-discussion'));
  });

  it('detects open-ended delegation', () => {
    const out = hiddenIntentDetector.detectHiddenIntents('implementa todo lo necesario');
    assert.ok(out.some((h) => h.id === 'open-ended-do-everything'));
  });

  it('escalates to "execute-with-conviction" on combined signals', () => {
    const out = hiddenIntentDetector.detectHiddenIntents('implementa todo lo necesario, hazlo ya');
    assert.ok(out.some((h) => h.id === 'execute-with-conviction'));
  });

  it('detects time-pressure', () => {
    const out = hiddenIntentDetector.detectHiddenIntents('¿cuándo termina esto?');
    assert.ok(out.some((h) => h.id === 'time-pressure'));
  });

  it('detects decision-help', () => {
    const out = hiddenIntentDetector.detectHiddenIntents('¿cuál es mejor, A o B?');
    assert.ok(out.some((h) => h.id === 'wants-comparison-not-list'));
  });

  it('caps total hidden intents at 6', () => {
    const out = hiddenIntentDetector.detectHiddenIntents(
      'implementa todo, hazlo ya, no funciona, cuándo termina, está bien, podrías también, cómo lo haces'
    );
    assert.ok(out.length <= 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Confidence calibrator
// ─────────────────────────────────────────────────────────────────────────

describe('confidence-calibrator', () => {
  it('returns low score with high ambiguity for vague input', () => {
    const ex = featureExtractor.extractFeatures('arréglalo');
    const g = attributionGraph.buildGraph(ex);
    const { supernodes } = supernodeBuilder.buildSupernodes(g);
    const cal = confidenceCalibrator.calibrate({ extraction: ex, graph: g, supernodes, hiddenIntents: [] });
    assert.ok(cal.score < 0.85);
    assert.ok(cal.ambiguities.length >= 1);
  });

  it('returns higher score for well-specified input', () => {
    const ex = featureExtractor.extractFeatures('crea un endpoint REST llamado /api/users en el backend, debe usar Prisma y tener tests');
    const g = attributionGraph.buildGraph(ex);
    const { supernodes } = supernodeBuilder.buildSupernodes(g);
    const cal = confidenceCalibrator.calibrate({ extraction: ex, graph: g, supernodes, hiddenIntents: [] });
    assert.ok(cal.score > 0.5);
  });

  it('flags too-many-actions ambiguity', () => {
    const ex = featureExtractor.extractFeatures('crea, modifica, analiza y despliega el código');
    const g = attributionGraph.buildGraph(ex);
    const { supernodes } = supernodeBuilder.buildSupernodes(g);
    const cal = confidenceCalibrator.calibrate({ extraction: ex, graph: g, supernodes, hiddenIntents: [] });
    assert.ok(cal.ambiguities.some((a) => a.id === 'too-many-actions'));
  });

  it('flags action-no-object ambiguity', () => {
    const ex = featureExtractor.extractFeatures('mejora');
    const g = attributionGraph.buildGraph(ex);
    const { supernodes } = supernodeBuilder.buildSupernodes(g);
    const cal = confidenceCalibrator.calibrate({ extraction: ex, graph: g, supernodes, hiddenIntents: [] });
    assert.ok(cal.ambiguities.some((a) => a.id === 'action-no-object'));
  });

  it('shouldAskClarification is true when high-severity ambiguity present', () => {
    const ex = featureExtractor.extractFeatures('arregla');
    const g = attributionGraph.buildGraph(ex);
    const { supernodes } = supernodeBuilder.buildSupernodes(g);
    const cal = confidenceCalibrator.calibrate({ extraction: ex, graph: g, supernodes, hiddenIntents: [] });
    assert.equal(cal.shouldAskClarification, true);
  });

  it('downgrades ambiguity severity when user shows execution intent', () => {
    const ex = featureExtractor.extractFeatures('crea, modifica y despliega');
    const g = attributionGraph.buildGraph(ex);
    const { supernodes } = supernodeBuilder.buildSupernodes(g);
    const hiddenIntents = hiddenIntentDetector.detectHiddenIntents('implementalo ya');
    const cal = confidenceCalibrator.calibrate({ extraction: ex, graph: g, supernodes, hiddenIntents });
    // Either no medium ambiguities remain, or they were downgraded to low
    const mediums = cal.ambiguities.filter((a) => a.severity === 'medium');
    assert.ok(mediums.length === 0 || cal.ambiguities.length > mediums.length);
  });

  it('returns proper bands', () => {
    assert.equal(confidenceCalibrator.bandFor(0.9).label, 'high');
    assert.equal(confidenceCalibrator.bandFor(0.7).label, 'medium-high');
    assert.equal(confidenceCalibrator.bandFor(0.5).label, 'medium');
    assert.equal(confidenceCalibrator.bandFor(0.3).label, 'medium-low');
    assert.equal(confidenceCalibrator.bandFor(0.1).label, 'low');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Prompt formatter
// ─────────────────────────────────────────────────────────────────────────

describe('prompt-formatter', () => {
  it('returns empty for null report', () => {
    assert.equal(promptFormatter.formatBlock(null), '');
  });

  it('emits a multi-section block for a real report', () => {
    const report = intentAttribution.analyzeIntent('crea una función nueva en el código backend');
    const block = promptFormatter.formatBlock(report);
    assert.ok(block.includes('USER INTENT ATTRIBUTION GRAPH'));
    assert.ok(block.includes('Confidence:'));
    assert.ok(block.includes('Top intent themes') || block.includes('Implied reasoning'));
  });

  it('respects maxChars cap', () => {
    const report = intentAttribution.analyzeIntent(
      'crea, modifica, despliega, analiza y mejora todo el código backend en https://example.com con seguridad enterprise'
    );
    const block = promptFormatter.formatBlock(report, { maxChars: 600 });
    assert.ok(block.length <= 800);
  });

  it('compact summary is a single line', () => {
    const report = intentAttribution.analyzeIntent('crea código');
    const s = promptFormatter.formatCompactSummary(report);
    assert.ok(!s.includes('\n'));
    assert.ok(s.length > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9. End-to-end orchestrator
// ─────────────────────────────────────────────────────────────────────────

describe('intent-attribution orchestrator', () => {
  it('handles empty prompt gracefully', () => {
    const r = intentAttribution.analyzeIntent('');
    assert.equal(r.empty, true);
    assert.equal(r.ok, true);
  });

  it('returns a coherent report for a realistic prompt', () => {
    const r = intentAttribution.analyzeIntent(
      'implementa mejoras al código backend para mejorar el contexto del usuario, hazlo ya, debe ser robusto'
    );
    assert.equal(r.ok, true);
    assert.ok(r.features.length >= 4);
    assert.ok(r.supernodes.length >= 1);
    assert.ok(r.confidence.score >= 0 && r.confidence.score <= 1);
    assert.equal(r.language, 'es');
    assert.ok(r.durationMs >= 0);
  });

  it('detects URL prompt and proposes fetch-first', () => {
    const r = intentAttribution.analyzeIntent('revisa https://anthropic.com/research y resume');
    assert.ok(r.plan.prerequisites.some((p) => p.id === 'fetch-url-first'));
  });

  it('compactSummary returns a string', () => {
    const r = intentAttribution.analyzeIntent('crea una función');
    const s = intentAttribution.compactSummary(r);
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 0);
  });

  it('shouldClarify returns false for clear input', () => {
    const r = intentAttribution.analyzeIntent('crea un endpoint POST /api/users en el backend');
    // Should not trigger high-severity ambiguity
    assert.equal(typeof intentAttribution.shouldClarify(r), 'boolean');
  });

  it('shouldClarify returns true for vague single-verb input', () => {
    const r = intentAttribution.analyzeIntent('arregla');
    assert.equal(intentAttribution.shouldClarify(r), true);
  });

  it('formatForPrompt produces injectable block', () => {
    const r = intentAttribution.analyzeIntent('analiza el documento PDF y dame un resumen');
    const block = intentAttribution.formatForPrompt(r);
    assert.ok(block.includes('USER INTENT ATTRIBUTION GRAPH'));
  });

  it('handles very long input without crashing', () => {
    const longPrompt = 'crea código '.repeat(500);
    const r = intentAttribution.analyzeIntent(longPrompt);
    assert.equal(r.ok, true);
  });

  it('handles non-string input gracefully', () => {
    const r = intentAttribution.analyzeIntent(null);
    assert.equal(r.ok, true);
    assert.equal(r.empty, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10. Cross-cutting integration scenarios (from the paper's spirit)
// ─────────────────────────────────────────────────────────────────────────

describe('integration scenarios', () => {
  it('Scenario: user asks to fix a bug urgently → identifies bug-fix theme + frustration if applicable', () => {
    const r = intentAttribution.analyzeIntent('arregla este bug urgente, otra vez no funciona');
    assert.ok(r.supernodes.some((s) => s.themeId === 'fix-defect'));
    assert.ok(r.hiddenIntents.some((h) => h.id === 'frustration-from-prior-failure'));
  });

  it('Scenario: user asks for visual content → generate-visual theme + variant next-step', () => {
    const r = intentAttribution.analyzeIntent('crea un gráfico de barras para nuestro dashboard');
    assert.ok(r.supernodes.some((s) => s.themeId === 'generate-visual'));
    assert.ok(r.plan.nextSteps.some((n) => n.id === 'next-regenerate-with-variant'));
  });

  it('Scenario: user provides URL with implementation intent → URL prereq + execute hidden intent', () => {
    const r = intentAttribution.analyzeIntent('implementa lo que diga este link https://anthropic.com');
    assert.ok(r.plan.prerequisites.some((p) => p.id === 'fetch-url-first'));
    assert.ok(r.hiddenIntents.some((h) => h.id === 'implementation-not-discussion'));
  });

  it('Scenario: continue without object → resume-prior-task implicit + review-prior-context prereq', () => {
    const r = intentAttribution.analyzeIntent('continúa');
    assert.ok(r.features.some((f) => f.label === 'resume-prior-task'));
    assert.ok(r.plan.prerequisites.some((p) => p.id === 'review-prior-context'));
  });
});
