'use strict';

/**
 * DeepSeek-only client for the agent-computer loop.
 * Flash / Pro only — never OpenRouter, OpenAI, or Anthropic.
 */

const { resolveComputerModel, DEEPSEEK_FLASH, DEEPSEEK_PRO } = require('./flags');

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

function createDeepSeekClient({ env = process.env, createClient } = {}) {
  if (typeof createClient === 'function') return createClient();
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    const err = new Error('DEEPSEEK_API_KEY is required for the agent-computer loop');
    err.code = 'DEEPSEEK_NOT_CONFIGURED';
    throw err;
  }
  const OpenAI = require('openai');
  const { sharedFetch } = require('../../utils/provider-http-agent');
  return new OpenAI({
    apiKey,
    baseURL: DEEPSEEK_BASE_URL,
    fetch: sharedFetch,
  });
}

async function completeJson({ client, model, messages, signal, maxTokens = 1024 }) {
  const resolved = resolveComputerModel(model);
  if (resolved !== DEEPSEEK_FLASH && resolved !== DEEPSEEK_PRO) {
    throw new Error(`refusing non-DeepSeek model: ${resolved}`);
  }
  const response = await client.chat.completions.create({
    model: resolved,
    messages,
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  }, signal ? { signal } : undefined);
  const text = response.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(text);
  } catch (_) {
    const fence = text.match(/\{[\s\S]*\}/);
    if (fence) return JSON.parse(fence[0]);
    throw new Error('model returned non-JSON');
  }
}

module.exports = {
  DEEPSEEK_BASE_URL,
  createDeepSeekClient,
  completeJson,
};
