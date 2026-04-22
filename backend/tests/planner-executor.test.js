/**
 * planner + executor tests — all stubbed, no real LLM calls.
 *
 * We drive both modules with a fake OpenAI client so the tests stay
 * deterministic and runnable offline. react-agent is the real module
 * (it handles the inner step) but we feed it tool stubs that return
 * fixed payloads.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const planner = require('../src/services/agents/planner');
const executor = require('../src/services/agents/executor');

// ─── Fake OpenAI factory ──────────────────────────────────────────────────

/**
 * Build a fake OpenAI client whose chat.completions.create returns a
 * scripted sequence of responses. Each call consumes the next script
 * entry. Exhausted scripts throw (so a missing stub surfaces loudly
 * instead of returning undefined).
 */
function fakeOpenAI(script) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async (params) => {
          if (i >= script.length) throw new Error(`fake openai: no script for call #${i + 1}`);
          const entry = script[i++];
          if (typeof entry === 'function') return entry(params);
          return entry;
        },
      },
    },
  };
}

function content(text) {
  return { choices: [{ message: { content: text, tool_calls: [] } }] };
}

function toolCallResp(name, args) {
  return {
    choices: [{
      message: {
        content: `calling ${name}`,
        tool_calls: [{ id: 'c1', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

// ─── Planner tests ────────────────────────────────────────────────────────

test('planner.plan parses a valid JSON plan', async () => {
  const openai = fakeOpenAI([
    content(JSON.stringify({
      plan: [
        { step: 1, goal: 'Find X', tool_hint: 'web_search' },
        { step: 2, goal: 'Summarise findings', tool_hint: null },
      ],
      rationale: 'two-phase because we need external data then synthesis',
    })),
  ]);
  const { plan, rationale } = await planner.plan(openai, { goal: 'Explain X', tools: [] });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].goal, 'Find X');
  assert.equal(plan[1].tool_hint, null);
  assert.match(rationale, /two-phase/);
});

test('planner normalises step numbers', async () => {
  const openai = fakeOpenAI([
    content(JSON.stringify({
      plan: [
        { step: 5, goal: 'ignore the 5, we renumber' },
        { step: 99, goal: 'still renumbered' },
      ],
    })),
  ]);
  const { plan } = await planner.plan(openai, { goal: 'g', tools: [] });
  assert.deepEqual(plan.map(s => s.step), [1, 2]);
});

test('planner rejects invalid shapes', async () => {
  const openai = fakeOpenAI([content(JSON.stringify({ plan: [] }))]);
  await assert.rejects(() => planner.plan(openai, { goal: 'g', tools: [] }), /empty plan/);

  const openai2 = fakeOpenAI([content(JSON.stringify({ plan: [{ goal: '' }] }))]);
  await assert.rejects(() => planner.plan(openai2, { goal: 'g', tools: [] }), /invalid "goal"/);
});

test('planner survives markdown-fenced JSON', async () => {
  const fenced = '```json\n' + JSON.stringify({ plan: [{ step: 1, goal: 'do a thing' }] }) + '\n```';
  const openai = fakeOpenAI([content(fenced)]);
  const { plan } = await planner.plan(openai, { goal: 'g', tools: [] });
  assert.equal(plan.length, 1);
});

test('planner truncates plans longer than MAX_STEPS', async () => {
  const tooMany = Array.from({ length: planner.MAX_STEPS + 5 }, (_, i) => ({
    step: i + 1, goal: `step ${i + 1}`, tool_hint: null,
  }));
  const openai = fakeOpenAI([content(JSON.stringify({ plan: tooMany }))]);
  const { plan } = await planner.plan(openai, { goal: 'g', tools: [] });
  assert.equal(plan.length, planner.MAX_STEPS);
});

// ─── Executor tests ───────────────────────────────────────────────────────

const stubTool = {
  name: 'web_search',
  description: 'fake',
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
  execute: async () => ({ sources: [{ title: 't', url: 'u', snippet: 's' }] }),
};

test('executor runs a 2-step plan and synthesises', async () => {
  const events = [];
  const openai = fakeOpenAI([
    // 1. Planner call
    content(JSON.stringify({
      plan: [
        { step: 1, goal: 'search for X', tool_hint: 'web_search' },
        { step: 2, goal: 'answer the user', tool_hint: null },
      ],
    })),
    // 2. Step 1 ReAct turn — model calls web_search
    toolCallResp('web_search', { q: 'X' }),
    // 3. Step 1 ReAct turn 2 — model finalises sub-answer
    toolCallResp('finalize', { answer: 'found evidence about X' }),
    // 4. Step 2 ReAct turn — straight to finalize (no tool)
    toolCallResp('finalize', { answer: 'summary of findings' }),
    // 5. Final synthesis
    content('## Answer\nSummary stitched from steps.'),
  ]);

  const result = await executor.run(openai, {
    goal: 'Explain X', tools: [stubTool], thinking: 'medium',
    onStep: (e) => events.push(e),
  });

  assert.match(result.finalAnswer, /Summary stitched/);
  assert.equal(result.stepResults.length, 2);
  assert.equal(result.replans, 0);
  const phases = events.map(e => e.phase);
  assert.ok(phases.includes('plan'));
  assert.ok(phases.includes('synthesis'));
});

test('shouldReplan flags empty answers and failure reasons', () => {
  assert.equal(executor.shouldReplan({ answer: '', stoppedReason: 'finalized' }), true);
  assert.equal(executor.shouldReplan({ answer: 'x'.repeat(50), stoppedReason: 'max_steps' }), true);
  assert.equal(executor.shouldReplan({ answer: 'legit answer here', stoppedReason: 'finalized' }), false);
  assert.equal(executor.shouldReplan(null), false);
});

test('executor falls back to last step if synthesis fails', async () => {
  const openai = fakeOpenAI([
    content(JSON.stringify({ plan: [{ step: 1, goal: 'do it', tool_hint: null }] })),
    toolCallResp('finalize', { answer: 'the only answer' }),
    // synthesis throws
    async () => { throw new Error('synthesis go boom'); },
  ]);
  const result = await executor.run(openai, { goal: 'g', tools: [stubTool], thinking: 'medium' });
  assert.equal(result.finalAnswer, 'the only answer');
  assert.match(result.stoppedReason, /synthesis_error/);
});
