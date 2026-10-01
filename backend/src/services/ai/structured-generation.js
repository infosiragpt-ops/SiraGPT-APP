'use strict';

const OpenAI = require('openai');
const { inferProviderFromModelId, providerConnectionReady, isDirectDeepSeekModel } = require('./provider-inference');
const { createAnthropicStreamingClient, createXaiClient, createMoonshotClient, stripVendorPrefix } = require('./first-party-chat-clients');
const { stripUnsupportedSampling } = require('./openai-sampling-params');
const { stripCodeFence, sliceJsonSpan } = require('../ai-product-os/json-repair');
const { failureCauseFor, buildFailureMessage } = require('./billing-failover');
const { resolveAnthropicEffortControls } = require('../providers/anthropic-effort');

function outputError() {
  const error = new Error('El modelo devolvió una respuesta con formato inválido. Inténtalo de nuevo.');
  error.code = 'E_CONTENT';
  return error;
}

function publicGenerationError(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return { code: 'E_CANCELLED', error: 'Solicitud cancelada.' };
  }
  if (error?.code === 'E_CONTENT') return { code: 'E_CONTENT', error: outputError().message };
  const reason = error?.code === 'PROVIDER_CONNECTION_UNAVAILABLE' ? 'unconfigured' : failureCauseFor(error);
  return {
    code: reason === 'billing' || reason === 'rate_limit' ? 'E_QUOTA' : 'E_PROVIDER',
    error: buildFailureMessage({ reason }) || 'El modelo elegido no pudo responder. Inténtalo de nuevo o elige otro modelo.',
  };
}

// Use the same first-party inference and native adapters as chat. A missing
// connection is an error, never permission to send this model to another API.
function clientForModel(modelName, { env = process.env, OpenAIImpl = OpenAI, anthropicSdkClient = null, fetchImpl } = {}) {
  const requested = String(modelName || '').trim() || 'gpt-4o';
  const directDeepSeek = stripVendorPrefix(requested, ['deepseek/']);
  const provider = isDirectDeepSeekModel(directDeepSeek) ? 'DeepSeek' : inferProviderFromModelId(requested);
  if (!providerConnectionReady(provider, env)) {
    const error = new Error('Conexión no disponible');
    error.code = 'PROVIDER_CONNECTION_UNAVAILABLE';
    throw error;
  }
  const prefixes = {
    Anthropic: ['anthropic/'], Gemini: ['google/'], OpenAI: ['openai/'], DeepSeek: ['deepseek/'],
    xAI: ['x-ai/', 'xai/'], Kimi: ['moonshotai/', 'moonshot/'], Meta: ['meta/', 'llama/'],
  };
  const model = stripVendorPrefix(requested, prefixes[provider] || []);
  if (provider === 'Anthropic') return { provider, model, client: createAnthropicStreamingClient({
    apiKey: env.ANTHROPIC_API_KEY || env.SIRA_ANTHROPIC_API_KEY, sdkClient: anthropicSdkClient,
  }) };
  // The shared adapters own first-party endpoints and optional base URLs.
  if (provider === 'xAI' && env === process.env && OpenAIImpl === OpenAI) {
    return { provider, model, client: createXaiClient({ fetchImpl }) };
  }
  if (provider === 'Kimi' && env === process.env && OpenAIImpl === OpenAI) {
    return { provider, model, client: createMoonshotClient({ fetchImpl }) };
  }
  const connections = {
    OpenAI: { apiKey: env.OPENAI_API_KEY },
    DeepSeek: { apiKey: env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' },
    Gemini: { apiKey: env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
    OpenRouter: { apiKey: env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' },
    xAI: { apiKey: env.XAI_API_KEY, baseURL: env.XAI_BASE_URL || 'https://api.x.ai/v1' },
    Kimi: { apiKey: env.MOONSHOT_API_KEY || env.KIMI_API_KEY, baseURL: env.MOONSHOT_BASE_URL || env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1' },
    Meta: { apiKey: env.MODEL_API_KEY || env.META_API_KEY || env.LLAMA_API_KEY, baseURL: env.META_BASE_URL || env.LLAMA_BASE_URL || 'https://api.meta.ai/v1' },
    Groq: { apiKey: env.GROQ_API_KEY, baseURL: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1' },
    Mistral: { apiKey: env.MISTRAL_API_KEY, baseURL: env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1' },
    Cerebras: { apiKey: env.CEREBRAS_API_KEY, baseURL: env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1' },
    'Z.ai': { apiKey: env.ZAI_API_KEY, baseURL: env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4' },
  };
  if (!connections[provider]) {
    const error = new Error('Este modelo no admite esta operación.');
    error.code = 'E_PROVIDER';
    throw error;
  }
  return { provider, model, client: new OpenAIImpl({ ...connections[provider], maxRetries: 0, ...(fetchImpl ? { fetch: fetchImpl } : {}) }) };
}

function parseStructuredObject(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 100_000) throw outputError();
  // Extract only a complete balanced span. Do not invent missing braces,
  // modify string values, remove callbacks or evaluate JavaScript.
  let value;
  try { value = JSON.parse(sliceJsonSpan(stripCodeFence(raw))); }
  catch (_) { throw outputError(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw outputError();
  return value;
}

async function completeStructured({ model, prompt, systemPrompt, temperature, maxTokens, signal, validate, clientOptions }) {
  signal?.throwIfAborted();
  const routed = clientForModel(model, clientOptions);
  const params = {
    model: routed.model,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
    temperature, max_tokens: maxTokens, stream: false,
  };
  if (routed.provider === 'OpenAI') {
    stripUnsupportedSampling(routed.model, params);
    params.max_completion_tokens = params.max_tokens;
    delete params.max_tokens;
  }
  if (routed.provider === 'Anthropic') Object.assign(params,
    resolveAnthropicEffortControls({ model: routed.model, level: 'disabled', maxTokens }));
  if (!['Gemini', 'Anthropic'].includes(routed.provider)) params.response_format = { type: 'json_object' };
  const options = { signal, maxRetries: 0 };
  let response;
  try { response = await routed.client.chat.completions.create(params, options); }
  catch (error) {
    // Only a specific unsupported JSON-mode 400 permits the same-model
    // compatibility request; quotas, auth, network and unrelated 400s stop.
    if (signal?.aborted || Number(error?.status) !== 400 || !params.response_format
      || !/response_format|json_object/i.test(String(error?.message || ''))
      || !/unsupported|not supported|not support|unknown parameter/i.test(String(error?.message || ''))) throw error;
    const compatible = { ...params };
    delete compatible.response_format;
    response = await routed.client.chat.completions.create(compatible, options);
  }
  signal?.throwIfAborted();
  if (response?.choices?.[0]?.finish_reason === 'length') throw outputError();
  const parsed = parseStructuredObject(response?.choices?.[0]?.message?.content);
  if (!validate(parsed)) throw outputError();
  return parsed;
}

module.exports = { clientForModel, completeStructured, parseStructuredObject, publicGenerationError };
