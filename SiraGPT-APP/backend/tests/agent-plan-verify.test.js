'use strict';

// Claude-Code harness behaviours for the agentic chat loop:
//   1. update_plan — visible, updatable todo list pinned in the timeline
//      state (plan-then-execute).
//   2. createAnswerVerifier — evaluator-optimizer finalize guard: rejects a
//      bad draft ONCE with repair instructions, fail-open on errors, skips
//      trivial turns. composeFinalizeGuards chains rules → judge.
//   3. react-agent deferred tools — search_tools activates tools on demand;
//      activated tools join the schema on the next step.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const planVerify = require('../src/services/agents/agent-plan-verify');
const reactAgent = require('../src/services/react-agent');

const ENV_KEYS = ['SIRAGPT_AGENT_VERIFY', 'SIRAGPT_AGENT_VERIFY_TIMEOUT_MS'];
let savedEnv;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── update_plan ───────────────────────────────────────────────────────────

describe('createPlanTool', () => {
  function makeHarness() {
    const state = { steps: [], artifacts: [] };
    let emits = 0;
    const tool = planVerify.createPlanTool({
      getState: () => state,
      emit: async () => { emits += 1; },
    });
    return { state, tool, emitCount: () => emits };
  }

  test('first call pins a Plan step with the checklist as reasoning', async () => {
    const { state, tool, emitCount } = makeHarness();
    const out = await tool.execute({
      steps: [
        { title: 'Buscar fuentes', status: 'in_progress' },
        { title: 'Comparar resultados', status: 'pending' },
      ],
    });
    assert.equal(out.ok, true);
    const plan = state.steps.find((s) => s.id === planVerify.PLAN_STEP_ID);
    assert.ok(plan, 'plan step pinned in the timeline state');
    assert.equal(plan.status, 'running');
    assert.match(plan.reasoning, /▸ Buscar fuentes/);
    assert.match(plan.reasoning, /· Comparar resultados/);
    assert.equal(emitCount(), 1, 'sentinel re-emitted so the user sees it live');
  });

  test('updates IN PLACE and completes when every step is done', async () => {
    const { state, tool } = makeHarness();
    await tool.execute({ steps: [{ title: 'Paso 1', status: 'in_progress' }] });
    await tool.execute({ steps: [{ title: 'Paso 1', status: 'done' }] });
    const planSteps = state.steps.filter((s) => s.id === planVerify.PLAN_STEP_ID);
    assert.equal(planSteps.length, 1, 'one pinned plan step, not one per call');
    assert.equal(planSteps[0].status, 'done');
    assert.match(planSteps[0].reasoning, /✓ Paso 1/);
  });

  test('a broken state object never crashes the tool', async () => {
    const tool = planVerify.createPlanTool({
      getState: () => { throw new Error('boom'); },
      emit: async () => {},
    });
    const out = await tool.execute({ steps: [{ title: 'x', status: 'pending' }] });
    assert.equal(out.ok, true);
  });
});

// ── createAnswerVerifier ──────────────────────────────────────────────────

function judgeClient(replies) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (params) => {
      calls.push(params);
      const content = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return { choices: [{ message: { content } }] };
    } } },
  };
}

const LONG_QUERY = 'Compárame las tres mejores opciones de hosting para una app Next.js con base de datos.';
const LONG_ANSWER = 'X'.repeat(500);

describe('createAnswerVerifier', () => {
  test('rejects a failing draft ONCE with repair instructions, then passes', async () => {
    const openai = judgeClient(['{"pass": false, "problems": ["no compara opciones"], "fix": "Incluye la comparación pedida."}']);
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });

    const first = await guard({ answer: LONG_ANSWER });
    assert.equal(first.ok, false);
    assert.match(first.message, /no compara opciones/);
    assert.match(first.repairInstructions, /Incluye la comparación/);

    // Second finalize of the same run: bounded to one repair cycle.
    const second = await guard({ answer: LONG_ANSWER });
    assert.equal(second.ok, true);
    assert.equal(openai.calls.length, 1, 'judge runs once, not on the retry');
  });

  test('passing verdict and malformed verdict both let the answer through (fail-open)', async () => {
    for (const reply of ['{"pass": true, "problems": [], "fix": ""}', 'no json at all']) {
      const openai = judgeClient([reply]);
      const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
      assert.equal((await guard({ answer: LONG_ANSWER })).ok, true, reply);
    }
  });

  test('skips trivial turns without calling the judge', async () => {
    const openai = judgeClient(['{"pass": false}']);
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    assert.equal((await guard({ answer: 'corto' })).ok, true);
    assert.equal(openai.calls.length, 0);
  });

  test('SIRAGPT_AGENT_VERIFY=0 disables the judge entirely', async () => {
    process.env.SIRAGPT_AGENT_VERIFY = '0';
    const openai = judgeClient(['{"pass": false}']);
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    assert.equal((await guard({ answer: LONG_ANSWER })).ok, true);
    assert.equal(openai.calls.length, 0);
  });

  test('a throwing judge fails open', async () => {
    const openai = { chat: { completions: { create: async () => { throw new Error('upstream down'); } } } };
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    assert.equal((await guard({ answer: LONG_ANSWER })).ok, true);
  });
});

