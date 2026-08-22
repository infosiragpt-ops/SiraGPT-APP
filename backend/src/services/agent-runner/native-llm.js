'use strict';

/**
 * Native DeepSeek client for AgentRunner / doc / chat generate.
 * Product lock: these paths MUST hit api.deepseek.com with DEEPSEEK_API_KEY.
 * Never OpenRouter — even if OPENROUTER_API_KEY is present or a leftover
 * OpenRouter client is passed in.
 */

const FLASH = 'deepseek-v4-flash';
const PRO = 'deepseek-v4-pro';

function hasUsableDeepSeekKey(env = process.env) {
  const key = String(env.DEEPSEEK_API_KEY || '').trim();
  if (!key) return false;
  if (/dummy|not-used|ci-dummy|test-key/i.test(key)) return false;
  return true;
}

function isNativeDeepSeekClient(client) {
  if (!client) return false;
  const url = String(client.baseURL || client.baseUrl || '');
  return /api\.deepseek\.com/i.test(url);
}

function isOpenRouterClient(client) {
  if (!client) return false;
  const url = String(client.baseURL || client.baseUrl || '');
  return /openrouter\.ai/i.test(url);
}

function createNativeDeepSeekClient(env = process.env) {
  if (!hasUsableDeepSeekKey(env)) throw new Error('DEEPSEEK_API_KEY is not configured');
  const OpenAI = require('openai');
  return new OpenAI({
    apiKey: String(env.DEEPSEEK_API_KEY).trim(),
    baseURL: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  });
}

function resolveNativeDeepSeekModel(model, env = process.env) {
  const raw = String(model || '').trim();
  const bare = (raw.includes('/') ? raw.split('/').pop() : raw).toLowerCase();
  if (bare === PRO || bare === 'deepseek-v4-pro' || /deepseek-v4-pro/.test(bare)) return PRO;
  if (bare === FLASH || /^deepseek-v4-flash/.test(bare)) return FLASH;
  if (bare === 'deepseek-chat' || bare === 'deepseek-reasoner') return bare;
  return String(env.SIRAGPT_AGENT_RUNNER_MODEL || env.SIRAGPT_DOC_AGENT_MODEL || FLASH).trim() || FLASH;
}

function canCallNativeDeepSeek({ client, env = process.env } = {}) {
  if (client && isNativeDeepSeekClient(client)) return true;
  if (client && isOpenRouterClient(client)) {
    // Leftover OpenRouter hop — ignore it; we can still call native DeepSeek.
    return hasUsableDeepSeekKey(env);
  }
  if (client) return hasUsableDeepSeekKey(env);
  return hasUsableDeepSeekKey(env);
}

function resolveAgentLlmClient({ client, env = process.env } = {}) {
  if (client && isNativeDeepSeekClient(client)) return client;
  return createNativeDeepSeekClient(env);
}

function proFallbackModel(currentModel) {
  const resolved = resolveNativeDeepSeekModel(currentModel);
  if (resolved === PRO) return null;
  return PRO;
}

/** 3H5-BE — leftover generators (design/viz/plan/math/artifact/marco) must never build OpenRouter/OpenAI/Gemini clients. */
function strictDeepSeekClientForModel(modelName, env = process.env) {
  if (!hasUsableDeepSeekKey(env)) {
    const err = new Error('DEEPSEEK_API_KEY is not configured');
    err.code = 'deepseek_unconfigured';
    throw err;
  }
  const model = resolveNativeDeepSeekModel(modelName, env);
  return {
    provider: 'DeepSeek',
    client: createNativeDeepSeekClient(env),
    model,
  };
}

module.exports = {
  FLASH,
  PRO,
  hasUsableDeepSeekKey,
  isNativeDeepSeekClient,
  isOpenRouterClient,
  createNativeDeepSeekClient,
  resolveNativeDeepSeekModel,
  canCallNativeDeepSeek,
  resolveAgentLlmClient,
  proFallbackModel,
  strictDeepSeekClientForModel,
  clientLooksLikeOpenRouter: isOpenRouterClient,
};
