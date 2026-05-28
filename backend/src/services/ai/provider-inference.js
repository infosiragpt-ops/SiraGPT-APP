'use strict';

/**
 * provider-inference — map a model id to the upstream provider name
 * SiraGPT routes through.
 *
 * Background: most call sites in `routes/ai.js` start from a
 * `(provider, model)` pair the client sent. A few code paths only
 * carry the model id — pinned Custom GPTs, org-default models,
 * agentic-override branches. This helper canonicalises that mapping
 * in ONE place so every site picks the same provider for the same id.
 *
 * The mapping is intentionally substring-based and conservative — it
 * defaults to "OpenAI" when nothing else matches, because the OpenAI
 * SDK is the safe fallback for OpenAI-shaped traffic.
 *
 * Public API:
 *   inferProviderFromModelId(modelId) → string
 *   listKnownProviders() → string[]
 */

const KNOWN_PROVIDERS = Object.freeze([
  'DeepSeek',
  'Gemini',
  'OpenRouter',
  'Anthropic',
  'Groq',
  'Mistral',
  'OpenAI',
]);

function isDirectDeepSeekModel(modelName) {
  return /^deepseek-(v\d|chat|reasoner)/i.test(String(modelName || '').trim());
}

function inferProviderFromModelId(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (!m) return 'OpenAI';

  // 1) Direct-API providers we explicitly route to.
  if (isDirectDeepSeekModel(m)) return 'DeepSeek';

  // 2) OpenRouter — slug-prefixed models go through the OpenRouter
  //    aggregator, regardless of who originally trained them.
  if (
    m.includes('openai/') || m.includes('google/')
    || m.includes('x-ai/') || m.includes('openrouter/') || m.includes('anthropic/')
    || m.includes('meta-llama/') || m.includes('deepseek/')
    || m.includes('/gpt-oss') || m.includes('moonshotai/')
    || m.includes('qwen/') || m.includes('mistralai/')
    || m.includes('z-ai/') || m.includes('cohere/') || m.includes('nousresearch/')
  ) return 'OpenRouter';

  // 3) Google Gemini family.
  if (m.includes('gemini') || m.includes('imagen')) return 'Gemini';

  // 4) Groq direct — the `-versatile` suffix is the Groq SKU.
  if (m.endsWith('-versatile')) return 'Groq';

  // 5) Anthropic direct (when no aggregator prefix). The OpenAI-shaped
  //    Anthropic SDK route uses `claude-*` ids without a slash.
  if (/^claude(-|_)/.test(m)) return 'Anthropic';

  // 6) Mistral direct — bare `mistral-*` or `codestral-*` ids.
  if (m.startsWith('mistral-') || m.startsWith('codestral-')) return 'Mistral';

  return 'OpenAI';
}

function listKnownProviders() {
  return KNOWN_PROVIDERS.slice();
}

module.exports = {
  inferProviderFromModelId,
  isDirectDeepSeekModel,
  listKnownProviders,
  KNOWN_PROVIDERS,
};
