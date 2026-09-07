'use strict';

// Claude-Code harness behaviours for the agentic chat loop:
//   1. update_plan — visible, updatable todo list pinned in the timeline
//      state (plan-then-execute).
//   2. createAnswerVerifier — evaluator-optimizer finalize guard: rejects a
//      bad drafts with bounded repair, fails closed on missing evidence, and
//      skips initially trivial turns. composeFinalizeGuards chains rules → judge.
//   3. react-agent deferred tools — search_tools activates tools on demand;
//      activated tools join the schema on the next step.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { getEventListeners } = require('node:events');

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
  test('reuses a rejection for the identical draft and reviews its repair before approving', async () => {
    const openai = judgeClient(['{"pass": false, "problems": ["no compara opciones"], "fix": "Incluye la comparación pedida."}', '{"pass":true}']);
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });

    const first = await guard({ answer: LONG_ANSWER });
    assert.equal(first.ok, false);
    assert.match(first.message, /no compara opciones/);
    assert.match(first.repairInstructions, /Incluye la comparación/);

    const second = await guard({ answer: LONG_ANSWER });
    assert.equal(second.ok, false);
    assert.equal(openai.calls.length, 1, 'an unchanged draft does not consume another review');
    const repaired = await guard({ answer: LONG_ANSWER + ' repaired' });
    assert.equal(repaired.ok, true);
    assert.equal(openai.calls.length, 2);
  });

  test('only an explicit boolean passing verdict approves the answer', async () => {
    for (const reply of ['{"pass": true, "problems": [], "fix": ""}', 'no json at all', '{}', '{"pass":"true"}', '{"pass":1}']) {
      const openai = judgeClient([reply]);
      const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
      assert.equal((await guard({ answer: LONG_ANSWER })).ok, reply.startsWith('{"pass": true,'), reply);
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

  test('a throwing judge fails closed without exposing its raw provider error', async () => {
    const openai = { chat: { completions: { create: async () => { throw new Error('SYNTHETIC_PRIVATE_PROVIDER_DETAIL'); } } } };
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    const verdict = await guard({ answer: LONG_ANSWER });
    assert.equal(verdict.ok, false);
    assert.match(verdict.code, /^E_VERIFICATION_/);
    assert.doesNotMatch(JSON.stringify(verdict), /SYNTHETIC_PRIVATE_PROVIDER_DETAIL/);
  });

  test('at most two different candidates are reviewed and approval never transfers to a third', async () => {
    const openai = judgeClient(['{"pass":true}']);
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    assert.equal((await guard({ answer: LONG_ANSWER })).ok, true);
    assert.equal((await guard({ answer: LONG_ANSWER + ' second' })).ok, true);
    const third = await guard({ answer: LONG_ANSWER + ' third' });
    assert.equal(third.ok, false);
    assert.match(third.code, /^E_VERIFICATION_/);
    assert.equal(openai.calls.length, 2);
  });

  test('shortening a previously rejected draft does not activate the trivial-turn bypass', async () => {
    const openai = judgeClient(['{"pass":false}']);
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    assert.equal((await guard({ answer: LONG_ANSWER })).ok, false);
    assert.equal((await guard({ answer: 'Listo.' })).ok, false);
    assert.equal(openai.calls.length, 2, 'the changed short draft still requires a verdict');
  });

  test('evidence changes invalidate approval; arbitrary call IDs and finalize retries do not', async () => {
    const openai = judgeClient(['{"pass":true}', '{"pass":false}']);
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    const steps = [{ step: 0, actions: [{ id: 'id-a', tool: 'read_file', args: '{}', observation: { ok: true, value: 'old' } }] }];
    assert.equal((await guard({ answer: LONG_ANSWER, steps })).ok, true);
    const retried = structuredClone(steps);
    retried[0].actions[0].id = 'id-b';
    retried.push({ step: 1, actions: [{ tool: 'finalize', args: '{}', observation: { error: 'rejected' } }] });
    assert.equal((await guard({ answer: LONG_ANSWER, steps: retried })).ok, true);
    assert.equal(openai.calls.length, 1);
    retried[0].actions[0].observation.value = 'new';
    assert.equal((await guard({ answer: LONG_ANSWER, steps: retried })).ok, false);
    assert.equal(openai.calls.length, 2);
  });

  test('removing tool evidence invalidates an earlier passing verdict', async () => {
    const openai = judgeClient(['{"pass":true}', '{"pass":false}']);
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    assert.equal((await guard({ answer: LONG_ANSWER, steps: [{ actions: [{ tool: 'verify_artifact', observation: { ok: true } }] }] })).ok, true);
    assert.equal((await guard({ answer: LONG_ANSWER, steps: [] })).ok, false);
    assert.equal(openai.calls.length, 2);
  });

  test('evidence outside the bounded judge excerpt still invalidates cached approval', async () => {
    const openai = judgeClient(['{"pass":true}', '{"pass":false}']);
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    const steps = [{ actions: [{ tool: 'read_file', args: '{}', observation: { value: 'x'.repeat(9000), last: 'old' } }] }];
    assert.equal((await guard({ answer: LONG_ANSWER, steps })).ok, true);
    steps[0].actions[0].observation.last = 'changed';
    assert.equal((await guard({ answer: LONG_ANSWER, steps })).ok, false);
    assert.equal(openai.calls.length, 2);
    assert.ok(openai.calls.every(call => call.messages[1].content.length < 9000), 'review input stays bounded');
  });

  test('malformed or oversized evidence fails closed before payment and cannot enable a short-draft bypass', async () => {
    const cycle = {};
    cycle.self = cycle;
    for (const steps of [
      {},
      [{ actions: {} }],
      [{ actions: [null] }],
      [{ actions: [{ tool: 'read_file', observation: cycle }] }],
      [{ actions: [{ tool: 'read_file', observation: 'x'.repeat(1024 * 1024) }] }],
      [{ actions: Array.from({ length: 1025 }, () => ({ tool: 'read_file' })) }],
    ]) {
      const openai = judgeClient(['{"pass":false}']);
      const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
      const verdict = await guard({ answer: LONG_ANSWER, steps });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.code, 'E_VERIFICATION_EVIDENCE');
      assert.equal(openai.calls.length, 0);
      assert.equal((await guard({ answer: 'Listo.' })).ok, false);
      assert.equal(openai.calls.length, 1, 'a shortened draft still requires a valid review');
    }
  });

  test('the caller cannot mutate a cached rejection into an approval', async () => {
    const openai = judgeClient(['{"pass":false}']);
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    const first = await guard({ answer: LONG_ANSWER });
    first.ok = true;
    assert.equal((await guard({ answer: LONG_ANSWER })).ok, false);
    assert.equal(openai.calls.length, 1);
  });

  test('concurrent identical reviews share one in-flight request', async () => {
    let calls = 0;
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const openai = { chat: { completions: { create: async () => { calls++; return waiting; } } } };
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    const first = guard({ answer: LONG_ANSWER });
    const second = guard({ answer: LONG_ANSWER });
    await nextTurn();
    release({ choices: [{ message: { content: '{"pass":true}' } }] });
    const verdicts = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.ok(verdicts.every(verdict => verdict.ok === true));
  });

  test('concurrent changed candidates cannot exceed the two-call budget', async () => {
    let calls = 0;
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const openai = { chat: { completions: { create: async () => { calls++; return waiting; } } } };
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    const first = guard({ answer: LONG_ANSWER });
    const second = guard({ answer: LONG_ANSWER + ' second' });
    const third = await guard({ answer: LONG_ANSWER + ' third' });
    release({ choices: [{ message: { content: '{"pass":true}' } }] });
    const verdicts = await Promise.all([first, second]);
    assert.equal(third.ok, false);
    assert.equal(third.code, 'E_VERIFICATION_BUDGET');
    assert.equal(calls, 2);
    assert.ok(verdicts.every(verdict => verdict.ok === true));
  });

  test('Stop cancels a duplicate waiter without needing the shared SDK request to settle', async () => {
    const controller = new AbortController();
    let calls = 0;
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const openai = { chat: { completions: { create: async () => { calls++; return waiting; } } } };
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    const first = guard({ answer: LONG_ANSWER });
    const second = guard({ answer: LONG_ANSWER, ctx: { signal: controller.signal } });
    controller.abort();
    const cancelled = await second;
    release({ choices: [{ message: { content: '{"pass":true}' } }] });
    assert.equal((await first).ok, true);
    assert.equal(cancelled.code, 'E_CANCELLED');
    assert.equal(calls, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  test('Stop prevents a review even if that draft already has a cached approval', async () => {
    const openai = judgeClient(['{"pass":true}']);
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    assert.equal((await guard({ answer: LONG_ANSWER })).ok, true);
    const controller = new AbortController();
    controller.abort();
    const verdict = await guard({ answer: LONG_ANSWER, ctx: { signal: controller.signal } });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'E_CANCELLED');
    assert.equal(openai.calls.length, 1);
  });

  test('a non-cooperative judge reaches a real timeout, cleans up, and observes its late rejection', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    let rejectRequest;
    let requestSignal;
    const waiting = new Promise((_resolve, reject) => { rejectRequest = reject; });
    const openai = { chat: { completions: { create: async (_params, options) => { requestSignal = options.signal; return waiting; } } } };
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    let settled = false;
    const reviewing = guard({ answer: LONG_ANSWER, ctx: { signal: controller.signal } }).then(verdict => { settled = true; return verdict; });
    await nextTurn();
    t.mock.timers.tick(12_001);
    await nextTurn();
    const timedOutWithoutCooperation = settled;
    rejectRequest(new Error('SYNTHETIC_LATE_ERROR'));
    const verdict = await reviewing;
    await nextTurn();
    assert.equal(timedOutWithoutCooperation, true, 'must settle without waiting for the SDK to honor abort');
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'E_VERIFICATION_TIMEOUT');
    assert.equal(requestSignal.aborted, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  test('parent Stop settles a non-cooperative review and removes its abort listener', async () => {
    const controller = new AbortController();
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const openai = { chat: { completions: { create: async () => waiting } } };
    const guard = planVerify.createAnswerVerifier({ openai, model: 'gpt-test', userQuery: LONG_QUERY });
    let settled = false;
    const reviewing = guard({ answer: LONG_ANSWER, ctx: { signal: controller.signal } }).then(verdict => { settled = true; return verdict; });
    await nextTurn();
    controller.abort();
    await nextTurn();
    const cancelledWithoutCooperation = settled;
    release({ choices: [{ message: { content: '{"pass":true}' } }] });
    const verdict = await reviewing;
    assert.equal(cancelledWithoutCooperation, true);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'E_CANCELLED');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  test('a successful review removes its timer and parent abort listener', async t => {
    const pendingTimers = new Set();
    const nativeSetTimeout = global.setTimeout;
    const nativeClearTimeout = global.clearTimeout;
    t.mock.method(global, 'setTimeout', (fn, ms) => {
      const id = nativeSetTimeout(fn, ms);
      pendingTimers.add(id);
      return id;
    });
    t.mock.method(global, 'clearTimeout', id => { pendingTimers.delete(id); return nativeClearTimeout(id); });
    const controller = new AbortController();
    const guard = planVerify.createAnswerVerifier({ openai: judgeClient(['{"pass":true}']), model: 'gpt-test', userQuery: LONG_QUERY });
    assert.equal((await guard({ answer: LONG_ANSWER, ctx: { signal: controller.signal } })).ok, true);
    assert.equal(pendingTimers.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
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

  test('only strict boolean ok:true passes a single guard or a composed chain', async () => {
    for (const verdict of [undefined, null, {}, { ok: 'false' }, { ok: 1 }]) {
      for (const guards of [[async () => verdict], [async () => ({ ok: true }), async () => verdict]]) {
        const result = await planVerify.composeFinalizeGuards(guards)({});
        assert.equal(result.ok, false);
        assert.match(result.code, /^E_VERIFICATION_/);
      }
    }
  });

  test('a throwing guard stops the chain with a safe failure code', async () => {
    let later = 0;
    const guard = planVerify.composeFinalizeGuards([
      async () => { throw new Error('SYNTHETIC_PRIVATE_GUARD_DETAIL'); },
      async () => { later++; return { ok: true }; },
    ]);
    const result = await guard({});
    assert.equal(result.ok, false);
    assert.match(result.code, /^E_VERIFICATION_/);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_GUARD_DETAIL/);
    assert.equal(later, 0);
  });

  test('Stop between guards prevents a later guard or a cached approval from succeeding', async () => {
    const controller = new AbortController();
    let later = 0;
    const guard = planVerify.composeFinalizeGuards([
      async () => { controller.abort(); return { ok: true }; },
      async () => { later++; return { ok: true }; },
    ]);
    const result = await guard({ ctx: { signal: controller.signal } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_CANCELLED');
    assert.equal(later, 0);
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
