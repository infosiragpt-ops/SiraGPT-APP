'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const drift = require('../src/services/concept-drift-monitor');

describe('concept-drift-monitor', () => {
  beforeEach(() => drift._reset());

  test('first observation is baseline with drift 0', () => {
    const o = drift.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'Crea un PDF con los KPIs' });
    assert.equal(o.classification, 'baseline');
    assert.equal(o.drift, 0);
  });

  test('continuation maintains low drift across same-topic turns', () => {
    drift.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'Edita el código del backend para arreglar el bug' });
    drift.observe({ userId: 'u', chatId: 'c', turnIndex: 1, prompt: 'Sigue arreglando el código del backend' });
    const o3 = drift.observe({ userId: 'u', chatId: 'c', turnIndex: 2, prompt: 'Otra corrección al backend del proyecto' });
    assert.ok(o3.classification !== 'hard_shift');
  });

  test('hard topic shift detected on unrelated turn', () => {
    drift.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'Resume el contrato legal de servicios que te pasé' });
    const o = drift.observe({
      userId: 'u',
      chatId: 'c',
      turnIndex: 1,
      prompt: 'Ignora todo eso. Implementa una función JavaScript que valide emails',
    });
    assert.ok(['soft_shift', 'hard_shift'].includes(o.classification));
  });

  test('summarize returns aggregate stats', () => {
    drift.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'hola' });
    drift.observe({ userId: 'u', chatId: 'c', turnIndex: 1, prompt: 'crea código JS para validar' });
    const s = drift.summarize({ userId: 'u', chatId: 'c' });
    assert.ok(s.observations >= 2);
    assert.ok(typeof s.avgDrift === 'number');
  });

  test('buildDriftBlock empty on baseline/continuation', () => {
    const o = drift.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'hola' });
    assert.equal(drift.buildDriftBlock(o), '');
  });

  test('buildDriftBlock contains content on shift', () => {
    drift.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'resume el contrato legal de servicios' });
    const o = drift.observe({ userId: 'u', chatId: 'c', turnIndex: 1, prompt: 'implementa función JS que valide emails con código backend completo' });
    if (o.classification === 'hard_shift' || o.classification === 'soft_shift') {
      const block = drift.buildDriftBlock(o);
      assert.match(block, /DRIFT/);
    }
  });

  test('reset wipes trail', () => {
    drift.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'a' });
    drift.reset({ userId: 'u', chatId: 'c' });
    const o = drift.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'b' });
    assert.equal(o.classification, 'baseline');
  });
});
