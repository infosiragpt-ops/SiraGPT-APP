'use strict';

// AgentRunner: a tool call cut at the output limit (finish_reason 'length')
// used to kill the whole turn with E_PROVIDER on the first large
// execute_python script. The loop now retries once with a larger output
// budget, then once at the original budget asking the model to split the
// work, and only then fails. A length-stopped call is never executed, and
// the split nudge never reaches the runner's own transcript. Offline.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { runAgentLoop, callModel } = require('../src/services/agent-runner/loop');
const { resolveModelCapabilities } = require('../src/services/agent-harness/model-capabilities');
const { createFailoverClient } = require('../src/services/doc-agent/llm-runtime');
const billing = require('../src/services/ai/billing-failover');
const keyHealth = require('../src/utils/provider-key-health');

afterEach(() => {
  billing.__resetForTests();
  keyHealth.clear();
});

const PY_TOOL = [{ type: 'function', function: { name: 'execute_python', parameters: { type: 'object', properties: { code: { type: 'string' } } } } }];

function truncated(id = 'cut_1', usage = undefined) {
  return {
    choices: [{
      finish_reason: 'length',
      message: { content: null, tool_calls: [{ id, type: 'function', function: { name: 'execute_python', arguments: '{"code":"print(1)"}' } }] },
    }],
    ...(usage ? { usage } : {}),
  };
}

function completeCall(id = 'call_ok') {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      message: { content: null, tool_calls: [{ id, type: 'function', function: { name: 'execute_python', arguments: '{"code":"print(2)"}' } }] },
    }],
  };
}

const FINAL = { choices: [{ finish_reason: 'stop', message: { content: 'Listo.' } }] };

function scripted(steps, log) {
  let i = 0;
  return {
    chat: { completions: { create: async (payload) => {
      log.push(JSON.parse(JSON.stringify(payload)));
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step(payload) : step;
    } } },
  };
}

function limitOf(payload) {
  return payload.max_tokens ?? payload.max_completion_tokens;
}

function captureWarn() {
  const lines = [];
  const original = console.warn;
  console.warn = (...parts) => lines.push(parts.join(' '));
  return { lines, restore: () => { console.warn = original; } };
}

test('a cut tool call is retried once with a larger budget and then runs exactly once', async () => {
  const log = [];
  let executions = 0;
  const messages = [{ role: 'user', content: 'Crea un Excel con 500 filas' }];
  const result = await runAgentLoop({
    client: scripted([truncated(), completeCall(), FINAL], log),
    model: 'deepseek-v4-flash',
    messages,
    tools: PY_TOOL,
    executors: { execute_python: async () => { executions += 1; return 'ok'; } },
    maxIterations: 4,
  });
  assert.notEqual(result.stoppedReason, 'E_PROVIDER', 'the turn survives the truncation');
  assert.equal(executions, 1, 'only the complete call executes');
  const ceiling = resolveModelCapabilities('deepseek-v4-flash').maxOutputTokens;
  assert.ok(limitOf(log[1]) > limitOf(log[0]), 'the retry asks for a larger output budget');
  assert.ok(limitOf(log[1]) <= ceiling, 'never above the model output ceiling');
  assert.equal(log[1].messages.length, log[0].messages.length, 'the budget retry sends the same transcript');
  assert.equal(messages.some((m) => m.tool_calls && m.tool_calls.some((c) => c.id === 'cut_1')), false,
    'the cut call never enters the transcript');
});

test('a native OpenAI model escalates max_completion_tokens', async () => {
  const log = [];
  await callModel({
    client: scripted([truncated(), completeCall()], log),
    model: 'gpt-6-sol',
    messages: [{ role: 'user', content: 'Crea un Excel' }],
    tools: PY_TOOL,
    maxTokens: 2048,
  });
  assert.equal(log[0].max_completion_tokens, 2048);
  assert.ok(log[1].max_completion_tokens > 2048);
  assert.equal('max_tokens' in log[1], false);
});

test('a refused larger reservation falls back to the split request and never marks the provider unfunded', async () => {
  const log = [];
  const reservation = Object.assign(new Error('This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 3000.'), { status: 402 });
  const client = createFailoverClient([{ provider: 'DeepSeek', model: 'deepseek-v4-flash', apiKey: 'synthetic-ds-key' }], {
    createClient: () => scripted([truncated(), reservation, completeCall(), FINAL], log),
  });
  const messages = [{ role: 'user', content: 'Crea un Excel con 500 filas' }];
  let executions = 0;
  const result = await runAgentLoop({
    client,
    model: 'deepseek-v4-flash',
    messages,
    tools: PY_TOOL,
    executors: { execute_python: async () => { executions += 1; return 'ok'; } },
    maxIterations: 4,
  });
  assert.notEqual(result.stoppedReason, 'E_PROVIDER');
  assert.equal(executions, 1);
  assert.equal(limitOf(log[1]), 4096, 'escalated reservation');
  assert.equal(limitOf(log[2]), 2048, 'the split request uses the original budget');
  const nudge = log[2].messages[log[2].messages.length - 1];
  assert.equal(nudge.role, 'user');
  assert.match(nudge.content, /Tu llamada anterior a execute_python se cortó por el límite de salida/);
  assert.match(nudge.content, /write_file \(≤150 líneas por parte\)/);
  assert.equal(messages.some((m) => typeof m.content === 'string' && m.content.includes('se cortó por el límite de salida')), false,
    'the nudge is ephemeral: it never lands in the runner transcript');
  assert.equal(billing.isOutOfCredit('DeepSeek'), false, 'a reservation-size 402 is not an empty account');
});

