/**
 * Unit tests for services/agents/agent-core.js.
 *
 * All LLM calls are stubbed. Tools are plain functions with scripted
 * behaviour so we can verify the ReAct loop actually:
 *   - parses JSON robustly
 *   - dispatches tool calls + feeds observations back in
 *   - terminates on {"final": ...}
 *   - hits maxIters cleanly when the LLM never finalises
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/services/agents/agent-core');

// ─── extractJSON ───────────────────────────────────────────────────────────

test('extractJSON: direct JSON', () => {
  assert.deepEqual(core.extractJSON('{"a":1}'), { a: 1 });
});

test('extractJSON: fenced code block', () => {
  assert.deepEqual(core.extractJSON('```json\n{"a":2}\n```'), { a: 2 });
});

test('extractJSON: JSON with leading prose', () => {
  assert.deepEqual(core.extractJSON('Sure!\n{"a":3}\nHope that helps'), { a: 3 });
});

test('extractJSON: handles nested braces inside string values', () => {
  const out = core.extractJSON('{"code":"function f(){ return 1; }"}');
  assert.equal(out.code, 'function f(){ return 1; }');
});

test('extractJSON: returns null on garbage', () => {
  assert.equal(core.extractJSON(''), null);
  assert.equal(core.extractJSON('just text, no braces'), null);
});

// ─── AgentTrace ────────────────────────────────────────────────────────────

test('AgentTrace: toMessages renders assistant + user observation pairs', () => {
  const tr = new core.AgentTrace();
  tr.append({ think: 'check file', tool: 'read_file', args: { source: 'x' }, observation: 'file contents' });
  const msgs = tr.toMessages();
  assert.equal(msgs[0].role, 'assistant');
  assert.ok(msgs[0].content.includes('read_file'));
  assert.equal(msgs[1].role, 'user');
  assert.ok(msgs[1].content.includes('file contents'));
});

// ─── run() with scripted LLM + tools ───────────────────────────────────────

function scriptedLLM(responses) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const content = responses[Math.min(i, responses.length - 1)];
          i++;
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

test('run(): finalises on first turn when LLM emits final', async () => {
  const openai = scriptedLLM([JSON.stringify({ thought: 'done', final: 'hello' })]);
  const result = await core.run({ openai, goal: 'say hello', role: 'r', tools: [] });
  assert.equal(result.final, 'hello');
  assert.equal(result.terminatedBy, 'final');
  assert.equal(result.iterations, 1);
});

test('run(): calls tool, feeds observation, then finalises', async () => {
  const openai = scriptedLLM([
    JSON.stringify({ thought: 'read the file', tool: 'read_file', args: { source: 'a' } }),
    JSON.stringify({ thought: 'got it', final: { read: 'yes' } }),
  ]);
  let called = null;
  const read_file = {
    name: 'read_file',
    description: 'r',
    schema: {},
    handler: async (args) => { called = args; return { text: 'FILE-CONTENT' }; },
  };
  const result = await core.run({ openai, goal: 'read a', tools: [read_file] });
  assert.deepEqual(called, { source: 'a' });
  assert.equal(result.terminatedBy, 'final');
  assert.equal(result.iterations, 2);
  assert.ok(result.trace.some(s => s.tool === 'read_file'));
});

test('run(): unknown tool → observation + model recovers', async () => {
  const openai = scriptedLLM([
    JSON.stringify({ tool: 'nonexistent', args: {} }),
    JSON.stringify({ final: 'recovered' }),
  ]);
  const result = await core.run({ openai, goal: 'g', tools: [] });
  assert.equal(result.final, 'recovered');
  const errStep = result.trace.find(s => s.tool === 'nonexistent');
  assert.ok(errStep.observation.includes('Unknown tool'));
});

test('run(): tool error becomes observation rather than throwing', async () => {
  const openai = scriptedLLM([
    JSON.stringify({ tool: 'boom', args: {} }),
    JSON.stringify({ final: 'survived' }),
  ]);
  const boom = {
    name: 'boom', description: 'b', schema: {},
    handler: async () => { throw new Error('tool exploded'); },
  };
  const result = await core.run({ openai, goal: 'g', tools: [boom] });
  assert.equal(result.final, 'survived');
  const step = result.trace.find(s => s.tool === 'boom');
  assert.ok(step.observation.error.includes('exploded'));
});

test('run(): hits maxIters when model varies but never finalises', async () => {
  // Rotate args each turn so raw responses differ — otherwise the
  // same-response loop detector kicks in before maxIters.
  let turn = 0;
  const openai = {
    chat: { completions: { create: async () => {
      const content = JSON.stringify({ tool: 'noop', args: { n: turn++ } });
      return { choices: [{ message: { content } }] };
    }}},
  };
  const noop = {
    name: 'noop', description: '', schema: {},
    handler: async () => 'ok',
  };
  const result = await core.run({ openai, goal: 'g', tools: [noop], maxIters: 3 });
  assert.equal(result.final, null);
  assert.equal(result.terminatedBy, 'maxIters');
  assert.equal(result.iterations, 3);
});

test('run(): same-response loop → terminatedBy="loop" on the third identical turn', async () => {
  const openai = scriptedLLM([
    JSON.stringify({ tool: 'noop', args: {} }), // same output forever
  ]);
  const noop = {
    name: 'noop', description: '', schema: {},
    handler: async () => 'ok',
  };
  const result = await core.run({ openai, goal: 'g', tools: [noop], maxIters: 20 });
  assert.equal(result.terminatedBy, 'loop');
  // Should bail well before maxIters — our impl triggers on the 3rd identical response.
  assert.ok(result.iterations <= 5, `expected early exit, got ${result.iterations}`);
});

test('run(): unparseable LLM output → recovery observation + model finalises', async () => {
  const openai = scriptedLLM([
    'not json at all',
    JSON.stringify({ final: 'ok after retry' }),
  ]);
  const result = await core.run({ openai, goal: 'g', tools: [] });
  assert.equal(result.final, 'ok after retry');
  const rec = result.trace.find(s => s.think && s.think.includes('unparseable'));
  assert.ok(rec);
});

test('run(): LLM API error terminates loop gracefully', async () => {
  const openai = {
    chat: { completions: { create: async () => { throw new Error('rate limit'); } } },
  };
  const result = await core.run({ openai, goal: 'g', tools: [] });
  assert.equal(result.terminatedBy, 'error');
  assert.equal(result.final, null);
});

test('run(): a failed tool result is NOT cached, so an identical retry can recover', async () => {
  let calls = 0;
  const flaky = {
    name: 'flaky', description: 'f', schema: {},
    handler: async () => { calls += 1; if (calls === 1) throw new Error('transient'); return { text: 'recovered' }; },
  };
  // Same tool+args (same cache key) but different `thought` so the same-response
  // loop detector doesn't abort before the retry.
  const openai = scriptedLLM([
    JSON.stringify({ thought: 'attempt 1', tool: 'flaky', args: { x: 1 } }),
    JSON.stringify({ thought: 'attempt 2', tool: 'flaky', args: { x: 1 } }),
    JSON.stringify({ final: 'done' }),
  ]);
  const result = await core.run({ openai, goal: 'g', tools: [flaky] });
  assert.equal(calls, 2, 'the retry re-invoked the handler — the error was not cached');
  const flakySteps = result.trace.filter((s) => s.tool === 'flaky');
  assert.ok(flakySteps.some((s) => s.observation && s.observation.text === 'recovered'), 'second attempt recovered');
});
