'use strict';

/**
 * Pick the harness adapter for (provider, model).
 *
 *   Anthropic                         → anthropic (Messages API)
 *   Gemini                            → gemini (native generateContent)
 *   OpenAI reasoning (o*, gpt-5.x)    → openai-responses
 *   every other OpenAI-compatible API → openai-chat
 *   …and when the model has no native tool calling → prompted-xml around
 *   the provider's text transport.
 *
 * Native-tool support comes from agent-harness/model-capabilities; the
 * harness adds a few hints for models the shared table does not list yet
 * (verified live: Muse Spark, DeepSeek V4, Grok 4.x accept native tools).
 */

const { resolveModelCapabilities } = require('../../agent-harness/model-capabilities');
const { openAIModelSupportsReasoningEffort } = require('../../ai-product-os/litellm-gateway');
const { resolveProviderEndpoint } = require('../provider-config');
const { createAnthropicAdapter } = require('./anthropic');
const { createOpenAIChatAdapter } = require('./openai-chat');
const { createOpenAIResponsesAdapter } = require('./openai-responses');
const { createGeminiAdapter } = require('./gemini');
const { createPromptedXmlAdapter } = require('./prompted-xml');

const HARNESS_CAPABILITY_HINTS = [
  { match: /muse-spark/i, caps: { supportsNativeTools: true, supportsReasoning: true, contextWindow: 128_000, maxOutputTokens: 16_384 } },
  { match: /deepseek-v4/i, caps: { supportsNativeTools: true, supportsReasoning: true, contextWindow: 128_000, maxOutputTokens: 16_384 } },
  { match: /claude-(?:fable|mythos|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)/i, caps: { contextWindow: 1_000_000, maxOutputTokens: 64_000 } },
  { match: /claude-haiku-4/i, caps: { contextWindow: 200_000, maxOutputTokens: 32_000 } },
];

function harnessCapabilities(provider, model, opts = {}) {
  const caps = { ...resolveModelCapabilities(model, { provider, overrides: opts.overrides }) };
  const id = String(model || '').replace(/(\d+)\.(\d+)/g, '$1-$2');
  for (const hint of HARNESS_CAPABILITY_HINTS) {
    if (hint.match.test(id) || hint.match.test(String(model || ''))) Object.assign(caps, hint.caps);
  }
  return caps;
}

/**
 * @param {object} args
 * @param {string} args.provider  SiraGPT provider label ("Anthropic", "xAI", "Meta", …)
 * @param {string} args.model     model id as routed today
 * @param {'auto'|'native'|'prompted'} [args.toolMode]
 * @param {Function} [args.fetchImpl] test seam
 * @param {object} [args.env]     env source (tests)
 * @returns {{ adapter: object, endpoint: object, caps: object, toolMode: 'native'|'prompted' }}
 */
function createAdapter({ provider, model, toolMode = 'auto', fetchImpl, env = process.env, overrides } = {}) {
  const endpoint = resolveProviderEndpoint(provider, env);
  const caps = harnessCapabilities(endpoint.provider, model, { overrides });
  let base;
  if (endpoint.protocol === 'anthropic') base = createAnthropicAdapter({ endpoint, fetchImpl });
  else if (endpoint.protocol === 'gemini') base = createGeminiAdapter({ endpoint, fetchImpl });
  else if (endpoint.provider === 'OpenAI' && openAIModelSupportsReasoningEffort(model)) base = createOpenAIResponsesAdapter({ endpoint, fetchImpl });
  else base = createOpenAIChatAdapter({ endpoint, fetchImpl });

  const native = toolMode === 'native' || (toolMode === 'auto' && (caps.supportsNativeTools || endpoint.protocol !== 'openai'));
  const adapter = native ? base : createPromptedXmlAdapter({ inner: base });
  return { adapter, endpoint: { provider: endpoint.provider, protocol: endpoint.protocol, baseURL: endpoint.baseURL }, caps, toolMode: native ? 'native' : 'prompted' };
}

module.exports = { createAdapter, harnessCapabilities, HARNESS_CAPABILITY_HINTS };
