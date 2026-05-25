'use strict';

const test = require('node:test');
const assert = require('node:assert');

const flagger = require('../src/services/ambiguity-flagger');

test('flagAmbiguity: empty / null reports return classification=clear', () => {
  const out = flagger.flagAmbiguity(null);
  assert.strictEqual(out.ambiguous, false);
  assert.strictEqual(out.classification, 'clear');
});

test('flagAmbiguity: large gap → clear', () => {
  const report = {
    subIntents: [
      { verb: 'build', text: 'build chart', effectiveWeight: 0.9 },
      { verb: 'explain', text: 'explain chart', effectiveWeight: 0.3 },
    ],
  };
  const out = flagger.flagAmbiguity(report);
  assert.strictEqual(out.classification, 'clear');
  assert.strictEqual(out.ambiguous, false);
});

test('flagAmbiguity: small gap → ambiguous + clarifying question', () => {
  const report = {
    subIntents: [
      { verb: 'build', text: 'build chart', effectiveWeight: 0.7 },
      { verb: 'explain', text: 'explain chart', effectiveWeight: 0.69 },
    ],
  };
  const out = flagger.flagAmbiguity(report);
  assert.strictEqual(out.ambiguous, true);
  assert.strictEqual(out.classification, 'ambiguous');
  assert.ok(typeof out.suggestedClarifyingQuestion === 'string');
  assert.ok(out.suggestedClarifyingQuestion.length > 0);
});

test('flagAmbiguity: medium gap → borderline', () => {
  const report = {
    subIntents: [
      { verb: 'build', text: 'A', effectiveWeight: 0.75 },
      { verb: 'fix', text: 'B', effectiveWeight: 0.68 },
    ],
  };
  const out = flagger.flagAmbiguity(report);
  assert.strictEqual(out.classification, 'borderline');
  assert.strictEqual(out.ambiguous, true);
});

test('flagAmbiguity: preferred gap → not ambiguous', () => {
  const report = {
    subIntents: [
      { verb: 'build', text: 'A', effectiveWeight: 0.7 },
      { verb: 'fix', text: 'B', effectiveWeight: 0.5 },
    ],
  };
  const out = flagger.flagAmbiguity(report);
  assert.strictEqual(out.classification, 'preferred');
  assert.strictEqual(out.ambiguous, false);
});

test('flagAmbiguity: accepts summary.topIntents shape from engine', () => {
  const report = {
    summary: {
      topIntents: [
        { kind: 'build', text: 'build chart', weight: 0.6 },
        { kind: 'explain', text: 'explain chart', weight: 0.59 },
      ],
    },
  };
  const out = flagger.flagAmbiguity(report);
  assert.strictEqual(out.ambiguous, true);
});

test('flagAmbiguity: detects negation as extra signal', () => {
  const report = {
    subIntents: [
      { verb: 'build', text: 'A', effectiveWeight: 0.9 },
      { verb: 'fix', text: 'B', effectiveWeight: 0.3 },
    ],
  };
  const out = flagger.flagAmbiguity(report, { userText: 'No quiero que cambies nada.' });
  assert.ok(out.reasons.some((r) => r.includes('negation')));
  assert.strictEqual(out.ambiguous, true); // negation alone forces ambiguous
});

test('flagAmbiguity: detects multiple questions in a turn', () => {
  const report = {
    subIntents: [
      { verb: 'explain', text: 'A', effectiveWeight: 0.9 },
      { verb: 'fix', text: 'B', effectiveWeight: 0.3 },
    ],
  };
  const out = flagger.flagAmbiguity(report, { userText: '¿Por qué? ¿Y cómo arreglarlo?' });
  assert.ok(out.reasons.some((r) => r.includes('multiple questions')));
});

test('flagAmbiguity: detects mixed scopes', () => {
  const report = {
    subIntents: [
      { verb: 'build', text: 'A', scope: 'code', effectiveWeight: 0.7 },
      { verb: 'fix', text: 'B', scope: 'ui', effectiveWeight: 0.5 },
    ],
  };
  const out = flagger.flagAmbiguity(report);
  assert.ok(out.reasons.some((r) => r.includes('mixed scopes')));
});

test('buildClarifyingQuestion returns a single-line Spanish question', () => {
  const report = {
    subIntents: [
      { verb: 'build', text: 'a chart', effectiveWeight: 0.7 },
      { verb: 'analyze', text: 'the data', effectiveWeight: 0.65 },
    ],
  };
  const q = flagger.buildClarifyingQuestion(report);
  assert.ok(q.startsWith('¿'));
  assert.ok(q.endsWith(')'));
  assert.ok(q.includes('build'));
  assert.ok(q.includes('analyze'));
});

test('buildClarifyingQuestion returns null with fewer than 2 candidates', () => {
  const q = flagger.buildClarifyingQuestion({ subIntents: [{ verb: 'build', text: 'x', effectiveWeight: 0.8 }] });
  assert.strictEqual(q, null);
});

test('buildAmbiguityBlock returns prompt text for ambiguous reports', () => {
  const out = flagger.flagAmbiguity({
    subIntents: [
      { verb: 'build', text: 'A', effectiveWeight: 0.7 },
      { verb: 'fix', text: 'B', effectiveWeight: 0.7 },
    ],
  });
  const block = flagger.buildAmbiguityBlock(out);
  assert.ok(block.includes('<intent_ambiguity>'));
  assert.ok(block.includes('</intent_ambiguity>'));
  assert.ok(block.includes('Pregunta candidata') || block.includes('Acción sugerida'));
});

test('buildAmbiguityBlock returns empty for clear reports', () => {
  const out = flagger.flagAmbiguity({
    subIntents: [{ verb: 'build', text: 'A', effectiveWeight: 0.95 }, { verb: 'fix', text: 'B', effectiveWeight: 0.1 }],
  });
  assert.strictEqual(flagger.buildAmbiguityBlock(out), '');
});

test('topCandidates: sorts by weight desc', () => {
  const r = {
    subIntents: [
      { verb: 'a', text: 'X', effectiveWeight: 0.4 },
      { verb: 'b', text: 'Y', effectiveWeight: 0.8 },
      { verb: 'c', text: 'Z', effectiveWeight: 0.6 },
    ],
  };
  const candidates = flagger.topCandidates(r);
  assert.deepStrictEqual(candidates.map((c) => c.verb), ['b', 'c', 'a']);
});
