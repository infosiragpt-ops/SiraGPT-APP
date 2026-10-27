'use strict';

/**
 * Agent tasks run on the model the user picked, end to end (AGENTS.md §13,
 * I12). Each test fails without its fix:
 *  - a bare claude-* id was undetected, so a picked Claude ran on DeepSeek;
 *    FlashGPT's gpt-oss-120b was taken for an OpenAI model and llama-3.x /
 *    Groq ids were undetected (their own API now: Cerebras, Groq);
 *  - the task contract of a picked xAI/Claude model was resolved by
 *    gpt-4o-mini or another provider of the resolver's ladder;
 *  - the rescue answer for a weak attachment answer came from gpt-4o-mini →
 *    Gemini → OpenRouter instead of the picked model;
 *  - attached images were described by the first configured vision model even
 *    when the picked model can see; a text-only pick never said who read them.
 * The task-level flows (E_PROVIDER instead of a stand-in) are in
 * agent-task-pinned-model.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const runner = require('../src/services/agents/agent-task-runner');
const { pickResolverRuntime } = require('../src/services/agents/task-contract-resolver');

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

test('picked ids run on their own API: Claude on Anthropic, FlashGPT on Cerebras, Groq on Groq', () => {
  const provider = (id) => (runner.detectAgentRuntimeProvider(id) || {}).provider || null;
  assert.equal(provider('claude-sonnet-4-6'), 'Anthropic');
  assert.equal(provider('gpt-oss-120b'), 'Cerebras', 'FlashGPT, not an OpenAI model');
  assert.equal(provider('llama-3.1-8b'), 'Cerebras');
  assert.equal(provider('llama-3.3-70b-versatile'), 'Groq');
  // Unchanged families.
  assert.equal(provider('gpt-4o'), 'OpenAI');
  assert.equal(provider('deepseek-v4-pro'), 'DeepSeek');
  assert.equal(provider('grok-4.7'), 'xAI');
  assert.equal(provider('openai/gpt-5.5'), 'OpenRouter');
  // Families the task runtime does not drive stay undetected.
  assert.equal(provider('mistral-large-latest'), null);
  assert.equal(provider('sira-mini'), null);

  withEnv({ ANTHROPIC_API_KEY: 'sk-ant-unit-0001', SIRA_ANTHROPIC_API_KEY: undefined }, () => {
    const profile = runner.normalizeAgentRuntimeModel('claude-sonnet-4-6');
    const resolution = runner.resolveAgentRuntimeClient(profile, { pinned: true });
    assert.equal(resolution.provider, 'Anthropic');
    assert.equal(resolution.model, 'claude-sonnet-4-6');
    assert.equal(typeof resolution.client.chat.completions.create, 'function');
  });
  withEnv({ ANTHROPIC_API_KEY: undefined, SIRA_ANTHROPIC_API_KEY: undefined, DEEPSEEK_API_KEY: 'sk-deepseek-unit-0001' }, () => {
    const profile = runner.normalizeAgentRuntimeModel('claude-sonnet-4-6');
    const pinned = runner.resolveAgentRuntimeClient(profile, { pinned: true });
    assert.equal(pinned.client, null, 'a picked Claude without its key never runs on DeepSeek');
    assert.equal(pinned.unavailable, 'no_key');
    assert.equal(runner.resolveAgentRuntimeClient(runner.normalizeAgentRuntimeModel('totally-unknown-model-x9'), { pinned: true }).unavailable, 'unsupported');
  });
});

test('the task contract of a picked model is resolved by that model: no remap, no other provider', () => {
  const xai = { baseURL: 'https://api.x.ai/v1', chat: { completions: { create: async () => ({}) } } };
  const deepseek = { baseURL: 'https://api.deepseek.com', chat: { completions: { create: async () => ({}) } } };
  const env = { OPENAI_API_KEY: 'sk-openai-unit', GEMINI_API_KEY: 'gm-unit', XAI_API_KEY: 'xai-unit', DEEPSEEK_API_KEY: 'ds-unit' };
  const deps = { createClient: () => { throw new Error('no side-channel client for a picked model'); } };

  const pickedXai = pickResolverRuntime({ openai: xai, model: 'grok-4.7', provider: 'xAI', pinned: true, env, deps });
  assert.equal(pickedXai.client, xai);
  assert.equal(pickedXai.model, 'grok-4.7');
  assert.equal(pickedXai.provider, 'xAI');
  assert.equal(pickedXai.key, 'xai-unit');

  const pickedFlash = pickResolverRuntime({ openai: deepseek, model: 'deepseek-v4-flash', provider: 'DeepSeek', pinned: true, env, deps });
  assert.equal(pickedFlash.model, 'deepseek-v4-flash');
  const pickedPro = pickResolverRuntime({ openai: deepseek, model: 'deepseek-v4-pro', provider: 'DeepSeek', pinned: true, env, deps });
  assert.equal(pickedPro.model, 'deepseek-v4-pro', 'a Pro pick stays Pro');

  const unavailable = pickResolverRuntime({ openai: null, model: 'grok-4.7', provider: 'xAI', pinned: true, env, deps });
  assert.equal(unavailable.client, null, 'the heuristic contract, never another model');
  assert.match(unavailable.skipped, /picked model unavailable/);
});

test('a weak answer about an attachment is rescued by the picked model, never by the recovery ladder', async () => {
  const calls = [];
  const picked = { chat: { completions: { create: async (body) => { calls.push(body.model); return { choices: [{ message: { content: 'Respuesta del modelo elegido sobre el informe adjunto.' } }] }; } } } };
  const env = { NODE_ENV: 'test', AGENT_TASK_LLM_RECOVERY: '1', OPENAI_API_KEY: 'sk-openai-unit', GEMINI_API_KEY: 'gm-unit' };
  const material = 'Informe de ventas del tercer trimestre con ingresos de 283000 dólares, meta de 270000 dólares y retención de clientes de 92.8 por ciento en la región.';
  const answer = await runner.buildLlmAttachmentRecoveryAnswer({
    goal: '¿Cuánto vendimos?',
    uploadedFileContext: material,
    env,
    clientFactory: () => { throw new Error('the recovery ladder must not run for a picked model'); },
    pinnedRuntime: { client: picked, model: 'grok-4.7', provider: 'xAI' },
  });
  assert.match(answer, /modelo elegido/);
  assert.deepEqual(calls, ['grok-4.7']);
  // The same opt-outs still apply to a picked model.
  assert.equal(await runner.buildLlmAttachmentRecoveryAnswer({
    goal: '¿Cuánto vendimos?',
    uploadedFileContext: material,
    env: { ...env, AGENT_TASK_LLM_RECOVERY: '0' },
    pinnedRuntime: { client: picked, model: 'grok-4.7', provider: 'xAI' },
  }), null);
});

test('images are described by a picked model that can see; a text-only pick says which model read them', async () => {
  const aiService = require('../src/services/ai-service');
  const original = { getClient: aiService.getClient, prepare: aiService.prepareImageForVision };
  const used = [];
  aiService.getClient = (provider) => ({
    chat: { completions: { create: async (body) => { used.push(`${provider}:${body.model}`); return { choices: [{ message: { content: `descrita por ${provider}` } }] }; } } },
  });
  aiService.prepareImageForVision = async () => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  const images = [{ path: '/tmp/fidelity.png', mimeType: 'image/png' }];
  try {
    await withEnv({ GEMINI_API_KEY: 'gm-unit', XAI_API_KEY: 'xai-unit', OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined, MODEL_API_KEY: undefined, META_API_KEY: undefined, LLAMA_API_KEY: undefined }, async () => {
      const seeing = await aiService.describeAttachedImages(images, '¿qué es?', { provider: 'xAI', model: 'grok-4.7', pinned: true, detailed: true });
      assert.equal(seeing.picked, true);
      assert.equal(seeing.provider, 'xAI');
      assert.deepEqual(used, ['xAI:grok-4.7'], 'the picked model, not the first configured vision runtime');

      used.length = 0;
      const textOnly = await aiService.describeAttachedImages(images, '¿qué es?', { provider: 'DeepSeek', model: 'deepseek-v4-flash', pinned: true, detailed: true });
      assert.equal(textOnly.picked, false);
      assert.equal(textOnly.provider, 'Gemini');
      assert.match(runner.visionSwitchLabel(runner.normalizeAgentRuntimeModel('deepseek-v4-flash'), textOnly.provider, textOnly.model), /no ve imágenes: las lee /);

      used.length = 0;
      const legacy = await aiService.describeAttachedImages(images, '¿qué es?');
      assert.equal(legacy, 'descrita por Gemini', 'callers without a pick keep the plain string');
    });
  } finally {
    aiService.getClient = original.getClient;
    aiService.prepareImageForVision = original.prepare;
  }
});
