'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load the real bridge, agent entry, planner, executor, native client and
// canonical payload builder. Only transport, tools and telemetry are synthetic.
function harness({ env = {}, respond, react } = {}) {
  const root = path.resolve(__dirname, '../src/services');
  const cache = new Map();
  const calls = [];
  const clients = [];
  const queued = [];
  const records = [];
  const contexts = [];
  const syntheticEnv = { DEEPSEEK_API_KEY: 'synthetic-provider-token-000000', ...env };
  const noop = () => {};
  class FakeClient {
    constructor(options) {
      clients.push(options);
      this.chat = { completions: { create: async (params, options) => {
        calls.push({ params, options });
        if (respond) return respond(params, calls.length);
        const content = params.response_format?.type === 'json_object'
          ? JSON.stringify({ plan: [{ step: 1, goal: 'Respuesta sintética', tool_hint: null }], rationale: 'Prueba' })
          : 'Respuesta sintética';
        return { choices: [{ message: { role: 'assistant', content } }] };
      } } };
    }
  }
  const reactStub = { run: react || (async (client, opts) => {
    contexts.push(opts.ctx);
    await client.chat.completions.create({
      model: opts.model,
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }], reasoning_content: 'razonamiento sintético', content: '' },
        { role: 'tool', tool_call_id: 'call-1', content: 'observación sintética' },
      ],
      tools: [{ type: 'function', function: { name: 'finalize', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    }, { signal: opts.ctx.signal });
    return { finalAnswer: 'Respuesta sintética', stoppedReason: 'finalized', steps: [] };
  }) };
  const tool = { name: 'synthetic', description: 'Sintético', handler: noop };
  function load(relative) {
    const filename = path.resolve(root, relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const customRequire = (id) => {
      if (id === 'openai') return FakeClient;
      if (id.startsWith('node:') || id === 'crypto') return require(id);
      if (id.endsWith('/react-agent')) return reactStub;
      if (id === './agent-tools') return new Proxy({}, { get: () => tool });
      if (/clone-project-tool|host-bash-tool|host-file-tool|github-actions-tool/.test(id)) return {};
      if (id === './structured-logger') return { getLogger: () => ({ info: noop, warn: noop }) };
      if (id === './performance-tracer') return { getTracer: () => ({ start: () => ({ spanId: 'synthetic' }), end: noop }) };
      if (id === './task-tools') return { buildTaskTools: () => [] };
      if (id === './skill-runner') return { buildRunSkillTool: () => null, buildRunSkillPipelineTool: () => null };
      if (id === '../sira/context-compactor') return { compactContext: noop };
      if (id === './hermes-context-patterns') return {};
      if (['./hermes-memory-bridge', './cron/hermes-cron-bridge', './hermes-gateway-bridge', '../skills-registry', './hermes-playbook-bridge', './hermes-skill-curator', './hermes-biblioteca'].includes(id)) return {};
      if (id === '../model-catalog-manifest') return { listManifestModels: () => [] };
      if (id === './toolset-registry') return { resolveToolset: () => [], listToolsets: () => [] };
      if (id === './hermes-tools') return { buildHermesTools: () => [] };
      if (id === './agent-task-queue') return { enqueueAgentTask: async (payload) => { queued.push(JSON.parse(JSON.stringify(payload))); return { id: payload.taskId }; } };
      if (id === 'uuid') return { v4: () => 'synthetic-task' };
      if (id === './subagent-registry') return { createSubagentRegistry: () => ({ record: (item) => records.push(item), complete: noop }) };
      return load(path.relative(root, path.resolve(path.dirname(filename), id + '.js')));
    };
    const wrapper = vm.runInNewContext('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})', {
      process: { env: syntheticEnv }, URL, Object, console: { log: noop, warn: noop },
      setTimeout, clearTimeout, AbortController,
    }, { filename });
    wrapper(customRequire, module, module.exports);
    return module.exports;
  }
  return { load, calls, clients, queued, records, contexts };
}

test('Hermes default uses native Flash without an OpenAI key and preserves tool-call replay', async () => {
  const h = harness();
  const result = await h.load('agents/hermes-agent-bridge.js').runTurn({ userId: 'synthetic-owner', prompt: 'Prueba', learning: false });
  assert.equal(result.answer, 'Respuesta sintética');
  assert.equal(h.clients.length, 1);
  assert.equal(h.clients[0].baseURL, 'https://api.deepseek.com');
  const payload = h.calls[0].params;
  assert.equal(payload.model, 'deepseek-v4-flash');
  assert.equal(payload.thinking.type, 'enabled');
  assert.equal(payload.messages[0].reasoning_content, 'razonamiento sintético');
  assert.equal(payload.messages[1].tool_call_id, 'call-1');
  assert.equal(payload.tools[0].function.name, 'finalize');
});

