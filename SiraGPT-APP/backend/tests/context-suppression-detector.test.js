'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const sd = require('../src/services/context-suppression-detector');

describe('context-suppression-detector', () => {
  test('empty input → no conflicts', () => {
    const r = sd.analyze({ prompt: '' });
    assert.equal(r.hasConflicts, false);
    assert.equal(r.rules.length, 0);
  });

  test('detects "do not modify UI" rule from memory', () => {
    const r = sd.analyze({
      prompt: 'Modifica la UI del Login',
      memories: [{ fact: 'no modifiques la UI', category: 'preference' }],
    });
    assert.ok(r.rules.length >= 1);
    assert.ok(r.hasConflicts);
    assert.ok(r.conflicts.some((c) => c.severity === 'high'));
  });

  test('compliant prompt → no conflicts even with rule present', () => {
    const r = sd.analyze({
      prompt: 'Crea un endpoint nuevo sin tocar la interfaz',
      memories: [{ fact: 'no modifiques la UI', category: 'preference' }],
    });
    assert.ok(r.rules.length >= 1);
    assert.equal(r.hasConflicts, false);
  });

  test('language mismatch detected from profile', () => {
    const r = sd.analyze({
      prompt: 'Please review this code and explain what it does in English.',
      userProfile: { customInstructions: 'siempre responde en español por favor' },
    });
    assert.ok(r.rules.some((rule) => rule.target === 'language'));
  });

  test('renderSuppressionBlock empty when no conflicts', () => {
    const r = sd.analyze({ prompt: 'hola' });
    assert.equal(sd.renderSuppressionBlock(r), '');
  });

  test('renderSuppressionBlock contains alert when conflict present', () => {
    const r = sd.analyze({
      prompt: 'Modifica la UI del Login',
      memories: [{ fact: 'no modifiques la UI' }],
    });
    const block = sd.renderSuppressionBlock(r);
    assert.match(block, /SUPPRESSION/);
  });

  test('detects "do not use web search" rule', () => {
    const r = sd.analyze({
      prompt: 'Busca en la web el último anuncio',
      memories: [{ fact: 'no uses la búsqueda web por favor' }],
    });
    assert.ok(r.rules.some((rule) => rule.target === 'tool_use'));
    assert.ok(r.hasConflicts);
  });
});