test('an always-truncating model fails with E_PROVIDER after at most three calls and zero executions', async () => {
  const log = [];
  const client = {
    ...scripted([truncated('cut_x', { completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 3100 } })], log),
    describe: () => ({ provider: 'DeepSeek', model: 'deepseek-v4-flash', failovers: [] }),
  };
  let executions = 0;
  const events = [];
  const cap = captureWarn();
  let result;
  try {
    result = await runAgentLoop({
      client,
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Crea un Excel' }],
      tools: PY_TOOL,
      executors: { execute_python: async () => { executions += 1; return 'ok'; } },
      maxIterations: 2,
      onEvent: (e) => events.push(e),
    });
  } finally {
    cap.restore();
  }
  assert.equal(result.stoppedReason, 'E_PROVIDER');
  assert.equal(executions, 0);
  assert.ok(log.length <= 3, `model called ${log.length} times`);
  assert.match(result.errorMessage, /se cortó antes de completar una herramienta/);
  const diag = cap.lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .find((l) => l && l.event === 'selected_model_failure');
  assert.ok(diag, 'one structured diagnostic');
  assert.equal(diag.origin, 'tool_call_truncated');
  assert.equal(diag.category, 'truncated');
  assert.equal(diag.provider, 'DeepSeek', 'provider comes from the client descriptor');
  assert.equal(typeof diag.budget, 'number');
  assert.equal(diag.reasoningTokens, 3100);
  assert.doesNotMatch(JSON.stringify(diag), /print\(1\)/, 'no tool arguments in the log');
});

test('callModel surfaces the truncation error with provider, budget and reasoning tokens', async () => {
  const log = [];
  const client = {
    ...scripted([truncated('cut_y', { completion_tokens_details: { reasoning_tokens: 900 } })], log),
    describe: () => ({ provider: 'Gemini' }),
  };
  await assert.rejects(
    () => callModel({ client, model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], tools: PY_TOOL, maxTokens: 2048 }),
    (err) => {
      assert.equal(err.code, 'E_PROVIDER');
      assert.equal(err.failureOrigin, 'tool_call_truncated');
      assert.equal(err.failureProvider, 'Gemini');
      assert.equal(err.budget, 4096, 'the largest budget that still cut');
      assert.equal(err.reasoningTokens, 900);
      return true;
    },
  );
  assert.equal(log.length, 3);
});

test('no escalation when the model ceiling is already the budget: split request only', async () => {
  const log = [];
  await assert.rejects(() => callModel({
    client: scripted([truncated()], log),
    model: 'test/model',
    messages: [{ role: 'user', content: 'x' }],
    tools: PY_TOOL,
    maxTokens: 4096,
  }), { code: 'E_PROVIDER', failureOrigin: 'tool_call_truncated' });
  assert.equal(log.length, 2);
  assert.deepEqual(log.map(limitOf), [4096, 4096]);
});

test('SIRAGPT_AGENT_RUNNER_TRUNCATION_MAX_TOKENS caps the escalation', async () => {
  const prev = process.env.SIRAGPT_AGENT_RUNNER_TRUNCATION_MAX_TOKENS;
  process.env.SIRAGPT_AGENT_RUNNER_TRUNCATION_MAX_TOKENS = '3000';
  try {
    const log = [];
    await callModel({
      client: scripted([truncated(), completeCall()], log),
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'x' }],
      tools: PY_TOOL,
      maxTokens: 2048,
    });
    assert.equal(limitOf(log[1]), 3000);
  } finally {
    if (prev === undefined) delete process.env.SIRAGPT_AGENT_RUNNER_TRUNCATION_MAX_TOKENS;
    else process.env.SIRAGPT_AGENT_RUNNER_TRUNCATION_MAX_TOKENS = prev;
  }
});

test('a Stop during the budget retry is not swallowed', async () => {
  const controller = new AbortController();
  const log = [];
  const client = scripted([
    truncated(),
    () => { controller.abort(); throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }); },
    completeCall(),
  ], log);
  await assert.rejects(() => callModel({
    client,
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'x' }],
    tools: PY_TOOL,
    maxTokens: 2048,
    signal: controller.signal,
  }), /aborted/i);
  assert.equal(log.length, 2, 'no split request after the user stopped');
});
