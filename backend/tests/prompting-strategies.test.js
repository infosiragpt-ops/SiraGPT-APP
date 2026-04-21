/**
 * Tests for §5.6 prompting strategies.
 *
 * The strategies are LLM-heavy, so we stub OpenAI with a scripted
 * client that returns the payload we hand-craft. The sandbox is real
 * for the self-consistency ranking test (we actually run Python so
 * the ranking pick is not a mock).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const strat = require('../src/services/agents/prompting-strategies');

function scripted(seq) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (args) => {
      calls.push(args);
      const content = seq[Math.min(i++, seq.length - 1)];
      return { choices: [{ message: { content } }] };
    }}},
  };
}

// ─── plain ───────────────────────────────────────────────────────────────

test('plain: returns the programmer output verbatim', async () => {
  const openai = scripted([
    JSON.stringify({ code: 'def f(): return 1', entry_point: 'f', notes: '' }),
  ]);
  const r = await strat.generate({ openai, prompt: 'trivial', strategy: 'plain' });
  assert.equal(r.code, 'def f(): return 1');
  assert.equal(r.entry_point, 'f');
  assert.equal(r.trace.strategy, 'plain');
});

// ─── cot ─────────────────────────────────────────────────────────────────

test('cot: reasoning field propagates into the trace', async () => {
  const openai = scripted([
    JSON.stringify({
      reasoning: '1. parse input\n2. compute\n3. return',
      code: 'def f(x): return x + 1',
      entry_point: 'f',
      notes: 'covers negative',
    }),
  ]);
  const r = await strat.generate({ openai, prompt: 'increment', strategy: 'cot' });
  assert.equal(r.code, 'def f(x): return x + 1');
  assert.match(r.trace.reasoning, /parse input/);
});

// ─── self-plan ───────────────────────────────────────────────────────────

test('self-plan: produces plan first then implements it (two LLM calls)', async () => {
  const openai = scripted([
    JSON.stringify({
      plan: ['validate input', 'iterate and sum', 'return total'],
      entry_point: 'sum_list',
      edge_cases: ['empty list', 'negative numbers'],
    }),
    JSON.stringify({
      code: 'def sum_list(xs):\n    total = 0\n    for x in xs: total += x\n    return total',
      entry_point: 'sum_list',
      notes: '',
    }),
  ]);
  const r = await strat.generate({ openai, prompt: 'sum a list', strategy: 'self-plan' });
  assert.equal(openai.calls.length, 2);
  assert.equal(r.trace.plan.length, 3);
  assert.deepEqual(r.trace.edgeCases, ['empty list', 'negative numbers']);
  assert.match(r.code, /def sum_list/);
});

// ─── self-refine ─────────────────────────────────────────────────────────

test('self-refine: critic severity=none → returns original, no revision call', async () => {
  const openai = scripted([
    JSON.stringify({ code: 'def f(): return 1', entry_point: 'f', notes: '' }),
    JSON.stringify({ issues: [], severity: 'none', suggested_fixes: [] }),
  ]);
  const r = await strat.generate({ openai, prompt: 'trivial', strategy: 'self-refine' });
  assert.equal(openai.calls.length, 2, 'should NOT call the revisor when severity=none');
  assert.equal(r.code, 'def f(): return 1');
  assert.equal(r.trace.revisedSource, false);
});

test('self-refine: high severity → revised code replaces the original', async () => {
  const openai = scripted([
    JSON.stringify({ code: 'def f(x): return x - 1', entry_point: 'f', notes: '' }),
    JSON.stringify({
      issues: ['off-by-one; returns wrong value'],
      severity: 'high',
      suggested_fixes: ['change to x + 1'],
    }),
    JSON.stringify({ code: 'def f(x): return x + 1', entry_point: 'f', notes: 'fixed off-by-one' }),
  ]);
  const r = await strat.generate({ openai, prompt: 'increment', strategy: 'self-refine' });
  assert.equal(openai.calls.length, 3, 'should run: generate, critique, revise');
  assert.equal(r.code, 'def f(x): return x + 1');
  assert.equal(r.trace.revisedSource, true);
  assert.equal(r.trace.severity, 'high');
});

test('self-refine: revisor returns empty code → falls back to draft', async () => {
  const openai = scripted([
    JSON.stringify({ code: 'def f(): return 1', entry_point: 'f', notes: '' }),
    JSON.stringify({ issues: ['something'], severity: 'medium', suggested_fixes: [] }),
    JSON.stringify({ code: '', entry_point: 'f', notes: '' }),  // empty revision
  ]);
  const r = await strat.generate({ openai, prompt: 'x', strategy: 'self-refine' });
  assert.equal(r.code, 'def f(): return 1');
});

// ─── self-consistency ────────────────────────────────────────────────────

test('self-consistency (execution): picks the candidate that passes visible tests', async () => {
  // Three candidates: two wrong, one right. The right one should win
  // after executing against the visible test.
  const correct = 'def add(a, b):\n    return a + b';
  const bad1 = 'def add(a, b):\n    return a - b';
  const bad2 = 'def add(a, b):\n    return a * b';
  const openai = scripted([
    JSON.stringify({ code: bad1, entry_point: 'add' }),
    JSON.stringify({ code: bad2, entry_point: 'add' }),
    JSON.stringify({ code: correct, entry_point: 'add' }),
  ]);
  const r = await strat.generate({
    openai,
    prompt: 'add two numbers',
    strategy: 'self-consistency',
    samples: 3,
    visibleTests: '_check("2+3", add(2, 3) == 5)\n',
    timeoutMs: 5000,
  });
  assert.equal(r.code, correct);
  assert.equal(r.trace.rankBy, 'execution');
  // The winning candidate should have passed=1, failed=0, ok=true.
  const winnerRanking = r.trace.ranked.find(x => x.ok);
  assert.ok(winnerRanking);
});

test('self-consistency (agreement): picks majority entry_point, shortest body', async () => {
  const openai = scripted([
    JSON.stringify({ code: 'def longer_body():\n    x = 1\n    return x', entry_point: 'longer_body' }),
    JSON.stringify({ code: 'def f(): return 1', entry_point: 'f' }),
    JSON.stringify({ code: 'def f():\n    # short variant\n    return 1', entry_point: 'f' }),
  ]);
  const r = await strat.generate({
    openai,
    prompt: 'x',
    strategy: 'self-consistency',
    samples: 3,
    // No visibleTests → agreement mode
  });
  assert.equal(r.trace.rankBy, 'agreement');
  assert.equal(r.entry_point, 'f');
  // Among the two "f" candidates, the shorter one wins.
  assert.equal(r.code, 'def f(): return 1');
});

test('self-consistency: no candidates → empty safe return', async () => {
  const openai = scripted([
    '{}', '{}', '{}',
  ]);
  const r = await strat.generate({
    openai, prompt: 'x', strategy: 'self-consistency', samples: 3,
  });
  assert.equal(r.code, '');
  assert.equal(r.trace.samples, 0);
});

// ─── guards ──────────────────────────────────────────────────────────────

test('unknown strategy rejected', async () => {
  await assert.rejects(
    strat.generate({ openai: scripted([]), prompt: 'x', strategy: 'tree-of-shadows' }),
    /unknown strategy/,
  );
});

test('empty prompt returns empty with error in trace', async () => {
  const r = await strat.generate({ openai: scripted([]), prompt: '', strategy: 'plain' });
  assert.equal(r.code, '');
  assert.equal(r.trace.error, 'empty prompt');
});

test('null openai returns empty with error in trace', async () => {
  const r = await strat.generate({ openai: null, prompt: 'x', strategy: 'plain' });
  assert.equal(r.code, '');
  assert.equal(r.trace.error, 'no LLM client');
});
