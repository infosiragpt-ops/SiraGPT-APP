'use strict';

/**
 * Endpoint + credential resolution for the harness adapters.
 *
 * Mirrors routes/ai.js `createProviderClient` (same env var names, same
 * default base URLs) so a key saved in Admin → Conexiones — which the
 * admin-connections bridge injects into process.env — works here too.
 * Keys are read at call time and never logged.
 */

const { PROVIDER_UNAVAILABLE_MESSAGE } = require('../ai/provider-inference');
const { HarnessProviderError } = require('./errors');

function pick(env, ...names) {
  for (const name of names) {
    const value = String((env && env[name]) || '').trim();
    if (value) return value;
  }
  return '';
}

function canonicalProvider(provider) {
  const p = String(provider || '').trim().toLowerCase();
  if (p === 'anthropic' || p === 'claude') return 'Anthropic';
  if (p === 'gemini' || p === 'google') return 'Gemini';
  if (p === 'openrouter') return 'OpenRouter';
  if (p === 'deepseek') return 'DeepSeek';
  if (p === 'cerebras') return 'Cerebras';
  if (p === 'z.ai' || p === 'zai') return 'Z.ai';
  if (p === 'kimi' || p === 'moonshot') return 'Kimi';
  if (p === 'groq') return 'Groq';
  if (p === 'mistral') return 'Mistral';
  if (p === 'xai' || p === 'x-ai' || p === 'grok') return 'xAI';
  if (p === 'meta' || p === 'llama') return 'Meta';
  if (p === 'openai' || p === '') return 'OpenAI';
  return provider;
}

/**
 * @returns {{ provider: string, protocol: 'anthropic'|'openai'|'gemini', baseURL: string, apiKey: string }}
 */
function resolveProviderEndpoint(provider, env = process.env) {
  const name = canonicalProvider(provider);
  let endpoint;
  switch (name) {
    case 'Anthropic':
      endpoint = { protocol: 'anthropic', baseURL: pick(env, 'ANTHROPIC_BASE_URL') || 'https://api.anthropic.com', apiKey: pick(env, 'ANTHROPIC_API_KEY', 'SIRA_ANTHROPIC_API_KEY') };
      break;
    case 'Gemini':
      endpoint = { protocol: 'gemini', baseURL: pick(env, 'GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta', apiKey: pick(env, 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY') };
      break;
    case 'OpenRouter':
      endpoint = { protocol: 'openai', baseURL: 'https://openrouter.ai/api/v1', apiKey: pick(env, 'OPENROUTER_API_KEY') };
      break;
    case 'DeepSeek':
      endpoint = { protocol: 'openai', baseURL: 'https://api.deepseek.com', apiKey: pick(env, 'DEEPSEEK_API_KEY') };
      break;
    case 'Cerebras':
      endpoint = { protocol: 'openai', baseURL: pick(env, 'CEREBRAS_BASE_URL') || 'https://api.cerebras.ai/v1', apiKey: pick(env, 'CEREBRAS_API_KEY') };
      break;
    case 'Z.ai':
      endpoint = { protocol: 'openai', baseURL: pick(env, 'ZAI_BASE_URL') || 'https://api.z.ai/api/paas/v4', apiKey: pick(env, 'ZAI_API_KEY') };
      break;
    case 'Kimi':
      endpoint = { protocol: 'openai', baseURL: pick(env, 'MOONSHOT_BASE_URL', 'KIMI_BASE_URL') || 'https://api.moonshot.ai/v1', apiKey: pick(env, 'MOONSHOT_API_KEY', 'KIMI_API_KEY') };
      break;
    case 'Groq':
      endpoint = { protocol: 'openai', baseURL: pick(env, 'GROQ_BASE_URL') || 'https://api.groq.com/openai/v1', apiKey: pick(env, 'GROQ_API_KEY') };
      break;
    case 'Mistral':
      endpoint = { protocol: 'openai', baseURL: pick(env, 'MISTRAL_BASE_URL') || 'https://api.mistral.ai/v1', apiKey: pick(env, 'MISTRAL_API_KEY') };
      break;
    case 'xAI':
      endpoint = { protocol: 'openai', baseURL: pick(env, 'XAI_BASE_URL') || 'https://api.x.ai/v1', apiKey: pick(env, 'XAI_API_KEY') };
      break;
    case 'Meta':
      endpoint = { protocol: 'openai', baseURL: pick(env, 'META_BASE_URL', 'LLAMA_BASE_URL') || 'https://api.meta.ai/v1', apiKey: pick(env, 'MODEL_API_KEY', 'META_API_KEY', 'LLAMA_API_KEY') };
      break;
    case 'OpenAI':
      endpoint = { protocol: 'openai', baseURL: pick(env, 'OPENAI_BASE_URL') || 'https://api.openai.com/v1', apiKey: pick(env, 'OPENAI_API_KEY') };
      break;
    default:
      throw new HarnessProviderError(`Proveedor no soportado por el arnés: ${provider}`, { provider: name, code: 'PROVIDER_UNSUPPORTED', retryable: false });
  }
  if (!endpoint.apiKey) {
    throw new HarnessProviderError(PROVIDER_UNAVAILABLE_MESSAGE, {
      provider: name, code: 'PROVIDER_CONNECTION_UNAVAILABLE', status: 503, retryable: false,
    });
  }
  endpoint.baseURL = endpoint.baseURL.replace(/\/+$/, '');
  return { provider: name, ...endpoint };
}

module.exports = { resolveProviderEndpoint, canonicalProvider };
