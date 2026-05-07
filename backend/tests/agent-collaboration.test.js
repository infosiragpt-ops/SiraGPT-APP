/**
 * Tests for agent-collaboration — multi-agent coordination layer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { decomposeGoal, forkJoin, chain, MAX_SUB_AGENTS } = require('../src/services/agents/agent-collaboration');

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

test('forkJoin: empty subTasks → ok=false with no_sub_tasks', async () => {
  const r = await forkJoin({ subTasks: [], user: { id: 'u' } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_sub_tasks');
});

test('forkJoin: too many subTasks → rejected without dispatch', async () => {
  const subTasks = Array.from({ length: MAX_SUB_AGENTS + 1 }, (_, i) => ({ goal: `g${i}` }));
  const r = await forkJoin({ subTasks, user: { id: 'u' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /max .* sub-tasks/);
});

test('forkJoin: missing goal in sub-task is rejected pre-dispatch', async () => {
  const r = await forkJoin({ subTasks: [{ goal: 'ok' }, { context: {} }], user: { id: 'u' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /sub-task 1: missing goal/);
});

test('chain: empty subTasks → ok=false with no_sub_tasks', async () => {
  const r = await chain({ subTasks: [], user: { id: 'u' } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_sub_tasks');
});

test('chain: too many subTasks → rejected pre-dispatch', async () => {
  const subTasks = Array.from({ length: MAX_SUB_AGENTS + 1 }, (_, i) => ({ goal: `g${i}` }));
  const r = await chain({ subTasks, user: { id: 'u' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /max .* sub-tasks/);
});

test('chain: missing goal in sub-task is rejected pre-dispatch', async () => {
  const r = await chain({ subTasks: [{ goal: '   ' }], user: { id: 'u' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /missing goal/);
});

test('decomposeGoal: filters out very short fragments', () => {
  // "y" between letters would yield 1-char fragments — drop them.
  const parts = decomposeGoal('A y B y C', { maxParts: 5, minFragmentLength: 3 });
  // Either keeps the original (no fragment >= 3) or returns nothing tiny.
  for (const p of parts) {
    assert.ok(p.goal.length >= 3, `fragment too short: "${p.goal}"`);
  }
});

test('decomposeGoal: dedupes case-insensitively', () => {
  const parts = decomposeGoal('Analizar datos y analizar DATOS', { maxParts: 4 });
  const lowered = parts.map((p) => p.goal.toLowerCase());
  const unique = new Set(lowered);
  assert.equal(lowered.length, unique.size, 'duplicates not removed');
});

test('decomposeGoal: totalParts matches actual returned length', () => {
  const parts = decomposeGoal('Primero analizar y luego graficar y finalmente exportar', { maxParts: 10 });
  for (const p of parts) {
    assert.equal(p.context.totalParts, parts.length);
  }
});
