'use strict';

// Document agent LLM runtime: provider ladder + per-call failover. Offline.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const rt = require('../src/services/doc-agent/llm-runtime');
const { runDocAgentLoop } = require('../src/services/doc-agent/loop');
const { callModel, runAgentLoop } = require('../src/services/agent-runner/loop');

const ALL_KEYS = {
  DEEPSEEK_API_KEY: 'ds',
  MODEL_API_KEY: 'meta',
  GEMINI_API_KEY: 'gem',
  XAI_API_KEY: 'xai',
  OPENROUTER_API_KEY: 'or',
  OPENAI_API_KEY: 'oa',
};

function httpError(status, message) {
  const err = new Error(message || `HTTP ${status}`);
  err.status = status;
  return err;
}

function scriptedFactory(behaviour, log = []) {
  return (candidate) => ({
    chat: {
      completions: {
        create: async (payload) => {
          log.push({ provider: candidate.provider, model: payload.model, extra: payload.reasoning_effort || null });
          const b = behaviour[candidate.provider];
          if (typeof b === 'function') return b(payload);
          if (b instanceof Error) throw b;
          return { choices: [{ message: { content: `ok from ${candidate.provider}` } }] };
        },
      },
    },
  });
}

describe('provider inference + model spec', () => {
  test('bare ids map to their first-party provider; slugs to OpenRouter', () => {
    assert.equal(rt.inferProvider('deepseek-chat'), 'DeepSeek');
    assert.equal(rt.inferProvider('muse-spark-1.2'), 'Meta');
    assert.equal(rt.inferProvider('gemini-3.5-flash'), 'Gemini');
    assert.equal(rt.inferProvider('grok-4.5'), 'xAI');
    assert.equal(rt.inferProvider('gpt-5.6-sol'), 'OpenAI');
    assert.equal(rt.inferProvider('deepseek/deepseek-v4-pro'), 'OpenRouter');
    assert.equal(rt.inferProvider('sira-mini'), null);
  });

  test('"Provider:model" specs win over inference', () => {
    assert.deepEqual(rt.parseModelSpec('Gemini:gemini-3.5-pro'), { provider: 'Gemini', model: 'gemini-3.5-pro' });
    assert.deepEqual(rt.parseModelSpec('xai:grok-4.6'), { provider: 'xAI', model: 'grok-4.6' });
    assert.deepEqual(rt.parseModelSpec('deepseek/deepseek-v4-pro'), { provider: 'OpenRouter', model: 'deepseek/deepseek-v4-pro' });
    assert.equal(rt.parseModelSpec(''), null);
  });
});

