/**
 * Tests for AgentCoder (programmer → test-designer → test-executor).
 *
 * The LLM is stubbed via a scripted client so we can assert the exact
 * loop structure and the feedback format. The SANDBOX is real — it
 * actually runs Python against the generated code, which is the whole
 * point of AgentCoder over plain code-gen.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const agentCoder = require('../src/services/agents/agent-coder');

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

// ─── formatFailuresForFeedback ───────────────────────────────────────────

test('formatFailuresForFeedback: includes pass/fail counts + failing test names', () => {
  const out = agentCoder.formatFailuresForFeedback({
    passed: 2,
    failed: 1,
    failures: [{ name: 'handles empty', detail: 'expected 0, got None' }],
    stderr: '',
    stdout: '',
  });
  assert.match(out, /2 passed, 1 failed/);
  assert.match(out, /handles empty.*expected 0, got None/);
});

test('formatFailuresForFeedback: surfaces timeout', () => {
  const out = agentCoder.formatFailuresForFeedback({
    passed: 0, failed: 0,
    failures: [],
    timedOut: true,
    stderr: '', stdout: '',
  });
  assert.match(out, /TIMED OUT/);
});

// ─── solve: happy path (programmer gets it right first try) ──────────────

test('solve: correct code passes without retry', async () => {
  const code = 'def add(a, b):\n    return a + b\n';
  const openai = scripted([
    JSON.stringify({ code, entry_point: 'add', notes: 'trivial sum' }),
    JSON.stringify({ language: 'python', tests: '_check("2+3", add(2, 3) == 5)\n_check("0+0", add(0, 0) == 0)\n' }),
  ]);
  const r = await agentCoder.solve({
    openai,
    prompt: 'Write a function add(a, b) that returns a + b.',
    language: 'python',
    maxRetries: 2,
    timeoutMs: 5000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(r.language, 'python');
  assert.match(r.code, /def add/);
  assert.equal(r.executions[0].failed, 0);
  assert.ok(r.executions[0].passed >= 2);
});

// ─── solve: repair loop (fail → fix → pass) ──────────────────────────────

test('solve: failing draft triggers a repair call that fixes it', async () => {
  const bad = 'def add(a, b):\n    return a - b\n';       // subtracts, will fail
  const good = 'def add(a, b):\n    return a + b\n';
  const openai = scripted([
    JSON.stringify({ code: bad, entry_point: 'add' }),
    JSON.stringify({ language: 'python', tests: '_check("sum", add(2, 3) == 5)\n' }),
    JSON.stringify({ code: good, entry_point: 'add' }),   // repair
  ]);
  const r = await agentCoder.solve({
    openai,
    prompt: 'Write add(a, b) returning a + b.',
    language: 'python',
    maxRetries: 2,
    timeoutMs: 5000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(r.executions.length, 2);
  assert.equal(r.executions[0].ok, false);
  assert.equal(r.executions[1].ok, true);

  // The second programmer call should have contained the failing-test
  // feedback. Pull the "user" message out of the repair call (index 2).
  const repairCall = openai.calls[2];
  const userMsg = repairCall.messages.find(m => m.role === 'user').content;
  assert.match(userMsg, /PREVIOUS RUN/);
  assert.match(userMsg, /passed|failed/);
});

// ─── solve: exhausts retries, returns ok=false ───────────────────────────

test('solve: exhausts retries when the fix keeps failing', async () => {
  const bad = 'def add(a, b):\n    return a - b\n';
  const openai = scripted([
    JSON.stringify({ code: bad, entry_point: 'add' }),
    JSON.stringify({ language: 'python', tests: '_check("sum", add(2, 3) == 5)\n' }),
    JSON.stringify({ code: bad, entry_point: 'add' }),
    JSON.stringify({ code: bad, entry_point: 'add' }),
  ]);
  const r = await agentCoder.solve({
    openai,
    prompt: 'Write add(a, b).',
    language: 'python',
    maxRetries: 2,
    timeoutMs: 5000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3); // initial + 2 retries
  assert.match(r.reason, /exhausted/);
});

// ─── solve: extraTests=false skips the tester call ───────────────────────

test('solve: extraTests=false does not call the tester agent', async () => {
  // With a visibleTests body and extraTests=false we expect exactly
  // ONE llm call (the programmer). Script one and assert call count.
  const code = 'def add(a, b):\n    return a + b\n';
  const openai = scripted([JSON.stringify({ code, entry_point: 'add' })]);
  const r = await agentCoder.solve({
    openai,
    prompt: 'add(a,b) returns a+b',
    visibleTests: '_check("v", add(1, 2) == 3)\n',
    language: 'python',
    extraTests: false,
    maxRetries: 1,
    timeoutMs: 5000,
  });
  assert.equal(r.ok, true);
  assert.equal(openai.calls.length, 1, 'tester should NOT have been called');
});

// ─── solve: empty prompt refused ─────────────────────────────────────────

test('solve: empty prompt is refused', async () => {
  const r = await agentCoder.solve({ openai: scripted([]), prompt: '', language: 'python' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /empty/);
});

test('solve: null openai is refused', async () => {
  const r = await agentCoder.solve({ openai: null, prompt: 'anything', language: 'python' });
  assert.equal(r.ok, false);
});

// ─── JavaScript loop ─────────────────────────────────────────────────────

// ─── strategy plumbing ───────────────────────────────────────────────────

test('solve: strategy=cot routes the first draft through CoT prompt', async () => {
  // When strategy='cot' we expect TWO LLM calls before the tester:
  // the CoT-style programmer call (note: the scripted mock doesn't
  // care which system prompt was used; we only need to verify the
  // strategy_trace is populated correctly). With extraTests=false
  // and visibleTests supplied, the sequence is just the CoT call.
  const openai = scripted([
    JSON.stringify({
      reasoning: '1. return the sum',
      code: 'def add(a, b):\n    return a + b\n',
      entry_point: 'add',
      notes: '',
    }),
  ]);
  const r = await agentCoder.solve({
    openai,
    prompt: 'add',
    visibleTests: '_check("s", add(1, 2) == 3)\n',
    language: 'python',
    extraTests: false,
    maxRetries: 1,
    strategy: 'cot',
    timeoutMs: 5000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'cot');
  assert.equal(r.strategy_trace.strategy, 'cot');
  assert.match(r.strategy_trace.reasoning, /return the sum/);
});

test('solve: strategy=self-plan produces a plan + implementation', async () => {
  const openai = scripted([
    JSON.stringify({ plan: ['sum the list'], entry_point: 'sum_list', edge_cases: ['empty'] }),
    JSON.stringify({ code: 'def sum_list(xs):\n    return sum(xs)\n', entry_point: 'sum_list' }),
  ]);
  const r = await agentCoder.solve({
    openai,
    prompt: 'sum a list',
    visibleTests: '_check("a", sum_list([1,2,3]) == 6)\n',
    language: 'python',
    extraTests: false,
    maxRetries: 1,
    strategy: 'self-plan',
    timeoutMs: 5000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'self-plan');
  assert.deepEqual(r.strategy_trace.plan, ['sum the list']);
});

test('solve: JavaScript path runs end-to-end', async () => {
  const src = 'function mul(a, b) { return a * b; }\n';
  const openai = scripted([
    JSON.stringify({ code: src, entry_point: 'mul' }),
    JSON.stringify({ language: 'javascript', tests: '_check("2*3", mul(2, 3) === 6);\n' }),
  ]);
  const r = await agentCoder.solve({
    openai,
    prompt: 'multiply a and b',
    language: 'javascript',
    maxRetries: 1,
    timeoutMs: 5000,
  });
  assert.equal(r.ok, true);
  assert.match(r.code, /function mul/);
});
