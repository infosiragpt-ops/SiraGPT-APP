'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ex = require('../src/services/attribution-explainer');

describe('attribution-explainer', () => {
  test('explain returns 6 steps for a normal prompt', () => {
    const r = ex.explain({ prompt: 'Crea un PDF y un Excel con los KPIs' });
    assert.equal(r.steps.length, 6);
    assert.ok(r.steps[0].kind === 'language_detection');
    assert.ok(r.steps[r.steps.length - 1].kind === 'suppression');
  });

  test('explain adds a faithfulness step when draftResponse provided', () => {
    const r = ex.explain({
      prompt: '¿Cuál es la cifra?',
      ragSnippets: [{ text: 'Revenue 1234 USD' }],
      draftResponse: 'Revenue was 1234 USD.',
    });
    assert.ok(r.steps.some((s) => s.kind === 'faithfulness'));
  });

  test('explain narrative is non-empty markdown', () => {
    const r = ex.explain({ prompt: 'Modifica la UI del Login' });
    assert.ok(r.narrative.includes('###'));
    assert.ok(r.narrative.length > 100);
  });

  test('explain summary mirrors top-level metrics', () => {
    const r = ex.explain({ prompt: 'Compara A vs B y arregla el bug' });
    assert.equal(r.summary.language, r.bundle.language);
    assert.equal(r.summary.conceptCount, r.bundle.concepts.length);
    assert.ok(typeof r.summary.latencyMs === 'number');
  });

  test('explainConcept finds matching concept', () => {
    const r = ex.explainConcept({
      prompt: 'arregla el bug en backend/src/routes/ai.js',
      conceptSurface: 'ai.js',
    });
    assert.equal(r.found, true);
    assert.ok(r.matches.length >= 1);
  });

  test('explainConcept reports not found for nonsense surface', () => {
    const r = ex.explainConcept({
      prompt: 'hola mundo',
      conceptSurface: 'xyzzy',
    });
    assert.equal(r.found, false);
    assert.match(r.narrative, /No concept matching/);
  });

  test('empty prompt still yields valid steps array', () => {
    const r = ex.explain({ prompt: '' });
    assert.ok(Array.isArray(r.steps));
    assert.ok(r.steps.length >= 6);
  });
});