describe('candidate ladder', () => {
  test('an explicitly selected document model is pinned to its own API', () => {
    const selected = rt.resolveDocAgentRunCandidates({ model: 'DeepSeek:deepseek-v4-pro', env: ALL_KEYS });
    assert.deepEqual(selected.map((entry) => [entry.provider, entry.model]), [['DeepSeek', 'deepseek-v4-pro']]);
    const pickerSlug = rt.resolveDocAgentRunCandidates({ model: 'deepseek/deepseek-v4-pro', env: ALL_KEYS });
    assert.deepEqual(pickerSlug.map((entry) => [entry.provider, entry.model]), [['DeepSeek', 'deepseek-v4-pro']]);
    const router = rt.resolveDocAgentRunCandidates({ model: 'OpenRouter:deepseek/deepseek-v4-pro', env: ALL_KEYS });
    assert.deepEqual(router.map((entry) => [entry.provider, entry.model]), [['OpenRouter', 'deepseek/deepseek-v4-pro']]);
    const xai = rt.resolveDocAgentRunCandidates({ model: 'x-ai/grok-4.7', env: ALL_KEYS });
    assert.deepEqual(xai.map((entry) => [entry.provider, entry.model]), [['xAI', 'grok-4.7']]);
    assert.throws(
      () => rt.resolveDocAgentRunCandidates({ model: 'anthropic/claude-4', env: ALL_KEYS }),
      { code: 'E_PROVIDER' },
      'an unknown vendor slug must not be routed through a configured OpenRouter key',
    );
    assert.throws(
      () => rt.resolveDocAgentRunCandidates({ model: 'Anthropic:anthropic/claude-4', env: ALL_KEYS }),
      { code: 'E_PROVIDER' },
      'an unknown provider prefix must not imply OpenRouter',
    );
    assert.throws(
      () => rt.resolveDocAgentRunCandidates({ model: 'OpenAI:gpt-6-sol', env: { DEEPSEEK_API_KEY: 'configured' } }),
      { code: 'E_PROVIDER' },
      'missing selected API must not silently use DeepSeek',
    );
    assert.ok(rt.resolveDocAgentRunCandidates({ env: ALL_KEYS }).length > 1, 'the default route retains its existing ladder');
  });

  test('DeepSeek leads by default and only configured providers are listed', () => {
    const c = rt.resolveDocAgentCandidates({ env: { DEEPSEEK_API_KEY: 'a', GEMINI_API_KEY: 'b' } });
    assert.deepEqual(c.map((x) => [x.provider, x.model]), [['DeepSeek', 'deepseek-v4-pro'], ['Gemini', 'gemini-3.5-flash']]);
    const pinned = rt.resolveDocAgentCandidates({ env: { DEEPSEEK_API_KEY: 'a', AGENT_PRO_MODEL: 'deepseek-v4-flash' } });
    assert.equal(pinned[0].model, 'deepseek-v4-flash', 'AGENT_PRO_MODEL overrides the DeepSeek default');
    assert.equal(c[1].baseURL, 'https://generativelanguage.googleapis.com/v1beta/openai/');
  });

  test('the explicit model (arg or SIRAGPT_DOC_AGENT_MODEL) goes first on its provider, without duplicating it', () => {
    const fromArg = rt.resolveDocAgentCandidates({ model: 'muse-spark-1.2-contributor', env: ALL_KEYS });
    assert.deepEqual(fromArg.slice(0, 2).map((x) => [x.provider, x.model]), [['Meta', 'muse-spark-1.2-contributor'], ['DeepSeek', 'deepseek-v4-pro']]);
    assert.equal(fromArg.filter((x) => x.provider === 'Meta').length, 1);
    assert.deepEqual(fromArg[0].extra, { reasoning_effort: 'minimal' });

    const fromEnv = rt.resolveDocAgentCandidates({ env: { ...ALL_KEYS, SIRAGPT_DOC_AGENT_MODEL: 'deepseek/deepseek-v4-pro' } });
    assert.deepEqual(fromEnv[0], { ...fromEnv[0], provider: 'OpenRouter', model: 'deepseek/deepseek-v4-pro' });
    assert.equal(fromEnv[0].baseURL, 'https://openrouter.ai/api/v1');
    assert.equal(fromEnv[0].headers['X-Title'], 'SiraGPT Document Agent');
    assert.equal(fromEnv.length, 6);
  });

  test('an explicit model on an unconfigured provider is skipped, not fatal', () => {
    const c = rt.resolveDocAgentCandidates({ model: 'gpt-5.6-sol', env: { DEEPSEEK_API_KEY: 'a' } });
    assert.deepEqual(c.map((x) => x.provider), ['DeepSeek']);
  });

  test('placeholder keys (CI dummies) do not count as configured providers', () => {
    const c = rt.resolveDocAgentCandidates({ env: { DEEPSEEK_API_KEY: 'your_deepseek_key', OPENROUTER_API_KEY: 'ci-dummy-key', GEMINI_API_KEY: 'real' } });
    assert.deepEqual(c.map((x) => x.provider), ['Gemini']);
  });
});

