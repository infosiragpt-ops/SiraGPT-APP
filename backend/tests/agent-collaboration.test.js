/**
 * Tests for agent-collaboration — multi-agent coordination layer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { decomposeGoal, MAX_SUB_AGENTS } = require('../src/services/agents/agent-collaboration');

test('decomposeGoal: empty input returns []', () => {
  assert.deepEqual(decomposeGoal(''), []);
  assert.deepEqual(decomposeGoal(null), []);
  assert.deepEqual(decomposeGoal(undefined), []);
});

test('decomposeGoal: short text returns single goal', () => {
  const parts = decomposeGoal('Generar un reporte');
  assert.equal(parts.length, 1);
  assert.ok(parts[0].goal.includes('reporte'));
  assert.deepEqual(parts[0].context, { partIndex: 0, totalParts: 1 });
});

test('decomposeGoal: long text with separators is split', () => {
  const goal = 'Primero analizar los datos y luego generar el gráfico y finalmente exportar a PDF';
  const parts = decomposeGoal(goal, { maxParts: 3 });
  assert.ok(parts.length >= 2);
  assert.ok(parts.length <= 3);
  assert.ok(parts.some((p) => p.goal.toLowerCase().includes('analizar')));
});

test('decomposeGoal: maxParts is respected', () => {
  const goal = 'A y B y C y D y E y F';
  const parts = decomposeGoal(goal, { maxParts: 3 });
  assert.ok(parts.length <= 3);
});

test('MAX_SUB_AGENTS is 5', () => {
  assert.equal(MAX_SUB_AGENTS, 5);
});

test('decomposeGoal: each part has goal and context', () => {
  const parts = decomposeGoal('Analizar ventas y generar dashboard');
  for (const part of parts) {
    assert.ok(typeof part.goal === 'string' && part.goal.length > 0);
    assert.ok(part.context);
    assert.equal(typeof part.context.partIndex, 'number');
    assert.equal(typeof part.context.totalParts, 'number');
  }
});

// forkJoin and chain tests require a running OpenAI key, so only test the
// decomposition and constants here. Integration tests should run manually.
test('module exports forkJoin, chain, decomposeGoal, MAX_SUB_AGENTS', () => {
  const mod = require('../src/services/agents/agent-collaboration');
  assert.equal(typeof mod.forkJoin, 'function');
  assert.equal(typeof mod.chain, 'function');
  assert.equal(typeof mod.decomposeGoal, 'function');
  assert.equal(mod.MAX_SUB_AGENTS, 5);
});
