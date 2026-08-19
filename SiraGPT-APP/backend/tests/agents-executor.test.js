/**
 * Tests for services/agents/executor.js — planner+executor loop.
 *
 * shouldReplan and constants are tested directly.
 * runStep / finalise / run use stubbed openai + planner + reactAgent
 * via require-cache injection.
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');

const PLANNER_PATH = require.resolve('../src/services/agents/planner');
const REACT_PATH = require.resolve('../src/services/react-agent');
const EXEC_PATH = require.resolve('../src/services/agents/executor');

// Dispatcher pattern so destructured / cached references see swaps.
const plannerMock = {
  _next: async () => ({ plan: [{ step: 1, goal: 'do thing', tool_hint: null }], rationale: 'because' }),
  plan: (...args) => plannerMock._next(...args),
};
const reactMock = {
  _next: async () => ({ finalAnswer: 'ok', stoppedReason: 'finalized', steps: [{}] }),
  run: (...args) => reactMock._next(...args),
};

let origPlanner, origReact, origExec;

function installMocks() {
  origPlanner = require.cache[PLANNER_PATH];
  origReact = require.cache[REACT_PATH];
  origExec = require.cache[EXEC_PATH];

  function entry(p, exports_) {
    const m = new Module(p);
    m.filename = p;
    m.loaded = true;
    m.exports = exports_;
    m.paths = Module._nodeModulePaths(path.dirname(p));
    return m;
  }
  require.cache[PLANNER_PATH] = entry(PLANNER_PATH, plannerMock);
  require.cache[REACT_PATH] = entry(REACT_PATH, reactMock);
  delete require.cache[EXEC_PATH];
}

function restoreMocks() {
  if (origPlanner) require.cache[PLANNER_PATH] = origPlanner;
  else delete require.cache[PLANNER_PATH];
  if (origReact) require.cache[REACT_PATH] = origReact;
  else delete require.cache[REACT_PATH];
  if (origExec) require.cache[EXEC_PATH] = origExec;
  else delete require.cache[EXEC_PATH];
}

let exec;

before(() => {
  installMocks();
  exec = require('../src/services/agents/executor');
});

after(() => {
  restoreMocks();
});

beforeEach(() => {
  plannerMock._next = async () => ({
    plan: [{ step: 1, goal: 'do thing', tool_hint: null }],
    rationale: 'because',
  });
  reactMock._next = async () => ({
    finalAnswer: 'ok', stoppedReason: 'finalized', steps: [{}],
  });
});

function fakeOpenAI(content) {
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content } }],
    })}},
  };
}

// ── constants ────────────────────────────────────────────────────

describe('constants', () => {
  it('DEFAULT_STEP_MAX_STEPS = 3', () => {
    assert.equal(exec.DEFAULT_STEP_MAX_STEPS, 3);
  });

  it('MAX_REPLANS = 2', () => {
    assert.equal(exec.MAX_REPLANS, 2);
  });
});

// ── shouldReplan ────────────────────────────────────────────────

describe('shouldReplan', () => {
  it('returns false for null/undefined', () => {
    assert.equal(exec.shouldReplan(null), false);
    assert.equal(exec.shouldReplan(undefined), false);
  });

  it('returns true when answer is empty', () => {
    assert.equal(exec.shouldReplan({ answer: '' }), true);
  });

  it('returns true when answer is <10 chars', () => {
    assert.equal(exec.shouldReplan({ answer: 'short' }), true);
  });

  it('returns false when answer is long enough and stoppedReason is fine', () => {
    assert.equal(exec.shouldReplan({
      answer: 'this is a perfectly fine answer to the sub-goal',
      stoppedReason: 'finalized',
    }), false);
  });

  it('returns true for known bad stoppedReason values', () => {
    for (const bad of ['max_steps', 'model_error', 'plain_text_finalize', 'no_message']) {
      assert.equal(exec.shouldReplan({
        answer: 'this answer is long enough to not trip the length gate',
        stoppedReason: bad,
      }), true);
    }
  });

  it('returns false for unknown stoppedReason when answer is fine', () => {
    assert.equal(exec.shouldReplan({
      answer: 'this is a perfectly fine answer to the sub-goal',
      stoppedReason: 'custom_stop',
    }), false);
  });
});

// ── runStep ─────────────────────────────────────────────────────

describe('runStep', () => {
  it('returns step metadata + answer from react-agent', async () => {
    reactMock._next = async () => ({
      finalAnswer: 'sub-goal done',
      stoppedReason: 'finalized',
      steps: [{}, {}],
    });
    const step = { step: 1, goal: 'do x' };
    const out = await exec.runStep({}, step, [], {}, { model: 'gpt-4o' });
    assert.equal(out.step, 1);
    assert.equal(out.goal, 'do x');
    assert.equal(out.answer, 'sub-goal done');
    assert.equal(out.stoppedReason, 'finalized');
    assert.equal(out.subSteps, 2);
  });

  it('emits onStep with phase=step when react-agent emits trace events', async () => {
    const traces = [];
    reactMock._next = async (_openai, { onStep }) => {
      onStep({ kind: 'thought', text: 't' });
      return { finalAnswer: 'ok', stoppedReason: 'finalized', steps: [] };
    };
    await exec.runStep({}, { step: 1, goal: 'g' }, [], {}, {
      onStep: (evt) => traces.push(evt),
    });
    assert.equal(traces.length, 1);
    assert.equal(traces[0].phase, 'step');
    assert.equal(traces[0].plan_step, 1);
    assert.deepEqual(traces[0].trace, { kind: 'thought', text: 't' });
  });

  it('default answer/subSteps when react-agent returns minimal payload', async () => {
    reactMock._next = async () => ({});
    const out = await exec.runStep({}, { step: 1, goal: 'g' }, [], {}, {});
    assert.equal(out.answer, '');
    assert.equal(out.subSteps, 0);
  });
});

// ── finalise ────────────────────────────────────────────────────

describe('finalise', () => {
  it('calls openai.chat.completions.create with synthesiser system prompt', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: 'final markdown answer' } }] };
      }}},
    };
    const out = await exec.finalise(openai, {
      goal: 'build something',
      stepResults: [
        { step: 1, goal: 'g1', answer: 'a1' },
        { step: 2, goal: 'g2', answer: 'a2' },
      ],
      model: 'gpt-4o',
    });
    assert.equal(out, 'final markdown answer');
    assert.match(captured.messages[0].content, /synthesiser/);
    assert.match(captured.messages[1].content, /Goal: build something/);
    assert.match(captured.messages[1].content, /Step 1 — g1/);
    assert.match(captured.messages[1].content, /a1/);
  });

  it('truncates each step answer to STEP_SUMMARY_CHARS (800)', async () => {
    let captured;
    const openai = {
      chat: { completions: { create: async (req) => {
        captured = req;
        return { choices: [{ message: { content: 'x' } }] };
      }}},
    };
    await exec.finalise(openai, {
      goal: 'g',
      stepResults: [{ step: 1, goal: 'g', answer: 'a'.repeat(2000) }],
      model: 'gpt-4o',
    });
    const userContent = captured.messages[1].content;
    // The "a"-block portion should be at most 800 chars.
    const aMatch = userContent.match(/(a+)/);
    assert.ok(aMatch[1].length <= 800);
  });

  it('trims trailing whitespace from the synthesiser output', async () => {
    const openai = fakeOpenAI('  final answer  \n\n');
    const out = await exec.finalise(openai, {
      goal: 'g', stepResults: [], model: 'gpt-4o',
    });
    assert.equal(out, 'final answer');
  });
});

// ── run · validation ────────────────────────────────────────────

describe('run · validation', () => {
  it('throws when openai missing', async () => {
    await assert.rejects(() => exec.run(null, { goal: 'g' }), /openai required/);
  });

  it('throws when goal missing', async () => {
    await assert.rejects(() => exec.run({}, {}), /goal required/);
  });
});

// ── run · happy path ────────────────────────────────────────────

describe('run · happy path', () => {
  it('runs every plan step and returns finalAnswer + plan + stepResults', async () => {
    plannerMock._next = async () => ({
      plan: [
        { step: 1, goal: 'find things', tool_hint: null },
        { step: 2, goal: 'compare them', tool_hint: null },
      ],
      rationale: 'two-step',
    });
    let stepNum = 0;
    reactMock._next = async () => {
      stepNum += 1;
      return {
        finalAnswer: `step-${stepNum} result`,
        stoppedReason: 'finalized',
        steps: [],
      };
    };
    const openai = fakeOpenAI('synthesised answer');
    const out = await exec.run(openai, { goal: 'do research' });
    assert.equal(out.finalAnswer, 'synthesised answer');
    assert.equal(out.plan.length, 2);
    assert.equal(out.stepResults.length, 2);
    assert.equal(out.stepResults[0].answer, 'step-1 result');
    assert.equal(out.stepResults[1].answer, 'step-2 result');
    assert.equal(out.replans, 0);
    assert.equal(out.stoppedReason, 'finalized');
  });

  it('emits phase=plan + phase=step + phase=synthesis events through onStep', async () => {
    const events = [];
    plannerMock._next = async () => ({
      plan: [{ step: 1, goal: 'single step' }], rationale: 'one',
    });
    const openai = fakeOpenAI('done');
    await exec.run(openai, {
      goal: 'g',
      onStep: (e) => events.push(e.phase),
    });
    assert.ok(events.includes('plan'));
    assert.ok(events.includes('synthesis'));
  });

  it('captures step error as stoppedReason="error: ..." without throwing', async () => {
    reactMock._next = async () => { throw new Error('step blew up'); };
    const openai = fakeOpenAI('best-effort final');
    const out = await exec.run(openai, { goal: 'g' });
    assert.match(out.stepResults[0].stoppedReason, /error: step blew up/);
    // Synthesis still runs.
    assert.equal(out.finalAnswer, 'best-effort final');
  });

  it('synthesis failure surfaces in stoppedReason and returns last step answer', async () => {
    const openai = {
      chat: { completions: { create: async () => { throw new Error('synth fail'); } } },
    };
    reactMock._next = async () => ({
      finalAnswer: 'last step said this',
      stoppedReason: 'finalized',
      steps: [],
    });
    const out = await exec.run(openai, { goal: 'g' });
    assert.equal(out.finalAnswer, 'last step said this');
    assert.match(out.stoppedReason, /synthesis_error: synth fail/);
  });

  it('thinking="high" with replan-trigger triggers a re-plan call', async () => {
    let plannerCalls = 0;
    plannerMock._next = async () => {
      plannerCalls += 1;
      if (plannerCalls === 1) {
        return {
          plan: [
            { step: 1, goal: 'first step text', tool_hint: null },
            { step: 2, goal: 'second step text', tool_hint: null },
          ],
          rationale: 'initial',
        };
      }
      return {
        plan: [{ step: 1, goal: 'corrected next step', tool_hint: null }],
        rationale: 'replanned',
      };
    };
    let stepNum = 0;
    reactMock._next = async () => {
      stepNum += 1;
      // First step yields a too-short answer to trigger shouldReplan.
      if (stepNum === 1) return { finalAnswer: 'no', stoppedReason: 'max_steps', steps: [] };
      return { finalAnswer: 'this is a fine answer', stoppedReason: 'finalized', steps: [] };
    };
    const openai = fakeOpenAI('final');
    const out = await exec.run(openai, { goal: 'g', thinking: 'high' });
    assert.equal(out.replans, 1);
    assert.equal(plannerCalls, 2);
  });

  it('thinking="medium" never re-plans even on bad step', async () => {
    plannerMock._next = async () => ({
      plan: [
        { step: 1, goal: 'first step text', tool_hint: null },
        { step: 2, goal: 'second step text', tool_hint: null },
      ],
      rationale: 'plan',
    });
    reactMock._next = async () => ({ finalAnswer: '', stoppedReason: 'max_steps', steps: [] });
    const openai = fakeOpenAI('final');
    const out = await exec.run(openai, { goal: 'g', thinking: 'medium' });
    assert.equal(out.replans, 0);
  });

  it('failures inside onStep do not break the run', async () => {
    plannerMock._next = async () => ({
      plan: [{ step: 1, goal: 'do thing right' }], rationale: 'r',
    });
    const openai = fakeOpenAI('done');
    const out = await exec.run(openai, {
      goal: 'g',
      onStep: () => { throw new Error('onStep crashed'); },
    });
    assert.equal(out.finalAnswer, 'done');
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const keys = Object.keys(exec).sort();
    assert.deepEqual(keys, [
      'DEFAULT_STEP_MAX_STEPS', 'MAX_REPLANS',
      'finalise', 'run', 'runStep', 'shouldReplan',
    ]);
  });
});