describe('failover client', () => {
  test('a DeepSeek tool turn keeps its reasoning, then strips it when xAI takes over', async () => {
    const seen = [];
    let deepSeekCalls = 0;
    const client = rt.createFailoverClient([
      { provider: 'DeepSeek', model: 'deepseek-v4-pro' },
      { provider: 'xAI', model: 'grok-4.7' },
    ], { createClient: (candidate) => ({ chat: { completions: { create: async (payload) => {
      seen.push({ provider: candidate.provider, payload });
      if (candidate.provider === 'DeepSeek') {
        deepSeekCalls += 1;
        if (deepSeekCalls === 1) return { choices: [{ message: {
          content: null,
          reasoning_content: 'razonamiento original',
          tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
        } }] };
        assert.equal(payload.messages[1].reasoning_content, 'razonamiento original');
        throw httpError(503, 'temporary provider failure');
      }
      assert.equal('reasoning_content' in payload.messages[1], false);
      return { choices: [{ message: { content: 'Continué con el archivo.' } }] };
    } } } }) });
    const messages = [{ role: 'user', content: 'lee el documento' }];
    const result = await runDocAgentLoop({
      client, model: 'deepseek-v4-pro', messages,
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }],
      executors: { read_file: async () => 'contenido' }, maxIterations: 2,
    });
    assert.equal(result.finalText, 'Continué con el archivo.');
    assert.deepEqual(seen.map((entry) => entry.provider), ['DeepSeek', 'DeepSeek', 'xAI']);
    assert.equal(messages[1].reasoning_content, 'razonamiento original', 'the runner transcript stays intact');
  });

  test('DeepSeek receives placeholders for legacy assistant turns without reasoning', async () => {
    let sent;
    const client = rt.createFailoverClient([{ provider: 'DeepSeek', model: 'deepseek-v4-pro' }], {
      createClient: () => ({ chat: { completions: { create: async (payload) => {
        sent = payload;
        return { choices: [{ message: { content: 'ok' } }] };
      } } } }),
    });
    const messages = [
      { role: 'user', content: 'primera tarea' },
      { role: 'assistant', content: 'respuesta previa' },
      { role: 'user', content: 'segunda tarea' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'old-call', content: 'contenido' },
    ];
    await callModel({ client, model: 'deepseek-v4-pro', messages, tools: [], maxTokens: 500 });
    assert.equal(sent.messages[1].reasoning_content, '');
    assert.equal(sent.messages[3].reasoning_content, '');
    assert.equal('reasoning_content' in messages[1], false);
    assert.equal('reasoning_content' in messages[3], false);
  });

  test('a provider switch also adapts the completion-token parameter', async () => {
    let received;
    const client = rt.createFailoverClient([
      { provider: 'DeepSeek', model: 'deepseek-v4-pro' },
      { provider: 'OpenAI', model: 'gpt-6-sol' },
    ], { createClient: (candidate) => ({ chat: { completions: { create: async (payload) => {
      if (candidate.provider === 'DeepSeek') throw httpError(503, 'temporary provider failure');
      received = payload;
      return { choices: [{ message: { content: 'ok' } }] };
    } } } }) });
    await client.chat.completions.create({ messages: [{ role: 'user', content: 'hola' }], max_tokens: 300 });
    assert.equal(received.max_completion_tokens, 300);
    assert.equal('max_tokens' in received, false);
  });

  test('quota/auth/transport errors move to the next provider and stick there', async () => {
    const log = [];
    const events = [];
    const client = rt.createFailoverClient(
      rt.resolveDocAgentCandidates({ env: { ...ALL_KEYS, SIRAGPT_DOC_AGENT_MODEL: 'deepseek/deepseek-v4-pro' } }),
      { createClient: scriptedFactory({ OpenRouter: httpError(402, 'Insufficient credits') }, log), onFailover: (e) => events.push(e) },
    );
    const first = await client.chat.completions.create({ model: 'ignored', messages: [] });
    assert.equal(first.choices[0].message.content, 'ok from DeepSeek');
    assert.deepEqual(log.map((l) => l.provider), ['OpenRouter', 'DeepSeek']);
    assert.equal(log[1].model, 'deepseek-v4-pro', 'the candidate model replaces the payload model');
    assert.equal(events.length, 1);
    assert.equal(events[0].from, 'OpenRouter');
    assert.equal(events[0].to, 'DeepSeek');
    assert.equal(events[0].status, 402);

    await client.chat.completions.create({ model: 'ignored', messages: [] });
    assert.deepEqual(log.map((l) => l.provider), ['OpenRouter', 'DeepSeek', 'DeepSeek'], 'sticky: no retry of the failed provider');
    assert.deepEqual(client.describe().provider, 'DeepSeek');
    assert.equal(client.describe().failovers.length, 1);
  });

  test('Meta gets reasoning_effort minimal; model-side 400s propagate without failover', async () => {
    const log = [];
    const client = rt.createFailoverClient(
      rt.resolveDocAgentCandidates({ model: 'muse-spark-1.2', env: ALL_KEYS }),
      { createClient: scriptedFactory({ Meta: httpError(400, 'unknown parameter') }, log) },
    );
    await assert.rejects(() => client.chat.completions.create({ model: 'x', messages: [] }), /unknown parameter/);
    assert.deepEqual(log.map((l) => [l.provider, l.extra]), [['Meta', 'minimal']]);
  });

  test('every provider failing surfaces the last error; no providers is a clear error', async () => {
    const client = rt.createFailoverClient(
      rt.resolveDocAgentCandidates({ env: { DEEPSEEK_API_KEY: 'a', XAI_API_KEY: 'b' } }),
      { createClient: scriptedFactory({ DeepSeek: httpError(503, 'down'), xAI: httpError(429, 'slow down') }) },
    );
    await assert.rejects(() => client.chat.completions.create({ model: 'x', messages: [] }), /slow down/);
    assert.throws(() => rt.createFailoverClient([]), /no LLM provider configured/);
  });

  test('isFailoverError classifies statuses and transport failures', () => {
    assert.equal(rt.isFailoverError(httpError(402)), true);
    assert.equal(rt.isFailoverError(httpError(500)), true);
    assert.equal(rt.isFailoverError(httpError(400)), false);
    assert.equal(rt.isFailoverError(new Error('fetch failed')), true);
    assert.equal(rt.isFailoverError(new Error('ECONNRESET')), true);
    assert.equal(rt.isFailoverError(new Error('tool arguments invalid')), false);
  });
});

