'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { defaultLlmTurn, resolveTurnEngine } = require('../src/services/codex/llm-turn');
const provider = require('../src/services/codex/llm-provider');

const messages = [{ role: 'user', content: 'Revisa el proyecto.' }];
const env = { NODE_ENV: 'test', DEEPSEEK_API_KEY: 'test-ds', ANTHROPIC_API_KEY: 'test-ant', CEREBRAS_API_KEY: 'test-cb', OPENROUTER_API_KEY: 'test-or' };
function openAIClient(run) { return { chat: { completions: { create: run } } }; }
function nativeReply() { return { id: 'test', content: [{ type: 'text', text: 'listo' }], usage: { input_tokens: 1, output_tokens: 1 } }; }
function compatibleReply() { return { id: 'test', choices: [{ message: { content: 'listo' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; }

test.beforeEach(() => provider.resetQuarantine());

test('explicit model chooses its own engine before tier and configured defaults', () => {
  for (const [model, expected] of [
    ['deepseek-v4-pro', 'deepseek'], ['Sira Pro', 'deepseek'], ['Sira Rápido', 'deepseek'],
    ['anthropic/claude-sonnet-5-5', 'anthropic'], ['claude-opus-5-5', 'anthropic'],
    ['grok-4.7', 'xai'], ['gpt-6', 'openai'], ['gemini-3-pro', 'gemini'],
    ['gpt-oss-120b', 'cerebras'], ['qwen/model', 'openrouter'],
  ]) assert.equal(resolveTurnEngine({ model, tier: 'power', env }), expected);
});

test('selected DeepSeek failure is final: no native or prompted replacement', async () => {
  const calls = [];
  const original = Object.assign(new Error('controlled quota failure'), { status: 402 });
  await assert.rejects(defaultLlmTurn({ messages, model: 'deepseek-v4-pro', tier: 'power', env,
    createDeepSeekClient: () => openAIClient(async (request) => { calls.push(['deepseek', request.model]); throw original; }),
    createAnthropicClient: () => { calls.push(['anthropic']); throw new Error('wrong provider'); },
    createClient: () => { calls.push(['cerebras']); throw new Error('wrong provider'); },
  }), (error) => error === original);
  assert.deepEqual(calls, [['deepseek', 'deepseek-v4-pro']]);
});

test('selected Claude is used even with DeepSeek configured and an eco tier', async () => {
  const calls = [];
  const result = await defaultLlmTurn({ messages, model: 'anthropic/claude-sonnet-5-5', tier: 'eco', env,
    createDeepSeekClient: () => { throw new Error('must not call DeepSeek'); },
    createAnthropicClient: () => ({ messages: { create: async (request) => { calls.push(request.model); return nativeReply(); } } }),
  });
  assert.deepEqual(calls, ['claude-sonnet-5-5']);
  assert.equal(result.usage.provider, 'Anthropic');
  assert.equal(result.usage.model, 'claude-sonnet-5-5');
});

test('selected Claude failure and missing selected connection cannot use another provider', async () => {
  const failure = new Error('controlled outage');
  await assert.rejects(defaultLlmTurn({ messages, model: 'claude-opus-5-5', tier: 'power', env,
    createDeepSeekClient: () => { throw new Error('wrong provider'); },
    createAnthropicClient: () => ({ messages: { create: async () => { throw failure; } } }),
  }), (error) => error === failure);
  await assert.rejects(defaultLlmTurn({ messages, model: 'deepseek-v4-pro', env: { NODE_ENV: 'test', ANTHROPIC_API_KEY: 'test-ant' },
    createAnthropicClient: () => { throw new Error('wrong provider'); },
  }), { code: 'E_PROVIDER' });
});

test('selected Cerebras remains Cerebras with paid native providers configured', async () => {
  const calls = [];
  const result = await defaultLlmTurn({ messages, model: 'gpt-oss-120b', tier: 'power', env,
    createDeepSeekClient: () => { throw new Error('wrong provider'); },
    createClient: () => openAIClient(async (request) => { calls.push(request.model); return compatibleReply(); }),
  });
  assert.deepEqual(calls, ['gpt-oss-120b']);
  assert.equal(result.usage.provider, 'Cerebras');
});

test('prompted provider ladder also pins model, ignoring default overrides and quarantine', async () => {
  const calls = [];
  const failure = new Error('controlled native endpoint outage');
  const selectedEnv = { ...env, CODEX_LLM_PROVIDER: 'anthropic' };
  assert.deepEqual(provider.resolveCandidates({ env: selectedEnv, model: 'deepseek-v4-pro' }), ['deepseek']);
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(provider.chatComplete({ messages, model: 'deepseek-v4-pro', env: selectedEnv,
      clients: {
        deepseek: openAIClient(async (request) => { calls.push(request.model); throw failure; }),
        anthropicCtor: class { constructor() { throw new Error('wrong provider'); } },
      },
    }), (error) => error === failure);
  }
  assert.deepEqual(calls, ['deepseek-v4-pro', 'deepseek-v4-pro']);
  assert.deepEqual(provider.resolveCandidates({ env, model: 'deepseek-v4-pro', exclude: ['deepseek'] }), []);
});

test('prompted selected provider preserves native model ID and rejects cross-provider substitution', async () => {
  const calls = [];
  class Anthropic { messages = { create: async (request) => { calls.push(request.model); return nativeReply(); } }; }
  const result = await provider.chatComplete({ messages, model: 'anthropic/claude-sonnet-5-5', env,
    clients: { anthropicCtor: Anthropic, deepseek: openAIClient(async () => { throw new Error('wrong provider'); }) },
  });
  assert.deepEqual(calls, ['claude-sonnet-5-5']);
  assert.equal(result.usage.model, 'claude-sonnet-5-5');
  assert.throws(() => provider.modelFor('anthropic', env, 'deepseek-v4-pro'), { code: 'E_PROVIDER' });
});

test('other explicit first-party models reuse their own API and compatible token parameters', async () => {
  const captures = [];
  class OpenAI {
    constructor(options) {
      this.chat = { completions: { create: async (request) => { captures.push({ options, request }); return compatibleReply(); } } };
    }
  }
  const ownEnv = { ...env, XAI_API_KEY: 'test-xai', OPENAI_API_KEY: 'test-openai' };
  const grok = await provider.chatComplete({ messages, model: 'x-ai/grok-4.7', env: ownEnv, clients: { openAICtor: OpenAI } });
  assert.equal(grok.usage.provider, 'xAI');
  assert.equal(captures[0].options.baseURL, 'https://api.x.ai/v1');
  assert.equal(captures[0].request.model, 'grok-4.7');
  await provider.chatComplete({ messages, model: 'gpt-6', env: ownEnv, clients: { openAICtor: OpenAI } });
  assert.equal(captures[1].request.model, 'gpt-6');
  assert.ok(captures[1].request.max_completion_tokens > 0);
  assert.equal(captures[1].request.max_tokens, undefined);
});

test('real HTTP transport failure for selected Grok makes one request and never switches engines', async (t) => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'controlled unavailable', type: 'server_error' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(defaultLlmTurn({ messages, model: 'grok-4.7', tier: 'power', env: {
    ...env, XAI_API_KEY: 'test-xai', XAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  }, createDeepSeekClient: () => { throw new Error('wrong provider'); },
  createAnthropicClient: () => { throw new Error('wrong provider'); } }), /controlled unavailable/);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, 'grok-4.7');
});


test('an unknown native model cannot silently become its tier default', async () => {
  for (const model of ['Claude Sonnet 5.5', 'deepseek-v4-unknown', 'anthropic/not-a-claude-id']) {
    await assert.rejects(defaultLlmTurn({ messages, model, tier: 'power', env,
      createDeepSeekClient: () => { throw new Error('must reject before transport'); },
      createAnthropicClient: () => { throw new Error('must reject before transport'); },
    }), { code: 'E_PROVIDER' });
  }
  assert.equal(provider.modelFor('deepseek', env, 'Sira Pro'), 'deepseek-v4-pro');
  assert.equal(provider.modelFor('deepseek', env, 'deepseek/deepseek-v4-flash'), 'deepseek-v4-flash');
});
