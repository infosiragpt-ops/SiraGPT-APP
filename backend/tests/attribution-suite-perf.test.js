'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const suite = require('../src/services/attribution-suite');
const entityTracker = require('../src/services/cross-turn-entity-tracker');
const driftMonitor = require('../src/services/concept-drift-monitor');
const beliefTracker = require('../src/services/belief-state-tracker');

function makeHistory(n) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Turn ${i + 1}: trabajando en backend/src/services/foo-${i}.js con bug ${i} en cliente Acme #${i}.`,
  }));
}

function makeFiles(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `file_${i}`,
    name: `report-${i}.pdf`,
    summary: `Reporte mensual sobre KPIs y métricas del producto ${i}.`,
  }));
}

function makeMemories(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `mem_${i}`,
    fact: `Preferencia del usuario #${i}: siempre incluye citas.`,
    category: 'preference',
    strength: 0.7,
    tier: 'long_term',
  }));
}

function makeRag(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `chunk_${i}`,
    text: `Datos sobre la métrica X${i} con valor ${1000 + i * 13}.`,
    score: 0.8,
  }));
}

describe('attribution-suite-perf', () => {
  test('20-turn realistic thread stays under 100ms', () => {
    entityTracker._reset();
    driftMonitor._reset();
    beliefTracker._reset();

    const samples = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const r = suite.run({
        userId: 'perf-user',
        chatId: 'perf-chat',
        turnIndex: 19,
        prompt: 'Compara el rendimiento del backend Acme con el frontend Login antes de desplegar; el bug del login ya está arreglado, no modifiques la UI.',
        history: makeHistory(20),
        files: makeFiles(3),
        memories: makeMemories(5),
        ragSnippets: makeRag(4),
      });
      samples.push(Date.now() - t0);
      assert.ok(r.systemPromptBlock.length > 0);
    }

    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const p95 = samples[Math.floor(samples.length * 0.95)] || samples[samples.length - 1];

    assert.ok(median < 100, `median latency ${median}ms exceeds 100ms (samples: ${samples.join(',')})`);
    assert.ok(p95 < 200, `p95 latency ${p95}ms exceeds 200ms (samples: ${samples.join(',')})`);
  });

  test('cold-start (first turn, empty state) stays under 50ms', () => {
    entityTracker._reset();
    driftMonitor._reset();
    beliefTracker._reset();

    const t0 = Date.now();
    const r = suite.run({
      userId: 'cold-user',
      chatId: 'cold-chat',
      turnIndex: 0,
      prompt: 'crea un PDF con los KPIs del trimestre',
    });
    const elapsed = Date.now() - t0;
    assert.ok(r.systemPromptBlock.length > 0);
    assert.ok(elapsed < 50, `cold-start latency ${elapsed}ms exceeds 50ms`);
  });

  test('engine.analyze alone stays under 30ms on a typical turn', () => {
    const engine = require('../src/services/context-attribution-engine');
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      engine.analyze({
        prompt: 'arregla el bug en backend/src/services/foo.js y genera un PDF',
        history: makeHistory(10),
        files: makeFiles(2),
        memories: makeMemories(3),
      });
      samples.push(Date.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    assert.ok(median < 30, `engine median ${median}ms exceeds 30ms (samples: ${samples.join(',')})`);
  });
});