describe('agent runner wiring (source contract)', () => {
  const fs = require('fs');
  const path = require('path');
  const runner = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agent-runner', 'index.js'), 'utf8');
  const orchestrator = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agent-runner', 'orchestrator', 'index.js'), 'utf8');

  test('the document runner and the orchestrator never build a bare OpenRouter client', () => {
    assert.doesNotMatch(runner, /createOpenRouterClient\(\)/);
    assert.doesNotMatch(orchestrator, /createOpenRouterClient\(\)/);
    // AgentRunner routes the picked model to its own API.
    assert.match(runner, /if \(!llm\) llm = createRunnerLlmClient\(\{ pickedModel \}\);/);
    assert.match(orchestrator, /llm = createRunnerLlmClient\(\{ pickedModel \}\);/);
  });

  test('canCallLlm counts every configured provider and ignores CI placeholders', () => {
    const { canCallLlm, explicitRunnerModel } = require('../src/services/agent-runner');
    const saved = {};
    for (const k of ['DEEPSEEK_API_KEY', 'MODEL_API_KEY', 'META_API_KEY', 'LLAMA_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'SIRAGPT_AGENT_RUNNER_MODEL', 'SIRAGPT_DOC_AGENT_MODEL', 'OPENROUTER_MODEL']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      assert.equal(canCallLlm({}), false);
      process.env.OPENROUTER_API_KEY = 'ci-dummy';
      assert.equal(canCallLlm({}), false, 'a dummy OpenRouter key is not a provider');
      process.env.GEMINI_API_KEY = 'AIza-real-looking-key';
      assert.equal(canCallLlm({}), true, 'any real provider unlocks the runner');
      assert.equal(explicitRunnerModel(), null, 'the doc-agent default slug never pins OpenRouter first');
      process.env.SIRAGPT_AGENT_RUNNER_MODEL = 'Gemini:gemini-3.5-pro';
      assert.equal(explicitRunnerModel(), 'Gemini:gemini-3.5-pro');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

test('AgentRunner keeps a selected model on its provider when that API returns 402', async () => {
  const { createRunnerLlmClient } = require('../src/services/agent-runner');
  const calls = [];
  const client = createRunnerLlmClient({
    pickedModel: 'xAI:grok-4.7',
    env: { XAI_API_KEY: 'xai-test', DEEPSEEK_API_KEY: 'ds-test' },
    createClient: (candidate) => ({ chat: { completions: { create: async () => {
      calls.push(candidate.provider);
      throw httpError(402, 'quota');
    } } } }),
  });
  await assert.rejects(
    () => client.chat.completions.create({ model: 'ignored', messages: [] }),
    { code: 'E_PROVIDER' },
  );
  assert.deepEqual(calls, ['xAI']);
});

test('AgentRunner preserves a user abort instead of reporting E_PROVIDER', async () => {
  const { createRunnerLlmClient } = require('../src/services/agent-runner');
  const abort = new Error('cancelled');
  abort.name = 'AbortError';
  const client = createRunnerLlmClient({
    pickedModel: 'xAI:grok-4.7',
    env: { XAI_API_KEY: 'xai-test', DEEPSEEK_API_KEY: 'ds-test' },
    createClient: () => ({ chat: { completions: { create: async () => { throw abort; } } } }),
  });
  await assert.rejects(
    () => client.chat.completions.create({ model: 'ignored', messages: [] }),
    (error) => error === abort,
  );
});

test('AgentRunner uses the selected native Claude API for Fable tool calls and replay', async () => {
  const { createRunnerLlmClient, runnerModelSpec } = require('../src/services/agent-runner');
  const requests = [];
  const sdk = { messages: { create: async (request) => {
    requests.push(request);
    if (requests.length === 1) return {
      id: 'claude-tool-1', model: 'claude-fable-5-1', stop_reason: 'tool_use', usage: {},
      content: [
        { type: 'thinking', thinking: 'Revisaré el archivo.', signature: 'sig-local' },
        { type: 'tool_use', id: 'toolu_local', name: 'inspect_document', input: { path: 'outputs/datos.xlsx' } },
      ],
    };
    return {
      id: 'claude-tool-2', model: 'claude-fable-5-1', stop_reason: 'end_turn', usage: {},
      content: [{ type: 'text', text: 'El archivo se revisó.' }],
    };
  } } };
  const pickedModel = runnerModelSpec('Anthropic', 'anthropic/claude-fable-5-1');
  assert.equal(pickedModel, 'Anthropic:claude-fable-5-1');
  const client = createRunnerLlmClient({
    pickedModel,
    env: { ANTHROPIC_API_KEY: 'local-synthetic-key-123' },
    anthropicSdkClient: sdk,
  });
  assert.deepEqual(client.candidates(), [{ provider: 'Anthropic', model: 'claude-fable-5-1' }]);
  const tools = [{ type: 'function', function: {
    name: 'inspect_document', description: 'Read a document',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  } }];
  const messages = [{ role: 'system', content: 'Eres SiraGPT.' }, { role: 'user', content: 'Revisa el archivo.' }];
  const first = await client.chat.completions.create({ model: 'ignored', messages, tools, tool_choice: 'auto', max_tokens: 512 });
  assert.equal(first.choices[0].message.tool_calls[0].id, 'toolu_local');
  messages.push(first.choices[0].message);
  messages.push({ role: 'tool', tool_call_id: 'toolu_local', content: 'Hoja1!A1=valor' });
  const second = await client.chat.completions.create({ model: 'ignored', messages, tools, max_tokens: 512 });
  assert.match(second.choices[0].message.content, /revisó/);
  assert.equal(requests[0].model, 'claude-fable-5-1');
  assert.deepEqual(requests[1].messages[1].content.map((block) => block.type), ['thinking', 'tool_use']);
  assert.equal(requests[1].messages[1].content[0].signature, 'sig-local');
  assert.equal(requests[1].messages[2].content[0].tool_use_id, 'toolu_local');
});

test('AgentRunner loop replays native Claude signed tool blocks after a tool result', async () => {
  const { createRunnerLlmClient } = require('../src/services/agent-runner');
  const requests = [];
  const sdk = { messages: { create: async (request) => {
    requests.push(request);
    return requests.length === 1
      ? { id: 'tool-turn', model: request.model, stop_reason: 'tool_use', usage: {}, content: [
        { type: 'thinking', thinking: 'Voy a leer.', signature: 'signed-local' },
        { type: 'tool_use', id: 'toolu_1', name: 'inspect_document', input: { path: 'outputs/datos.xlsx' } },
      ] }
      : { id: 'final-turn', model: request.model, stop_reason: 'end_turn', usage: {}, content: [
        { type: 'text', text: 'Revisado.' },
      ] };
  } } };
  const client = createRunnerLlmClient({
    pickedModel: 'Anthropic:claude-fable-5-1',
    env: { ANTHROPIC_API_KEY: 'local-synthetic-key-123' },
    anthropicSdkClient: sdk,
  });
  const messages = [{ role: 'system', content: 'Eres SiraGPT.' }, { role: 'user', content: 'Lee el Excel.' }];
  const result = await runAgentLoop({
    client,
    model: 'claude-fable-5-1',
    messages,
    tools: [{ type: 'function', function: { name: 'inspect_document', description: 'Read',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    } }],
    executors: { inspect_document: async () => 'Hoja1!A1=valor' },
    maxIterations: 3,
  });
  assert.equal(result.stoppedReason, 'final');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages[1].content.map((block) => block.type), ['thinking', 'tool_use']);
  assert.equal(requests[1].messages[1].content[0].signature, 'signed-local');
  assert.equal(requests[1].messages[2].content[0].tool_use_id, 'toolu_1');
});

test('AgentRunner rejects a selected Claude without its own key even if another provider is ready', () => {
  const { resolveRunnerLlmCandidate } = require('../src/services/agent-runner');
  assert.throws(() => resolveRunnerLlmCandidate({
    pickedModel: 'Anthropic:claude-fable-5-1',
    env: { DEEPSEEK_API_KEY: 'local-synthetic-deepseek-key' },
  }), { code: 'E_PROVIDER' });
  assert.throws(() => resolveRunnerLlmCandidate({
    pickedModel: 'Anthropic:claude-fable-5-1',
    env: { ANTHROPIC_API_KEY: 'ci-dummy', DEEPSEEK_API_KEY: 'local-synthetic-deepseek-key' },
  }), { code: 'E_PROVIDER' });
});

test('AgentRunner maps a native Claude rejection to E_PROVIDER without trying a second API', async () => {
  const { createRunnerLlmClient } = require('../src/services/agent-runner');
  let calls = 0;
  const sdk = { messages: { create: async () => { calls += 1; throw httpError(402, 'synthetic quota'); } } };
  const client = createRunnerLlmClient({
    pickedModel: 'Anthropic:claude-fable-5-1',
    env: { ANTHROPIC_API_KEY: 'local-synthetic-key-123', DEEPSEEK_API_KEY: 'local-synthetic-deepseek-key' },
    anthropicSdkClient: sdk,
  });
  await assert.rejects(
    () => client.chat.completions.create({ model: 'ignored', messages: [{ role: 'user', content: 'Hola' }], tools: [] }),
    { code: 'E_PROVIDER', status: 402 },
  );
  assert.equal(calls, 1);
  assert.deepEqual(client.candidates(), [{ provider: 'Anthropic', model: 'claude-fable-5-1' }]);
});

test('AgentRunner preserves native Claude aborts', async () => {
  const { createRunnerLlmClient } = require('../src/services/agent-runner');
  const abort = new Error('cancelled');
  abort.name = 'AbortError';
  const sdk = { messages: { create: async () => { throw abort; } } };
  const client = createRunnerLlmClient({
    pickedModel: 'Anthropic:claude-fable-5-1',
    env: { SIRA_ANTHROPIC_API_KEY: 'local-synthetic-key-123' },
    anthropicSdkClient: sdk,
  });
  await assert.rejects(
    () => client.chat.completions.create({ model: 'ignored', messages: [{ role: 'user', content: 'Hola' }], tools: [] }),
    (error) => error === abort,
  );
});

test('AgentRunner rejects an unavailable or unsupported selection before calling another API', () => {
  const { resolveRunnerLlmCandidate, runnerModelSpec } = require('../src/services/agent-runner');
  const env = { DEEPSEEK_API_KEY: 'ds-test' };
  assert.equal(runnerModelSpec('Anthropic', 'claude-test'), 'Anthropic:claude-test');
  assert.equal(runnerModelSpec(null, 'deepseek-v4-pro'), 'Unresolved:deepseek-v4-pro');
  assert.throws(
    () => resolveRunnerLlmCandidate({ pickedModel: 'xAI:grok-4.7', env }),
    { code: 'E_PROVIDER' },
  );
  assert.throws(
    () => resolveRunnerLlmCandidate({ pickedModel: 'Anthropic:claude-test', env }),
    { code: 'E_PROVIDER' },
  );
  assert.equal(resolveRunnerLlmCandidate({ env }).provider, 'DeepSeek');
  assert.equal(
    resolveRunnerLlmCandidate({
      pickedModel: 'xAI:grok-4.7',
      env: { ...env, XAI_API_KEY: 'xai-test', SIRAGPT_AGENT_RUNNER_MODEL: 'DeepSeek:deepseek-v4-pro' },
    }).provider,
    'xAI',
    'the composer choice takes precedence over an operator default',
  );
});

test('a document turn with a missing selected API returns visible E_PROVIDER', async () => {
  const { runAgentRunnerForDocRoute } = require('../src/services/agent-runner');
  const previous = process.env.XAI_API_KEY;
  delete process.env.XAI_API_KEY;
  try {
    const result = await runAgentRunnerForDocRoute({
      prompt: 'crea un documento Word sobre el ciclo del agua',
      pickedModel: 'xAI:grok-4.7',
    });
    assert.equal(result.agentRunnerClaimed, true);
    assert.equal(result.reason, 'E_PROVIDER');
    assert.match(result.message, /^E_PROVIDER:/);
  } finally {
    if (previous === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previous;
  }
});
