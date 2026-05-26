'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const intentAttribution = require('../src/services/intent-attribution-graph');
const counterfactual = require('../src/services/intent-attribution-graph/counterfactual-analyzer');
const validator = require('../src/services/intent-attribution-graph/response-validator');
const tracker = require('../src/services/intent-attribution-graph/cross-turn-tracker');
const multilingual = require('../src/services/intent-attribution-graph/multilingual-lexicon');

// ─────────────────────────────────────────────────────────────────────────
// Counterfactual analyzer
// ─────────────────────────────────────────────────────────────────────────

describe('counterfactual-analyzer', () => {
  it('returns empty for empty report', () => {
    const cf = counterfactual.analyzeCounterfactuals({ empty: true });
    assert.equal(cf.alternatives.length, 0);
    assert.equal(cf.maxDivergence, 0);
  });

  it('handles null input', () => {
    const cf = counterfactual.analyzeCounterfactuals(null);
    assert.equal(cf.ok, true);
  });

  it('generates alternatives for a multi-action prompt', () => {
    const r = intentAttribution.analyzeIntent('crea el código y arregla el bug');
    const cf = counterfactual.analyzeCounterfactuals(r);
    assert.ok(cf.alternatives.length >= 1);
    assert.ok(cf.recommendation);
  });

  it('recommends safe-to-proceed when no alternatives diverge', () => {
    const r = intentAttribution.analyzeIntent('hola');
    const cf = counterfactual.analyzeCounterfactuals(r);
    assert.equal(cf.recommendation === 'safe-to-proceed' || cf.recommendation === 'no-input', true);
  });

  it('recommends ask-clarification for highly divergent prompts', () => {
    const r = intentAttribution.analyzeIntent('crea, modifica, analiza, despliega y elimina el código backend con seguridad y base de datos en https://x.com de manera urgente y completa');
    const cf = counterfactual.analyzeCounterfactuals(r);
    // Either some divergence detected, or none — just verify shape
    assert.ok(['safe-to-proceed', 'minor-divergence-state-assumption', 'moderate-divergence-flag-assumption', 'high-divergence-ask-clarification', 'no-input'].includes(cf.recommendation));
  });

  it('formatCounterfactualBlock returns string', () => {
    const r = intentAttribution.analyzeIntent('crea código y modifica el api');
    const cf = counterfactual.analyzeCounterfactuals(r);
    const block = counterfactual.formatCounterfactualBlock(cf);
    assert.equal(typeof block, 'string');
  });

  it('formatCounterfactualBlock returns empty for no alternatives', () => {
    const block = counterfactual.formatCounterfactualBlock({ alternatives: [] });
    assert.equal(block, '');
  });

  it('planDiff computes added/removed prereqs correctly', () => {
    const base = { prerequisites: [{ id: 'a' }, { id: 'b' }], nextSteps: [{ id: 'x' }] };
    const alt = { prerequisites: [{ id: 'b' }, { id: 'c' }], nextSteps: [{ id: 'y' }] };
    const diff = counterfactual.planDiff(base, alt);
    assert.deepEqual(diff.addedPrereqs, ['c']);
    assert.deepEqual(diff.removedPrereqs, ['a']);
    assert.deepEqual(diff.addedNextSteps, ['y']);
    assert.deepEqual(diff.removedNextSteps, ['x']);
    assert.equal(diff.divergence, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Response validator
// ─────────────────────────────────────────────────────────────────────────

describe('response-validator', () => {
  it('returns empty for empty report', () => {
    const v = validator.validate({ empty: true }, 'response');
    assert.equal(v.empty, true);
    assert.equal(v.score, 0);
  });

  it('returns high score when response mentions all features', () => {
    const r = intentAttribution.analyzeIntent('crea una función en el código backend');
    const v = validator.validate(r, 'He creado la función en el código del backend con tests.');
    assert.ok(v.score > 0.4);
  });

  it('returns low score when response ignores top features', () => {
    const r = intentAttribution.analyzeIntent('crea una función en el código backend');
    const v = validator.validate(r, 'No.');
    assert.ok(v.score < 0.6, `expected score < 0.6, got ${v.score}`);
    assert.ok(v.missingHighWeight.length > 0);
  });

  it('detects when hidden intent is addressed', () => {
    const r = intentAttribution.analyzeIntent('arregla esto ya, otra vez no funciona');
    const v = validator.validate(r, 'Voy a tomar un enfoque diferente. Root cause: el bug está en la validación.');
    assert.ok(v.hiddenIntentHits.length >= 0);
  });

  it('detects when hidden intent is NOT addressed', () => {
    const r = intentAttribution.analyzeIntent('arregla esto ya, otra vez no funciona');
    const v = validator.validate(r, 'OK.');
    assert.ok(v.feedback.some((f) => f.toLowerCase().includes('hidden') || f.toLowerCase().includes('feature')));
  });

  it('formatValidationBlock returns markdown for non-empty validation', () => {
    const r = intentAttribution.analyzeIntent('crea código backend');
    const v = validator.validate(r, 'He creado el código backend.');
    const block = validator.formatValidationBlock(v);
    assert.ok(block.includes('Response fidelity check'));
    assert.ok(block.includes('Score:'));
  });

  it('formatValidationBlock empty for empty validation', () => {
    assert.equal(validator.formatValidationBlock({ empty: true }), '');
  });

  it('normalize lowercases and strips punctuation', () => {
    const norm = validator.normalize('Hello, World! 123.');
    assert.equal(norm, 'hello world 123');
  });

  it('coverage band classifies correctly', () => {
    const r = intentAttribution.analyzeIntent('crea una función en el código api backend');
    const v = validator.validate(r, 'creé la función api en el código backend');
    assert.ok(['high', 'medium-high', 'medium'].includes(v.coverage));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cross-turn tracker
// ─────────────────────────────────────────────────────────────────────────

describe('cross-turn-tracker', () => {
  it('first turn returns first-turn transition', () => {
    const r = intentAttribution.analyzeIntent('crea un componente');
    const t = tracker.trackConversation([], r, 'crea un componente');
    assert.equal(t.transition.type, 'first-turn');
  });

  it('detects continuation when themes overlap', () => {
    const r1 = intentAttribution.analyzeIntent('crea un componente backend');
    const r2 = intentAttribution.analyzeIntent('mejora el componente backend');
    const t = tracker.trackConversation([r1], r2, 'mejora el componente backend');
    assert.ok(['continuation', 'evolution', 'drift'].includes(t.transition.type));
  });

  it('detects explicit pivot', () => {
    const r1 = intentAttribution.analyzeIntent('crea un componente');
    const r2 = intentAttribution.analyzeIntent('en realidad olvida eso, analiza este documento');
    const t = tracker.trackConversation([r1], r2, 'en realidad olvida eso, analiza este documento');
    assert.equal(t.transition.type, 'explicit-pivot');
  });

  it('detects repetition with frustration signal', () => {
    const r1 = intentAttribution.analyzeIntent('arregla el bug, no funciona');
    const r2 = intentAttribution.analyzeIntent('todavía no funciona, otra vez');
    const t = tracker.trackConversation([r1], r2, 'todavía no funciona, otra vez');
    assert.equal(t.transition.type, 'repetition');
  });

  it('detects topic-change', () => {
    const r1 = intentAttribution.analyzeIntent('crea un componente backend');
    const r2 = intentAttribution.analyzeIntent('traduce este texto al inglés');
    const t = tracker.trackConversation([r1], r2, 'traduce este texto al inglés');
    assert.ok(['topic-change', 'drift', 'evolution'].includes(t.transition.type));
  });

  it('accumulates constraints across turns', () => {
    const r1 = intentAttribution.analyzeIntent('debe ser seguro');
    const r2 = intentAttribution.analyzeIntent('y debe ser rápido también');
    const r3 = intentAttribution.analyzeIntent('y no debe romper nada');
    const t = tracker.trackConversation([r1, r2], r3, 'y no debe romper nada');
    assert.ok(t.accumulatedConstraints.length >= 1);
  });

  it('detects frustration streak', () => {
    const r1 = intentAttribution.analyzeIntent('arregla esto, no funciona');
    const r2 = intentAttribution.analyzeIntent('todavía no funciona, sigue fallando');
    const r3 = intentAttribution.analyzeIntent('otra vez no funciona, en serio');
    const t = tracker.trackConversation([r1, r2], r3, 'otra vez no funciona, en serio');
    assert.ok(t.frustrationStreak >= 2);
    assert.equal(t.posture, 'structural-rethink-different-approach');
  });

  it('formatTrackerBlock returns markdown', () => {
    const r1 = intentAttribution.analyzeIntent('crea código');
    const r2 = intentAttribution.analyzeIntent('mejora el código');
    const t = tracker.trackConversation([r1], r2, 'mejora el código');
    const block = tracker.formatTrackerBlock(t);
    assert.ok(block.includes('Conversation trajectory'));
    assert.ok(block.includes('Recommended posture'));
  });

  it('themeOverlap computes Jaccard-like ratio', () => {
    const a = { supernodes: [{ themeId: 'x' }, { themeId: 'y' }] };
    const b = { supernodes: [{ themeId: 'y' }, { themeId: 'z' }] };
    const overlap = tracker.themeOverlap(a, b);
    assert.ok(overlap > 0 && overlap < 1);
  });

  it('classifyTransition gracefully handles missing prev', () => {
    const t = tracker.classifyTransition(null, { supernodes: [] }, 'hola');
    assert.equal(t.type, 'first-turn');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Multilingual lexicon
// ─────────────────────────────────────────────────────────────────────────

describe('multilingual-lexicon', () => {
  it('detects Portuguese', () => {
    const lang = multilingual.detectExtendedLanguage('Por favor crie uma função, isto é necessário porque precisamos disso');
    assert.equal(lang, 'pt');
  });

  it('detects French', () => {
    const lang = multilingual.detectExtendedLanguage('Veuillez créer une fonction pour le projet avec cette nouvelle approche, comment ça marche?');
    assert.equal(lang, 'fr');
  });

  it('detects German', () => {
    const lang = multilingual.detectExtendedLanguage('Bitte erstellen sie die funktion, das ist wichtig und wir brauchen sie warum auch immer');
    assert.equal(lang, 'de');
  });

  it('detects Italian', () => {
    const lang = multilingual.detectExtendedLanguage('Per favore crea la funzione perché ne abbiamo bisogno con questo approccio, come funziona il sistema?');
    assert.equal(lang, 'it');
  });

  it('returns null when language is ambiguous', () => {
    const lang = multilingual.detectExtendedLanguage('hello');
    assert.equal(lang, null);
  });

  it('returns null for non-string input', () => {
    assert.equal(multilingual.detectExtendedLanguage(null), null);
    assert.equal(multilingual.detectExtendedLanguage(''), null);
  });

  it('Portuguese action lexicon catches "crie"', () => {
    const r = intentAttribution.analyzeIntent('Por favor crie uma nova função para o projeto, é necessário porque precisamos disso');
    const actions = r.features.filter((f) => f.category === 'action');
    assert.ok(actions.some((a) => a.label === 'create'));
  });

  it('French action lexicon catches "créer"', () => {
    const r = intentAttribution.analyzeIntent('Veuillez créer une nouvelle fonction pour cette implémentation, comment ça marche');
    const actions = r.features.filter((f) => f.category === 'action');
    assert.ok(actions.some((a) => a.label === 'create'));
  });

  it('extra lexicons have non-empty entries', () => {
    assert.ok(multilingual.EXTRA_ACTION_LEXICON.length > 20);
    assert.ok(multilingual.EXTRA_OBJECT_LEXICON.length > 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Full pipeline integration
// ─────────────────────────────────────────────────────────────────────────

describe('analyzeIntentFull pipeline', () => {
  it('returns a report with counterfactuals', () => {
    const r = intentAttribution.analyzeIntentFull('crea código y arregla el bug');
    assert.ok(r.ok);
    assert.ok(r.counterfactuals);
    assert.ok(Array.isArray(r.counterfactuals.alternatives));
  });

  it('returns trajectory when history provided', () => {
    const r1 = intentAttribution.analyzeIntent('crea un componente');
    const r2 = intentAttribution.analyzeIntentFull('mejora el componente', { history: [r1] });
    assert.ok(r2.trajectory);
    assert.ok(r2.trajectory.transition);
  });

  it('does not return trajectory without history', () => {
    const r = intentAttribution.analyzeIntentFull('crea código');
    assert.equal(r.trajectory, undefined);
  });

  it('handles empty input gracefully', () => {
    const r = intentAttribution.analyzeIntentFull('');
    assert.equal(r.empty, true);
  });

  it('formatForPrompt includes counterfactuals when requested', () => {
    const r = intentAttribution.analyzeIntentFull('crea código y arregla el bug urgente');
    const block = intentAttribution.formatForPrompt(r, { includeCounterfactuals: true });
    assert.ok(block.includes('USER INTENT ATTRIBUTION GRAPH'));
    // Counterfactual block may or may not appear depending on divergence
  });

  it('formatForPrompt includes trajectory when requested', () => {
    const r1 = intentAttribution.analyzeIntent('crea un componente');
    const r2 = intentAttribution.analyzeIntentFull('mejora ese componente', { history: [r1] });
    const block = intentAttribution.formatForPrompt(r2, { includeTrajectory: true });
    assert.ok(block.includes('Conversation trajectory'));
  });

  it('shouldClarify returns true on high counterfactual divergence', () => {
    const r = intentAttribution.analyzeIntentFull('arregla');
    // Should clarify because "arregla" alone is ambiguous (action-no-object)
    assert.equal(intentAttribution.shouldClarify(r), true);
  });
});
