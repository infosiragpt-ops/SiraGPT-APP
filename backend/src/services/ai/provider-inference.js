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
  'Z.ai',
  'Kimi',
  'Cerebras',
  'Meta',
  'xAI',
  'Custom',
  'OpenAI',
]);

// Strip surrounding whitespace and stray leading/trailing slashes so that
// decorated ids ("  claude-x ", "/mistral-large", "model/") infer the same
// provider as their clean form. Internal slashes (OpenRouter slugs like
// "anthropic/claude-x") are deliberately preserved.
const EDGE_NOISE_RE = /^[\s/]+|[\s/]+$/g;

function normaliseModelId(modelId) {
  let raw;
  if (typeof modelId === 'string') {
    raw = modelId;
  } else if (modelId == null) {
    raw = '';
  } else {
    // Non-string inputs (numbers, objects…) are coerced defensively; hostile
    // values (null-prototype objects, throwing toString) collapse to ''.
    try {
      raw = String(modelId);
    } catch {
      raw = '';
    }
  }
  return raw.replace(EDGE_NOISE_RE, '');
}

function isDirectDeepSeekModel(modelName) {
  return /^deepseek-(v\d|chat|reasoner)/i.test(normaliseModelId(modelName));
}

const CONNECTION_UNAVAILABLE_MESSAGE = 'Conexión no disponible';

/**
 * Whether the named first-party connection has a usable key in env.
 * Missing key → generate must fail, never silently swap vendors.
 */
function providerConnectionReady(provider, env = process.env) {
  const p = String(provider || '').trim();
  if (!p) return false;
  if (/^(custom|sira|ollama|huggingface)$/i.test(p)) return true;
  const has = (...names) => names.some((name) => String((env && env[name]) || '').trim().length > 0);
  if (/^anthropic$/i.test(p)) return has('ANTHROPIC_API_KEY', 'SIRA_ANTHROPIC_API_KEY');
  if (/^gemini$/i.test(p)) return has('GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY');
  if (/^openai$/i.test(p)) return has('OPENAI_API_KEY');
  if (/^(kimi|moonshot)$/i.test(p)) return has('MOONSHOT_API_KEY', 'KIMI_API_KEY');
  if (/^deepseek$/i.test(p)) return has('DEEPSEEK_API_KEY');
  if (/^openrouter$/i.test(p)) return has('OPENROUTER_API_KEY');
  if (/^groq$/i.test(p)) return has('GROQ_API_KEY');
  if (/^mistral$/i.test(p)) return has('MISTRAL_API_KEY');
  if (/^(xai|x-ai|grok)$/i.test(p)) return has('XAI_API_KEY');
  if (/^(meta|llama)$/i.test(p)) return has('MODEL_API_KEY', 'META_API_KEY', 'LLAMA_API_KEY');
  if (/^cerebras$/i.test(p)) return has('CEREBRAS_API_KEY');
  if (/^(z\.ai|zai)$/i.test(p)) return has('ZAI_API_KEY');
  return has(`${p.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`);
}

