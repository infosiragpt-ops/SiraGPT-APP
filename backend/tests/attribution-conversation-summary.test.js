'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const summarizer = require('../src/services/attribution-conversation-summary');
const entityTracker = require('../src/services/cross-turn-entity-tracker');
const driftMonitor = require('../src/services/concept-drift-monitor');
const beliefTracker = require('../src/services/belief-state-tracker');

describe('attribution-conversation-summary', () => {
  beforeEach(() => {
    entityTracker._reset();
    driftMonitor._reset();
    beliefTracker._reset();
  });

  test('empty history returns minimal summary', () => {
    const s = summarizer.buildSummary({ userId: 'u', chatId: 'c', history: [] });
    assert.equal(s.turnsAnalyzed, 0);
    assert.equal(s.dominantSupernodes.length, 0);
  });

  test('detects supernodes and intents across multiple turns', () => {
    const history = [
      { role: 'user', content: 'Arregla el bug del frontend del Login Component' },
      { role: 'assistant', content: 'Hecho' },
      { role: 'user', content: 'Ahora despliega el backend a producción' },
    ];
    const s = summarizer.buildSummary({ userId: 'u', chatId: 'c', history });
    assert.ok(s.turnsAnalyzed >= 2);
    assert.ok(s.dominantSupernodes.length >= 1);
    assert.ok(s.primaryIntents.length >= 1);
  });

  test('captures turn-points when topic changes drastically', () => {
    const history = [
      { role: 'user', content: 'Analiza el contrato legal de servicios profesionales' },
      { role: 'assistant', content: 'OK' },
      { role: 'user', content: 'Olvida eso. Implementa una función JavaScript que valide emails' },
    ];
    const s = summarizer.buildSummary({ userId: 'u', chatId: 'c', history });
    assert.ok(s.turnPoints.length >= 1);
  });

  test('renderMarkdown produces structured doc', () => {
    const history = [
      { role: 'user', content: 'Crea un PDF con los KPIs del trimestre' },
    ];
    const s = summarizer.buildSummary({ userId: 'u', chatId: 'c', history });
    const md = summarizer.renderMarkdown(s);
    assert.match(md, /Conversation insights/);
    assert.match(md, /Turns analyzed/);
  });

  test('includes entities when tracker has data for the chat', () => {
    entityTracker.register({ userId: 'u', chatId: 'c', turnIndex: 0, text: 'Configura el Login Component' });
    const s = summarizer.buildSummary({ userId: 'u', chatId: 'c', history: [{ role: 'user', content: 'Configura el Login Component' }] });
    assert.ok(s.entities.length >= 1);
  });

  test('includes beliefs when tracker has data', () => {
    beliefTracker.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'El bug del login ya está arreglado' });
    const s = summarizer.buildSummary({ userId: 'u', chatId: 'c', history: [{ role: 'user', content: 'El bug del login ya está arreglado' }] });
    assert.ok(s.activeBeliefs.length >= 1);
  });
});
