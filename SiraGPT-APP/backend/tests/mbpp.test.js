/**
 * Tests for MBPP benchmark runner.
 * Same LLM-stubbed / real-sandbox pattern as humaneval.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const mbpp = require('../src/services/agents/benchmarks/mbpp');

function scripted(seq) {
  let i = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }],
    }) } },
  };
}

// ─── pass@k helpers ──────────────────────────────────────────────────────

test('passAtK / combinations: parity with humaneval', () => {
  assert.equal(mbpp.combinations(6, 3), 20);
  assert.equal(mbpp.passAtK(10, 5, 1), 0.5);
  assert.equal(mbpp.passAtK(10, 0, 3), 0);
  assert.equal(mbpp.passAtK(10, 10, 3), 1);
});

// ─── test_list conversion ────────────────────────────────────────────────

test('mbppTestListToHarness: converts assert lines into _check calls', () => {
  const body = mbpp.mbppTestListToHarness([
    'assert add(2, 3) == 5',
    'assert sum_evens([]) == 0',
  ]);
  assert.match(body, /_check\("t1",\s*add\(2, 3\) == 5/);
  assert.match(body, /_check\("t2",\s*sum_evens\(\[\]\) == 0/);
});

test('mbppTestListToHarness: preserves expression after `, ...` (common MBPP trailing arg)', () => {
  // MBPP sometimes ships "assert foo(x) == 3, 'message'" — our converter
  // strips the trailing message so the boolean expression passes cleanly.
  const body = mbpp.mbppTestListToHarness(['assert foo(1) == 2, "should equal 2"']);
  assert.match(body, /_check\("t1",\s*foo\(1\) == 2,\s*detail="foo\(1\) == 2"/);
});

test('mbppTestListToHarness: empty or non-array → empty string', () => {
  assert.equal(mbpp.mbppTestListToHarness(null), '');
  assert.equal(mbpp.mbppTestListToHarness([]), '\n');
});

// ─── built-in sample well-formed ─────────────────────────────────────────

test('BUILTIN_SAMPLE: every problem has text + test_list', () => {
  assert.ok(mbpp.BUILTIN_SAMPLE.length >= 3);
  for (const p of mbpp.BUILTIN_SAMPLE) {
    assert.ok(typeof p.task_id === 'string');
    assert.ok(typeof p.text === 'string' && p.text.length > 0);
    assert.ok(Array.isArray(p.test_list) && p.test_list.length > 0);
    for (const t of p.test_list) assert.match(t, /^assert /);
  }
});

// ─── loadProblems ────────────────────────────────────────────────────────

test('loadProblems: respects limit on built-in sample', async () => {
  const p = await mbpp.loadProblems({ sample: true, limit: 2 });
  assert.equal(p.length, 2);
});

test('loadProblems: reads JSONL (supports prompt OR text)', async () => {
  const tmp = path.join(__dirname, '_tmp_mbpp.jsonl');
  fs.writeFileSync(tmp, [
    JSON.stringify({ task_id: 'a', text: 'write foo', test_list: ['assert foo() == 1'] }),
    JSON.stringify({ task_id: 'b', prompt: 'write bar', test_list: ['assert bar() == 2'] }), // `prompt` alias
    'not-json',
  ].join('\n'), 'utf8');
  try {
    const p = await mbpp.loadProblems({ datasetPath: tmp });
    assert.equal(p.length, 2);
    assert.equal(p[0].task_id, 'a');
    assert.equal(p[1].text, 'write bar');
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ─── evaluate: direct path solves a matching LLM response ────────────────

test('evaluate/direct: solves sum_evens when LLM returns correct code', async () => {
  const all = await mbpp.loadProblems({ sample: true });
  const problem = all.find(p => /sum.*even/i.test(p.text));
  assert.ok(problem);
  const tmp = path.join(__dirname, '_tmp_mbpp_solve.jsonl');
  fs.writeFileSync(tmp, JSON.stringify(problem) + '\n', 'utf8');
  try {
    const code = 'def sum_evens(xs):\n    return sum(x for x in xs if x % 2 == 0)\n';
    const openai = scripted([JSON.stringify({ code, entry_point: 'sum_evens' })]);
    const r = await mbpp.evaluate({
      openai,
      strategy: 'direct',
      datasetPath: tmp,
      limit: 1,
      samplesPerProblem: 1,
      ks: [1],
    });
    assert.equal(r.total, 1);
    assert.equal(r.solved, 1);
    assert.equal(r.passAtK[1], 1.0);
    assert.equal(r.benchmark, 'mbpp');
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ─── evaluate: agent-coder fix loop ──────────────────────────────────────

test('evaluate/agent-coder: first draft wrong, repair succeeds', async () => {
  const all = await mbpp.loadProblems({ sample: true });
  const problem = all.find(p => /fibonacci/i.test(p.text));
  assert.ok(problem);
  const tmp = path.join(__dirname, '_tmp_mbpp_fib.jsonl');
  fs.writeFileSync(tmp, JSON.stringify(problem) + '\n', 'utf8');
  try {
    const bad = 'def fib(n):\n    return n  # wrong\n';
    const good = 'def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n';
    const openai = scripted([
      JSON.stringify({ code: bad, entry_point: 'fib' }),
      JSON.stringify({ code: good, entry_point: 'fib' }),
    ]);
    const r = await mbpp.evaluate({
      openai,
      strategy: 'agent-coder',
      datasetPath: tmp,
      limit: 1,
      samplesPerProblem: 1,
      ks: [1],
      maxRetries: 2,
    });
    assert.equal(r.total, 1);
    assert.equal(r.solved, 1);
    assert.ok(r.problems[0].attempts >= 2);
  } finally {
    fs.unlinkSync(tmp);
  }
});