function inferProviderFromModelId(modelId) {
  const m = normaliseModelId(modelId).toLowerCase();
  if (!m) return 'OpenAI';

  // 0) Local SiraGPT Mini (Custom/Ollama). Never infer OpenAI/DeepSeek —
  //    that silent swap sent Mini turns to Sira Rápido.
  if (
    m === 'sira-mini' || m === 'siragpt-mini' || m === 'sira mini' || m === 'siragpt mini'
    || m === 'moondream' || m.startsWith('moondream:')
    || m === 'gemma4' || m.startsWith('gemma4:')
  ) return 'Custom';

  // 1) Direct-API providers we explicitly route to.
  if (isDirectDeepSeekModel(m)) return 'DeepSeek';

  // 2) First-party catalog families — their own connection, never the
  //    OpenRouter mixer. Slug prefixes (anthropic/, google/, openai/,
  //    moonshotai/) used to dump Claude/Gemini/GPT/Kimi onto OpenRouter.
  if (m.startsWith('anthropic/') || /^claude(-|_)/.test(m)) return 'Anthropic';
  if (m.includes('gemini') || m.includes('imagen') || (m.startsWith('google/') && /gemini|imagen/.test(m))) {
    return 'Gemini';
  }
  if (
    m.startsWith('kimi-') || m.startsWith('kimi.') || m.startsWith('moonshot-')
    || m.startsWith('moonshotai-') || m.startsWith('moonshotai/')
  ) return 'Kimi';
  if (m.startsWith('openai/') && !m.includes('gpt-oss')) return 'OpenAI';

  // 3) xAI Grok — including OpenRouter-style `x-ai/grok-*` slugs. The picker
  //    label "Grok 4.5" must hit xAI, not the mixer and not DeepSeek.
  if (
    m.includes('x-ai/')
    || m.includes('xai/')
    || m === 'grok'
    || m.startsWith('grok-')
    || m.startsWith('grok_')
    || /\bgrok\b/.test(m)
  ) return 'xAI';

  // 4) Leftover OpenRouter mixer prefixes only (not first-party families).
  if (
    m.startsWith('openrouter/')
    || m.includes('meta-llama/') || m.includes('deepseek/')
    || m.includes('/gpt-oss') || m.includes('qwen/') || m.includes('mistralai/')
    || m.includes('z-ai/') || m.includes('cohere/') || m.includes('nousresearch/')
    || m.includes('openai/gpt-oss')
  ) return 'OpenRouter';

  // 4) Groq direct — the `-versatile` suffix is the Groq SKU.
  if (m.endsWith('-versatile')) return 'Groq';

  // 5) Mistral direct — bare `mistral-*`/`codestral-*` ids, incl. the
  //    suffixless `mistral`/`codestral` aliases (else they fell through to OpenAI).
  if (m === 'mistral' || m.startsWith('mistral-') || m === 'codestral' || m.startsWith('codestral-')) return 'Mistral';

  // 6) Z.ai GLM family — bare `glm-*` ids (slug `z-ai/...` already → OpenRouter).
  if (m.startsWith('glm-') || m.startsWith('glm4') || m.startsWith('glm_')) return 'Z.ai';

  // 7) Meta Model API — Muse Spark / Muse Image (OpenAI-compatible at api.meta.ai).
  //    OpenRouter `meta-llama/...` slugs already matched above. Bare llama-3.*
  //    FlashGPT ids stay Cerebras below; do not steal those.
  if (m.startsWith('muse-') || m.startsWith('llama-4')) return 'Meta';

  // 8) Cerebras / FlashGPT (free tier + cross-plan fallback). BARE ids only —
  //    the OpenRouter slug forms (`meta-llama/...`, `*/gpt-oss*`, `z-ai/...`)
  //    already matched above. The model served varies per deployment
  //    (gpt-oss-120b, llama-3.x, zai-glm-*) but all go through the Cerebras
  //    OpenAI-compatible endpoint; createProviderClient('Cerebras') gates on
  //    CEREBRAS_API_KEY. Without this, a Custom GPT / org-default pinned to a
  //    FlashGPT model id fell through to 'OpenAI' and called an OpenAI model
  //    that doesn't exist.
  if (m === 'gpt-oss' || m.startsWith('gpt-oss-') || /^llama-3(\.|-)/.test(m) || m.startsWith('zai-glm-')) return 'Cerebras';

  // 10) Admin-local Custom (Ollama / HuggingFace / moondream / gemma4). Must not
  //     fall through to OpenAI — that silently swaps the user's pick.
  if (/\bmoondream\b/.test(m) || /\bgemma4\b/.test(m) || m.includes('ollama') || m.includes('huggingface')) return 'Custom';

  return 'OpenAI';
}

/**
 * Resolve the connection that will serve this generate turn.
 * A catalog row's first-party family wins over an OpenRouter mixer label
 * leftover from older clients / curated definitions.
 */
function resolveGenerateProvider(requestedProvider, model) {
  const requested = String(requestedProvider || '').trim();
  const inferred = inferProviderFromModelId(model);
  if (
    inferred === 'Custom'
    || /^(custom|sira|ollama|huggingface)$/i.test(requested)
  ) return 'Custom';
  if (requested && !/^openrouter$/i.test(requested)) {
    if (inferred !== 'OpenRouter' && inferred !== 'OpenAI' && inferred !== requested) {
      return inferred;
    }
    return requested;
  }
  return inferred;
}

function listKnownProviders() {
  return KNOWN_PROVIDERS.slice();
}

module.exports = {
  inferProviderFromModelId,
  resolveGenerateProvider,
  providerConnectionReady,
  isDirectDeepSeekModel,
  listKnownProviders,
  KNOWN_PROVIDERS,
  CONNECTION_UNAVAILABLE_MESSAGE,
};
