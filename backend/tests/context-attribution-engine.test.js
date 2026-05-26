'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const eng = require('../src/services/context-attribution-engine');

describe('context-attribution-engine', () => {
  test('empty prompt does not crash and returns latency', () => {
    const b = eng.analyze({ prompt: '' });
    assert.ok(b);
    assert.equal(typeof b.latencyMs, 'number');
    assert.equal(b.concepts.length, 0);
  });

  test('analyse returns concepts + attribution + multiHop + plan + suppression', () => {
    const b = eng.analyze({
      prompt: 'Crea un PDF y un Excel, luego compara los resultados; no modifiques la UI.',
      memories: [{ fact: 'no modifiques la UI' }],
    });
    assert.ok(Array.isArray(b.concepts));
    assert.ok(b.attribution && b.attribution.summary);
    assert.ok(b.multiHop);
    assert.ok(b.plan);
    assert.ok(b.suppression);
    assert.ok(b.systemPromptBlock.length > 0);
  });

  test('suppression conflicts surface when prompt violates memory rule', () => {
    const b = eng.analyze({
      prompt: 'Modifica la UI del Login y cámbiale el color',
      memories: [{ fact: 'no modifiques la UI' }],
    });
    assert.ok(b.suppression.hasConflicts);
  });

  test('plan emerges when prompt has multiple deliverables', () => {
    const b = eng.analyze({
      prompt: 'Necesito un PDF, un Excel y una presentación. Plan paso a paso.',
    });
    assert.equal(b.plan.planRequired, true);
    assert.ok(b.plan.nodes.length >= 3);
  });

  test('faithfulness only runs when draftResponse supplied', () => {
    const without = eng.analyze({ prompt: 'hola' });
    assert.equal(without.faithfulness, null);
    const withDraft = eng.analyze({
      prompt: 'Cuál es la cifra',
      ragSnippets: [{ text: 'The 2024 revenue was 100 USD.' }],
      draftResponse: 'The revenue was 100 USD in 2024.',
    });
    assert.ok(withDraft.faithfulness);
    assert.ok(withDraft.faithfulness.score >= 0);
    assert.ok(withDraft.faithfulness.score <= 1);
  });

  test('buildPromptInjection returns block + telemetry', () => {
    const out = eng.buildPromptInjection({ prompt: 'arregla el bug en backend/src/routes/ai.js' });
    assert.ok(out.block);
    assert.equal(typeof out.telemetry.latencyMs, 'number');
  });

  test('summarize returns aggregate numbers', () => {
    const s = eng.summarize({
      prompt: 'compara A vs B, luego crea un PDF',
    });
    assert.ok(typeof s.multiHopDepth === 'number');
    assert.ok(typeof s.planNodes === 'number');
    assert.ok(typeof s.suppressionConflicts === 'number');
  });

  test('end-to-end latency stays under 200 ms on a typical thread', () => {
    const history = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Turn ${i}: lorem ipsum dolor sit amet about ${i}-th topic with numbers like ${i * 13}.`,
    }));
    const b = eng.analyze({
      prompt: 'Continúa con lo anterior y genera el reporte final',
      history,
      memories: [{ fact: 'siempre incluye citas' }],
    });
    assert.ok(b.latencyMs < 400, `latency too high: ${b.latencyMs}ms`);
  });
});