for (const thinking of ['low', 'medium', 'high']) {
  test(`Hermes Sira Pro remains Pro in ${thinking} planning and execution`, async () => {
    const h = harness();
    await h.load('agents/hermes-agent-bridge.js').runTurn({ userId: 'synthetic-owner', prompt: 'Prueba', model: 'Sira Pro', thinking, learning: false });
    assert.ok(h.calls.length >= (thinking === 'low' ? 1 : 3));
    assert.ok(h.calls.every(({ params }) => params.model === 'deepseek-v4-pro'));
    assert.equal(h.contexts[0].model, 'deepseek-v4-pro');
    if (thinking !== 'low') assert.equal(h.calls[0].params.response_format.type, 'json_object');
  });
}

test('Hermes rejects foreign models and providers before constructing transport', async () => {
  for (const opts of [{ model: 'gpt-4o' }, { model: 'deepseek/deepseek-v4-pro' }, { model: 'deepseek-chat' }, { model: 'anything-pro' }, { model: 'Sira Pro', provider: 'openrouter' }]) {
    const h = harness();
    await assert.rejects(() => h.load('agents/hermes-agent-bridge.js').runTurn({ userId: 'synthetic-owner', prompt: 'Prueba', ...opts }), (err) => err.code === 'E_PARAMS' && !/gpt|deepseek|openrouter/i.test(err.message));
    assert.equal(h.clients.length, 0);
    assert.equal(h.calls.length, 0);
  }
});

test('Hermes fails closed for unavailable native credentials or a noncanonical endpoint', async () => {
  for (const env of [{ DEEPSEEK_API_KEY: '' }, { DEEPSEEK_BASE_URL: 'https://api.example.test' }, { DEEPSEEK_BASE_URL: 'https://api.deepseek.com/alternate' }]) {
    const h = harness({ env });
    await assert.rejects(() => h.load('agents/hermes-agent-bridge.js').runTurn({ userId: 'synthetic-owner', prompt: 'Prueba' }), (err) => err.code === 'E_PROVIDER' && !/https:|token|deepseek/i.test(err.message));
    assert.equal(h.calls.length, 0);
  }
});

test('Hermes ignores model tier overrides that would switch the selected provider model', async () => {
  const h = harness({ env: { AGENT_FLASH_MODEL: 'gpt-4o', AGENT_PRO_MODEL: 'other-pro' } });
  await h.load('agents/hermes-agent-bridge.js').runTurn({ userId: 'synthetic-owner', prompt: 'Prueba', model: 'Sira Pro', learning: false });
  assert.equal(h.calls[0].params.model, 'deepseek-v4-pro');
});

test('Hermes does not retry a permanent provider error or expose its diagnostic', async () => {
  const h = harness({ respond: () => { const err = new Error('synthetic private provider diagnostic'); err.status = 401; throw err; } });
  await assert.rejects(() => h.load('agents/hermes-agent-bridge.js').runTurn({ userId: 'synthetic-owner', prompt: 'Prueba', learning: false }), (err) => err.code === 'E_PROVIDER' && !err.message.includes('diagnostic'));
  assert.equal(h.calls.length, 1);
});

test('Hermes synchronous delegation preserves selected Pro instead of a generic default', async () => {
  const h = harness();
  const result = await h.load('agents/hermes-delegate-bridge.js').delegateTask({ userId: 'synthetic-owner', prompt: 'Prueba', model: 'deepseek-v4-pro', mode: 'sync' });
  assert.equal(result.ok, true);
  assert.equal(h.calls[0].params.model, 'deepseek-v4-pro');
});