describe('composeFinalizeGuards', () => {
  test('null when nothing active; first failure wins; all-pass passes', async () => {
    assert.equal(planVerify.composeFinalizeGuards([null, undefined]), null);
    const failing = async () => ({ ok: false, message: 'rules failed' });
    const passing = async () => ({ ok: true });
    const chained = planVerify.composeFinalizeGuards([passing, failing, passing]);
    assert.equal((await chained({})).message, 'rules failed');
    const allPass = planVerify.composeFinalizeGuards([passing, passing]);
    assert.equal((await allPass({})).ok, true);
  });
});

// ── react-agent deferred tools (search_tools) ─────────────────────────────

function makeScriptedOpenAI(script) {
  let i = 0;
  let callId = 0;
  const sentParams = [];
  return {
    sentParams,
    chat: { completions: { create: async (params) => {
      sentParams.push(params);
      const entry = script[Math.min(i, script.length - 1)];
      i += 1;
      callId += 1;
      const toolCall = entry.finalize != null
        ? { id: `c${callId}`, type: 'function', function: { name: 'finalize', arguments: JSON.stringify({ answer: entry.finalize }) } }
        : { id: `c${callId}`, type: 'function', function: { name: entry.tool, arguments: JSON.stringify(entry.args || {}) } };
      return { choices: [{ message: { role: 'assistant', content: entry.thought || 'pensando', tool_calls: [toolCall] } }] };
    } } },
  };
}

describe('react-agent — deferred tools', () => {
  const coreTool = {
    name: 'web_search',
    description: 'search the web',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    execute: async () => ({ hits: ['a'] }),
  };
  const deferredTool = {
    name: 'create_chart',
    description: 'generate a bar/line chart image from data',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    executions: 0,
    execute: async function exec() { deferredTool.executions += 1; return { ok: true, url: '/chart.svg' }; },
  };

  test('deferred tool is NOT in the initial schema; search_tools is', async () => {
    const openai = makeScriptedOpenAI([{ finalize: 'listo' }]);
    await reactAgent.run(openai, { query: 'hola', tools: [coreTool], deferredTools: [deferredTool], maxSteps: 3 });
    const names = openai.sentParams[0].tools.map((t) => t.function.name);
    assert.ok(names.includes('web_search'));
    assert.ok(names.includes('search_tools'));
    assert.ok(!names.includes('create_chart'), 'deferred tool stays out of the schema');
  });

  test('search_tools activates matching tools; schema includes them next step; they execute', async () => {
    deferredTool.executions = 0;
    const openai = makeScriptedOpenAI([
      { tool: 'search_tools', args: { query: 'generate chart image' } },
      { tool: 'create_chart', args: { title: 'ventas' } },
      { finalize: 'hecho' },
    ]);
    const res = await reactAgent.run(openai, { query: 'haz un chart', tools: [coreTool], deferredTools: [deferredTool], maxSteps: 6 });
    assert.equal(res.stoppedReason, 'finalized');
    assert.equal(deferredTool.executions, 1, 'activated tool actually executed');

    const schemaAfter = openai.sentParams[1].tools.map((t) => t.function.name);
    assert.ok(schemaAfter.includes('create_chart'), 'schema refreshed with the activated tool');

    // The activation observation tells the model what it got.
    const searchStep = res.steps[0];
    const obs = searchStep.actions[0].observation;
    assert.equal(obs.activated[0].name, 'create_chart');
  });

  test('no-match query returns guidance instead of activating anything', async () => {
    const openai = makeScriptedOpenAI([
      { tool: 'search_tools', args: { query: 'zzzz qqqq' } },
      { finalize: 'ok' },
    ]);
    const res = await reactAgent.run(openai, { query: 'x', tools: [coreTool], deferredTools: [deferredTool], maxSteps: 4 });
    const obs = res.steps[0].actions[0].observation;
    assert.equal(obs.found, 0);
    assert.match(obs.note, /keyword/i);
  });

  test('without deferredTools the schema has no search_tools (zero overhead)', async () => {
    const openai = makeScriptedOpenAI([{ finalize: 'listo' }]);
    await reactAgent.run(openai, { query: 'hola', tools: [coreTool], maxSteps: 2 });
    const names = openai.sentParams[0].tools.map((t) => t.function.name);
    assert.ok(!names.includes('search_tools'));
  });
});
