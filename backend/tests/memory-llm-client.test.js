'use strict';

/**
 * memory-llm-client picks a cheap model with thinking OFF for fire-and-forget
 * memory extraction. Prod 2026-09-28: the ladder's first rung was
 * deepseek-v4-pro (or SIRAGPT_DOC_AGENT_MODEL) thinking by default, so its
 * reasoning ate the 600-token budget and the JSON came back empty or cut.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const memoryClient = require('../src/services/memory-llm-client');

function recordingFactory(calls) {
  return (candidate) => ({
    chat: {
      completions: {
        create: async (payload) => {
          calls.push({ provider: candidate.provider, payload });
          return { choices: [{ message: { content: '{"facts":[]}' }, finish_reason: 'stop' }] };
        },
      },
    },
  });
}

async function firstRequest(env) {
  const calls = [];
  const client = memoryClient.createMemoryLlmClient({ env, force: true, createClient: recordingFactory(calls) });
  assert.ok(client, 'a configured provider yields a client');
  await client.chat.completions.create({ model: 'gpt-4o-mini', max_tokens: 1200, messages: [{ role: 'user', content: 'hola' }] });
  return calls[0];
}

beforeEach(() => memoryClient.resetForTests());

test('with only DEEPSEEK_API_KEY the first candidate is deepseek-v4-flash with thinking disabled', async () => {
  const env = { DEEPSEEK_API_KEY: 'ds-real-key' };
  const [first] = memoryClient.resolveMemoryLlmCandidates({ env });
  assert.equal(first.provider, 'DeepSeek');
  assert.equal(first.model, 'deepseek-v4-flash');
  assert.deepEqual(first.extra.thinking, { type: 'disabled' });

  const call = await firstRequest(env);
  assert.equal(call.provider, 'DeepSeek');
  assert.equal(call.payload.model, 'deepseek-v4-flash');
  assert.deepEqual(call.payload.thinking, { type: 'disabled' });
});

test('SIRAGPT_MEMORY_LLM_MODEL overrides the default model', async () => {
  const env = { DEEPSEEK_API_KEY: 'ds-real-key', GEMINI_API_KEY: 'gm-real-key', SIRAGPT_MEMORY_LLM_MODEL: 'Gemini:gemini-3.5-flash' };
  const [first] = memoryClient.resolveMemoryLlmCandidates({ env });
  assert.equal(first.provider, 'Gemini');
  assert.equal(first.model, 'gemini-3.5-flash');
  const call = await firstRequest(env);
  assert.equal(call.provider, 'Gemini');
  assert.equal(call.payload.model, 'gemini-3.5-flash');
  // Only DeepSeek V4 ids receive the field; other providers 400 on it.
  assert.equal(Object.prototype.hasOwnProperty.call(call.payload, 'thinking'), false);
});

test('SIRAGPT_DOC_AGENT_MODEL is not inherited by memory', async () => {
  const env = { DEEPSEEK_API_KEY: 'ds-real-key', SIRAGPT_DOC_AGENT_MODEL: 'DeepSeek:deepseek-v4-pro' };
  const [first] = memoryClient.resolveMemoryLlmCandidates({ env });
  assert.equal(first.model, 'deepseek-v4-flash');
  const call = await firstRequest(env);
  assert.equal(call.payload.model, 'deepseek-v4-flash');
});

test('non-DeepSeek rungs of the ladder never get the thinking field', () => {
  const env = { DEEPSEEK_API_KEY: 'ds-real-key', XAI_API_KEY: 'xai-real-key', OPENAI_API_KEY: 'sk-real-key' };
  const candidates = memoryClient.resolveMemoryLlmCandidates({ env });
  assert.equal(candidates[0].provider, 'DeepSeek');
  for (const candidate of candidates.filter((c) => c.provider !== 'DeepSeek')) {
    assert.equal((candidate.extra || {}).thinking, undefined, `${candidate.provider} must not get thinking`);
  }
});

test('no configured provider → null (callers keep their no-op)', () => {
  assert.equal(memoryClient.createMemoryLlmClient({ env: {}, force: true }), null);
});