test('Hermes asynchronous delegation fails visibly before queueing or inference', async () => {
  const h = harness();
  const result = await h.load('agents/hermes-delegate-bridge.js').delegateTask({ userId: 'synthetic-owner', prompt: 'Prueba', model: 'Sira Pro', mode: 'async', taskType: 'unrelated' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.queued.length, 0);
  assert.equal(h.records.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'async');
  assert.equal(result.reason, 'hermes_async_delegate_unavailable');
});

test('Hermes tool delegation inherits model, owner and cancellation from the parent context', async () => {
  const controller = new AbortController();
  const h = harness();
  const tool = h.load('agents/hermes-tools.js').hermesDelegateTool;
  const result = await tool.execute({ prompt: 'Prueba', mode: 'sync' }, {
    userId: 'synthetic-owner', model: 'deepseek-v4-pro', provider: 'deepseek', signal: controller.signal,
  });
  assert.equal(result.ok, true);
  assert.equal(h.calls[0].params.model, 'deepseek-v4-pro');
  assert.equal(h.calls[0].options.signal, controller.signal);
  assert.equal(h.contexts[0].userId, 'synthetic-owner');
});

test('Hermes does not report a swallowed ReAct provider failure as a successful run', async () => {
  const h = harness({ react: async () => ({ finalAnswer: '', stoppedReason: 'model_error: synthetic diagnostic', steps: [] }) });
  await assert.rejects(() => h.load('agents/hermes-agent-bridge.js').runTurn({ userId: 'synthetic-owner', prompt: 'Prueba' }), (err) => err.code === 'E_PROVIDER' && !err.message.includes('diagnostic'));
});

test('Hermes cancellation prevents a model call in planner modes too', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness();
  await assert.rejects(() => h.load('agents/hermes-agent-bridge.js').runTurn({ userId: 'synthetic-owner', prompt: 'Prueba', thinking: 'high', signal: controller.signal }), (err) => err.code === 'E_CANCELLED');
  assert.equal(h.calls.length, 0);
});

test('Hermes sync delegate validation resolves a safe error for the HTTP handler', async () => {
  const h = harness();
  const result = await h.load('agents/hermes-delegate-bridge.js').delegateTask({ userId: 'synthetic-owner', prompt: 'Prueba', model: 'gpt-4o', mode: 'sync' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_PARAMS');
  assert.equal(h.records.length, 0);
  assert.equal(h.calls.length, 0);
  assert.doesNotMatch(result.error, /gpt|openai|deepseek/i);
});

test('Hermes retries transient failures on the same selected native model', async () => {
  const h = harness({ respond: (_params, attempt) => {
    if (attempt === 1) { const err = new Error('synthetic outage'); err.status = 503; throw err; }
    return { choices: [{ message: { role: 'assistant', content: 'Respuesta' } }] };
  } });
  await h.load('agents/hermes-agent-bridge.js').runTurn({ userId: 'synthetic-owner', prompt: 'Prueba', model: 'Sira Pro', learning: false });
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(({ params }) => params.model === 'deepseek-v4-pro'));
  assert.equal(h.clients.length, 1);
});

test('Hermes cancellation interrupts a retry without switching clients', async () => {
  const controller = new AbortController();
  const h = harness({ respond: () => {
    controller.abort();
    const err = new Error('synthetic outage'); err.status = 503; throw err;
  } });
  await assert.rejects(() => h.load('agents/hermes-agent-bridge.js').runTurn({ userId: 'synthetic-owner', prompt: 'Prueba', signal: controller.signal }), (err) => err.code === 'E_CANCELLED');
  assert.equal(h.calls.length, 1);
  assert.equal(h.clients.length, 1);
});

test('Hermes surfaces planner-mode step and synthesis provider failures', async () => {
  for (const thinking of ['medium', 'high']) {
    for (const failure of ['step', 'synthesis']) {
      const h = harness({
        react: async () => ({
          finalAnswer: failure === 'step' ? '' : 'Respuesta sintética',
          stoppedReason: failure === 'step' ? 'model_error: synthetic diagnostic' : 'finalized',
          steps: [],
        }),
        respond: (params) => {
          if (params.response_format?.type === 'json_object') {
            return { choices: [{ message: { content: JSON.stringify({ plan: [{ step: 1, goal: 'Prueba', tool_hint: null }] }) } }] };
          }
          if (failure === 'synthesis') {
            const err = new Error('synthetic private diagnostic'); err.status = 401; throw err;
          }
          return { choices: [{ message: { content: 'Síntesis sintética' } }] };
        },
      });
      await assert.rejects(() => h.load('agents/hermes-agent-bridge.js').runTurn({
        userId: 'synthetic-owner', prompt: 'Prueba', thinking, model: 'Sira Pro',
      }), (err) => err.code === 'E_PROVIDER' && !err.message.includes('diagnostic'));
    }
  }
});
