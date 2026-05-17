/**
 * Tests for services/agents/planner.js — LLM-driven goal decomposer.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  plan,
  buildPlannerPrompt,
  validatePlan,
  extractJSON,
  MAX_STEPS,
  MIN_STEPS,
} = require('../src/services/agents/planner');

// ── constants ──────────────────────────────────────────────────

describe('constants', () => {
  it('MIN_STEPS = 1', () => {
    assert.equal(MIN_STEPS, 1);
  });

  it('MAX_STEPS = 8', () => {
    assert.equal(MAX_STEPS, 8);
  });
});

// ── buildPlannerPrompt ────────────────────────────────────────

describe('buildPlannerPrompt', () => {
  it('shows the "no tools" message when tools array is empty', () => {
    const out = buildPlannerPrompt([]);
    assert.match(out, /no tools available/);
  });

  it('lists each tool with name + description', () => {
    const out = buildPlannerPrompt([
      { name: 'web_search', description: 'search the web' },
      { name: 'calculator', description: 'do math' },
    ]);
    assert.match(out, /- web_search: search the web/);
    assert.match(out, /- calculator: do math/);
  });

  it('mentions STRICT JSON output', () => {
    assert.match(buildPlannerPrompt([]), /STRICT JSON/);
  });

  it('mentions the MIN..MAX step bounds', () => {
    const out = buildPlannerPrompt([]);
    assert.match(out, new RegExp(`${MIN_STEPS}.${MAX_STEPS} steps`));
  });

  it('forbids planner from calling tools itself', () => {
    assert.match(buildPlannerPrompt([]), /Do NOT call tools yourself/);
  });
});

// ── extractJSON ────────────────────────────────────────────────

describe('extractJSON', () => {
  it('returns null for null / non-string', () => {
    assert.equal(extractJSON(null), null);
    assert.equal(extractJSON(undefined), null);
    assert.equal(extractJSON(42), null);
  });

  it('parses bare JSON', () => {
    assert.deepEqual(extractJSON('{"a":1}'), { a: 1 });
  });

  it('strips json fence: ```json { ... } ```', () => {
    const raw = '```json\n{"a":2}\n```';
    assert.deepEqual(extractJSON(raw), { a: 2 });
  });

  it('strips bare fence: ``` { ... } ```', () => {
    const raw = '```\n{"a":3}\n```';
    assert.deepEqual(extractJSON(raw), { a: 3 });
  });

  it('handles leading/trailing whitespace in fenced JSON', () => {
    const raw = '   ```json\n  {"x":1}  \n```   ';
    assert.deepEqual(extractJSON(raw), { x: 1 });
  });

  it('returns null on malformed JSON (no fence)', () => {
    assert.equal(extractJSON('not json {'), null);
  });

  it('returns null on malformed JSON inside a fence', () => {
    assert.equal(extractJSON('```\nstill not json {\n```'), null);
  });
});

// ── validatePlan ──────────────────────────────────────────────

describe('validatePlan', () => {
  it('rejects null / non-object', () => {
    assert.deepEqual(validatePlan(null), { ok: false, reason: 'response missing "plan" array' });
  });

  it('rejects missing plan array', () => {
    const out = validatePlan({ rationale: 'x' });
    assert.equal(out.ok, false);
    assert.match(out.reason, /missing "plan" array/);
  });

  it('rejects non-array plan', () => {
    const out = validatePlan({ plan: 'not-array' });
    assert.equal(out.ok, false);
  });

  it('rejects empty plan', () => {
    const out = validatePlan({ plan: [] });
    assert.equal(out.ok, false);
    assert.match(out.reason, /empty plan/);
  });

  it('rejects step with missing/invalid goal (length >= 3 required)', () => {
    const okay = validatePlan({ plan: [
      { goal: 'first goal text', tool_hint: 't' },
      { goal: 'second goal text' },
    ]});
    assert.equal(okay.ok, true);

    const tooShort = validatePlan({ plan: [{ goal: 'fine' }, { goal: 'a' }] });
    assert.equal(tooShort.ok, false);
    assert.match(tooShort.reason, /step 2 missing\/invalid "goal"/);

    const missing = validatePlan({ plan: [{ goal: 'fine' }, {}] });
    assert.equal(missing.ok, false);
  });

  it('soft-truncates plans longer than MAX_STEPS', () => {
    const plan10 = Array.from({ length: 10 }, (_, i) => ({ goal: `step ${i + 1} text` }));
    const out = validatePlan({ plan: plan10 });
    assert.equal(out.ok, true);
    assert.equal(out.plan.plan.length, MAX_STEPS);
  });

  it('normalises step numbers regardless of caller-supplied values', () => {
    const out = validatePlan({ plan: [
      { goal: 'first goal', step: 99 },
      { goal: 'second goal', step: 0 },
      { goal: 'third goal' },
    ]});
    assert.equal(out.ok, true);
    assert.deepEqual(out.plan.plan.map(s => s.step), [1, 2, 3]);
  });

  it('coerces non-string tool_hint to null', () => {
    const out = validatePlan({ plan: [
      { goal: 'first goal', tool_hint: 42 },
      { goal: 'second goal', tool_hint: { not: 'string' } },
      { goal: 'third goal', tool_hint: 'web_search' },
    ]});
    assert.equal(out.ok, true);
    assert.equal(out.plan.plan[0].tool_hint, null);
    assert.equal(out.plan.plan[1].tool_hint, null);
    assert.equal(out.plan.plan[2].tool_hint, 'web_search');
  });

  it('preserves null/undefined tool_hint as null/undefined', () => {
    const out = validatePlan({ plan: [
      { goal: 'first goal', tool_hint: null },
    ]});
    assert.equal(out.plan.plan[0].tool_hint, null);
  });
});

// ── plan (LLM-driven) ─────────────────────────────────────────

describe('plan · validation', () => {
  it('throws when openai client is missing', async () => {
    await assert.rejects(
      () => plan(null, { goal: 'x' }),
      /openai client required/,
    );
  });

  it('throws when goal is missing', async () => {
    await assert.rejects(
      () => plan({}, {}),
      /goal required/,
    );
  });
});

describe('plan · happy paths', () => {
  function fakeOpenAI(content) {
    return {
      chat: {
        completions: {
          create: async function (req) {
            this.lastReq = req;
            return { choices: [{ message: { content } }], usage: { total_tokens: 250 } };
          },
        },
      },
    };
  }

  it('returns plan + rationale + rawTokens on success', async () => {
    const openai = fakeOpenAI(JSON.stringify({
      plan: [
        { goal: 'find articles about climate change' },
        { goal: 'summarise the top three' },
      ],
      rationale: 'two-stage retrieval + synthesis',
    }));
    const out = await plan(openai, { goal: 'tell me about climate', tools: [] });
    assert.equal(out.plan.length, 2);
    assert.equal(out.rationale, 'two-stage retrieval + synthesis');
    assert.equal(out.rawTokens, 250);
  });

  it('throws on invalid plan response', async () => {
    const openai = fakeOpenAI('{"not_a_plan": true}');
    await assert.rejects(
      () => plan(openai, { goal: 'x' }),
      /invalid response/,
    );
  });

  it('throws on unparseable response', async () => {
    const openai = fakeOpenAI('not json at all');
    await assert.rejects(
      () => plan(openai, { goal: 'x' }),
      /invalid response/,
    );
  });

  it('normalises step numbers in the returned plan', async () => {
    const openai = fakeOpenAI(JSON.stringify({
      plan: [
        { goal: 'first sub-task', step: 99 },
        { goal: 'second sub-task', step: 7 },
      ],
    }));
    const out = await plan(openai, { goal: 'x' });
    assert.deepEqual(out.plan.map(s => s.step), [1, 2]);
  });

  it('rationale defaults to "" when LLM omits it', async () => {
    const openai = fakeOpenAI(JSON.stringify({
      plan: [{ goal: 'something' }],
    }));
    const out = await plan(openai, { goal: 'x' });
    assert.equal(out.rationale, '');
  });

  it('sends response_format=json_object + temperature=0.2', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: '{"plan":[{"goal":"x text"}]}' } }] };
      }}},
    };
    await plan(openai, { goal: 'x' });
    assert.equal(captured.response_format.type, 'json_object');
    assert.equal(captured.temperature, 0.2);
  });

  it('re-plan mode: when context is given, builds a follow-up user message', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: '{"plan":[{"goal":"continue work"}]}' } }] };
      }}},
    };
    const context = { completedSteps: [{ step: 1, result: 'done' }] };
    await plan(openai, { goal: 'big-goal', context });
    const userMsg = captured.messages.find(m => m.role === 'user').content;
    assert.match(userMsg, /Original goal: big-goal/);
    assert.match(userMsg, /Progress so far/);
    assert.match(userMsg, /completedSteps/);
  });

  it('without context, user message is just the goal', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: '{"plan":[{"goal":"do thing"}]}' } }] };
      }}},
    };
    await plan(openai, { goal: 'simple goal' });
    const userMsg = captured.messages.find(m => m.role === 'user').content;
    assert.equal(userMsg, 'simple goal');
  });

  it('forwards model param to chat.completions', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: '{"plan":[{"goal":"plan step"}]}' } }] };
      }}},
    };
    await plan(openai, { goal: 'x', model: 'custom-model' });
    assert.equal(captured.model, 'custom-model');
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/planner');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'MAX_STEPS', 'MIN_STEPS', 'buildPlannerPrompt', 'extractJSON',
      'plan', 'validatePlan',
    ]);
  });
});
