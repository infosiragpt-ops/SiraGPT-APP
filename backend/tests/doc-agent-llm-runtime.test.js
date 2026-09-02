'use strict';

// Document agent LLM runtime: provider ladder + per-call failover. Offline.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const rt = require('../src/services/doc-agent/llm-runtime');

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
  test('DeepSeek leads by default and only configured providers are listed', () => {
    const c = rt.resolveDocAgentCandidates({ env: { DEEPSEEK_API_KEY: 'a', GEMINI_API_KEY: 'b' } });
    assert.deepEqual(c.map((x) => [x.provider, x.model]), [['DeepSeek', 'deepseek-chat'], ['Gemini', 'gemini-3.5-flash']]);
    assert.equal(c[1].baseURL, 'https://generativelanguage.googleapis.com/v1beta/openai/');
  });

  test('the explicit model (arg or SIRAGPT_DOC_AGENT_MODEL) goes first on its provider, without duplicating it', () => {
    const fromArg = rt.resolveDocAgentCandidates({ model: 'muse-spark-1.2-contributor', env: ALL_KEYS });
    assert.deepEqual(fromArg.slice(0, 2).map((x) => [x.provider, x.model]), [['Meta', 'muse-spark-1.2-contributor'], ['DeepSeek', 'deepseek-chat']]);
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
});

describe('failover client', () => {
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
    assert.equal(log[1].model, 'deepseek-chat', 'the candidate model replaces the payload model');
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
