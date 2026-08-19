/**
 * Tests for the HumanEval pass@k runner.
 *
 * We stub the LLM but run the real sandbox against real Python tests,
 * so the outcome of the scripted code is actually determined by whether
 * the Python runs + passes. That's what makes this a meaningful test
 * of the harness plumbing rather than just a mock verification.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const he = require('../src/services/agents/benchmarks/humaneval');

function scripted(seq) {
  let i = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }],
    }) } },
  };
}

// ─── pass@k formula (Chen et al. 2021) ───────────────────────────────────

test('passAtK: k=1 degenerates to c/n', () => {
  assert.equal(he.passAtK(10, 5, 1), 0.5);
  assert.equal(he.passAtK(10, 10, 1), 1.0);
  assert.equal(he.passAtK(10, 0, 1), 0.0);
});

test('passAtK: c=0 → 0, c=n → 1', () => {
  assert.equal(he.passAtK(5, 0, 3), 0.0);
  assert.equal(he.passAtK(5, 5, 3), 1.0);
});

test('passAtK: n-c < k → 1.0 (not enough failures to avoid a pass in the k pick)', () => {
  assert.equal(he.passAtK(5, 4, 3), 1.0);
  assert.equal(he.passAtK(5, 3, 3), 1.0);
});

test('combinations: basic invariants', () => {
  assert.equal(he.combinations(5, 0), 1);
  assert.equal(he.combinations(5, 5), 1);
  assert.equal(he.combinations(5, 2), 10);
  assert.equal(he.combinations(6, 3), 20);
  assert.equal(he.combinations(3, 5), 0);
});

// ─── Built-in sample problems are well-formed ────────────────────────────

test('BUILTIN_SAMPLE: every problem has required fields', () => {
  assert.ok(he.BUILTIN_SAMPLE.length >= 3);
  for (const p of he.BUILTIN_SAMPLE) {
    assert.ok(typeof p.task_id === 'string');
    assert.ok(typeof p.prompt === 'string' && p.prompt.length > 0);
    assert.ok(typeof p.entry_point === 'string' && p.entry_point.length > 0);
    assert.ok(typeof p.test === 'string' && p.test.includes('_check'));
  }
});

test('loadProblems: built-in sample, no dataset path', async () => {
  const problems = await he.loadProblems({ sample: true });
  assert.equal(problems.length, he.BUILTIN_SAMPLE.length);
});

test('loadProblems: limit is honoured', async () => {
  const problems = await he.loadProblems({ sample: true, limit: 2 });
  assert.equal(problems.length, 2);
});

test('loadProblems: reads JSONL from a path', async () => {
  const tmp = path.join(__dirname, '_tmp_humaneval.jsonl');
  const lines = [
    JSON.stringify({ task_id: 'f/0', prompt: 'def f():\n    pass', entry_point: 'f', test: '_check("x", True)\n' }),
    '',  // blank line skipped
    'not-json',  // malformed line skipped
    JSON.stringify({ task_id: 'f/1', prompt: 'def g():\n    pass', entry_point: 'g', test: '_check("y", True)\n' }),
  ].join('\n');
  fs.writeFileSync(tmp, lines, 'utf8');
  try {
    const problems = await he.loadProblems({ datasetPath: tmp });
    assert.equal(problems.length, 2);
    assert.equal(problems[0].task_id, 'f/0');
    assert.equal(problems[1].task_id, 'f/1');
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ─── evaluate: direct strategy on a solvable problem ─────────────────────

test('evaluate/direct: correct LLM output → solved', async () => {
  // truncate_number — return decimal part of a positive float.
  const code = 'def truncate_number(number: float) -> float:\n    return number - int(number)\n';
  const openai = scripted([JSON.stringify({ code, entry_point: 'truncate_number' })]);
  const r = await he.evaluate({
    openai,
    strategy: 'direct',
    limit: 1,  // first built-in is has_close_elements — won't match; use a limit that lets us skip
    samplesPerProblem: 1,
    ks: [1],
  });
  // limit=1 picks problem 0 (has_close_elements) but our code is for
  // truncate_number, so it'll fail. Expected: solved=0, pass@1=0.
  assert.equal(r.total, 1);
  assert.equal(r.solved, 0);
  assert.equal(r.passAtK[1], 0);
});

test('evaluate/direct: solves truncate_number when given matching code', async () => {
  // Craft a fresh problem list by using loadProblems + stripping to
  // the one that matches our canned solution.
  const all = await he.loadProblems({ sample: true });
  const truncProblem = all.find(p => p.entry_point === 'truncate_number');
  assert.ok(truncProblem);

  // We bypass the benchmark's default "load built-ins" by writing the
  // single problem to a temp JSONL and using datasetPath.
  const tmp = path.join(__dirname, '_tmp_truncate.jsonl');
  fs.writeFileSync(tmp, JSON.stringify(truncProblem) + '\n', 'utf8');
  try {
    const code = 'def truncate_number(number: float) -> float:\n    return number - int(number)\n';
    const openai = scripted([JSON.stringify({ code, entry_point: 'truncate_number' })]);
    const r = await he.evaluate({
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
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ─── evaluate: agent-coder strategy picks up feedback on failure ─────────

test('evaluate/agent-coder: first draft fails, repair succeeds', async () => {
  const tmp = path.join(__dirname, '_tmp_below.jsonl');
  const all = await he.loadProblems({ sample: true });
  const problem = all.find(p => p.entry_point === 'below_zero');
  assert.ok(problem);
  fs.writeFileSync(tmp, JSON.stringify(problem) + '\n', 'utf8');
  try {
    // First draft is buggy (returns True always); test-designer then
    // replacement programmer fix. With extraTests=false in the eval
    // default, no tester call is made, so the sequence is: programmer,
    // programmer(fix).
    const bad = 'def below_zero(operations):\n    return True\n';
    const good = 'def below_zero(operations):\n    total = 0\n    for x in operations:\n        total += x\n        if total < 0: return True\n    return False\n';
    const openai = scripted([
      JSON.stringify({ code: bad, entry_point: 'below_zero' }),
      JSON.stringify({ code: good, entry_point: 'below_zero' }),
    ]);
    const r = await he.evaluate({
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
    assert.equal(r.passAtK[1], 1.0);
    assert.ok(r.problems[0].attempts >= 2, `expected ≥2 attempts, got ${r.problems[0].attempts}`);
  } finally {
    fs.unlinkSync(tmp);
  }
});
