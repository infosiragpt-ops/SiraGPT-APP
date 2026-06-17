const { listFalVideoModels } = require('./fal-video-model-catalog');

const PROVIDER_CATALOGS = Object.freeze([
  {
    key: 'openai',
    provider: 'OpenAI',
    displayName: 'OpenAI',
    apiKeyEnv: 'OPENAI_API_KEY',
    supportsModelCatalog: true,
  },
  {
    key: 'gemini',
    provider: 'Gemini',
    displayName: 'Google Gemini',
    apiKeyEnv: 'GEMINI_API_KEY',
    supportsModelCatalog: true,
  },
  {
    key: 'openrouter',
    provider: 'OpenRouter',
    displayName: 'OpenRouter',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    supportsModelCatalog: true,
  },
  {
    key: 'deepseek',
    provider: 'DeepSeek',
    displayName: 'DeepSeek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    supportsModelCatalog: true,
  },
  {
    key: 'falai',
    provider: 'fal.ai',
    displayName: 'fal.ai Video',
    apiKeyEnv: 'FAL_API_KEY',
    supportsModelCatalog: true,
  },
]);

const STATIC_MODEL_MANIFEST = Object.freeze([
  {
    id: 'gpt-4o',
    name: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'OpenAI',
    type: 'TEXT',
    description: 'OpenAI multimodal flagship model for professional chat, analysis, code and document work.',
    contextLength: 128000,
    tags: ['openai', 'text', 'multimodal', 'tools', 'professional'],
  },
  {
    id: 'gpt-4o-mini',
    name: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    provider: 'OpenAI',
    type: 'TEXT',
    description: 'Fast OpenAI model for everyday chat, low-latency routing and cost-efficient workflows.',
    contextLength: 128000,
    tags: ['openai', 'text', 'fast', 'efficient'],
  },
  {
    id: 'gemini-2.5-pro',
    name: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    provider: 'Gemini',
    type: 'TEXT',
    description: 'Google Gemini Pro model for complex reasoning, long-context analysis and multimodal work.',
    contextLength: 2000000,
    tags: ['gemini', 'google', 'text', 'reasoning', 'long-context', 'professional'],
  },
  {
    id: 'gemini-2.5-flash',
    name: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    provider: 'Gemini',
    type: 'TEXT',
    description: 'Fast Gemini model for everyday chat, summarization and responsive multimodal workflows.',
    contextLength: 1000000,
    tags: ['gemini', 'google', 'text', 'fast', 'long-context'],
  },
  {
    id: 'deepseek-v4-flash',
    name: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    provider: 'DeepSeek',
    type: 'TEXT',
    description: 'DeepSeek V4 Flash for low-latency chat, paraphrasing, drafting and high-throughput assistance.',
    contextLength: 1000000,
    maxTokens: 384000,
    reasoning: true,
    pricing: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0, unit: 'per_1m_tokens' },
    compat: { supportsUsageInStreaming: true, supportsReasoningEffort: true, maxTokensField: 'max_tokens' },
    tags: ['deepseek', 'text', 'fast', 'efficient', 'reasoning', 'v4'],
  },
  {
    id: 'deepseek-v4-pro',
    name: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    provider: 'DeepSeek',
    type: 'TEXT',
    description: 'DeepSeek V4 Pro for professional reasoning, code, document generation and complex Spanish workflows.',
    contextLength: 1000000,
    maxTokens: 384000,
    reasoning: true,
    pricing: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0, unit: 'per_1m_tokens' },
    compat: { supportsUsageInStreaming: true, supportsReasoningEffort: true, maxTokensField: 'max_tokens' },
    tags: ['deepseek', 'text', 'reasoning', 'professional', 'v4'],
  },
  {
    id: 'deepseek-chat',
    name: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    provider: 'DeepSeek',
    type: 'TEXT',
    description: 'DeepSeek direct chat model for reliable non-reasoning conversational tasks.',
    contextLength: 131072,
    maxTokens: 8192,
    reasoning: false,
    pricing: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0, unit: 'per_1m_tokens' },
    compat: { supportsUsageInStreaming: true, maxTokensField: 'max_tokens' },
    tags: ['deepseek', 'text', 'chat'],
  },
  {
    id: 'deepseek-reasoner',
    name: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner',
    provider: 'DeepSeek',
    type: 'TEXT',
    description: 'DeepSeek reasoning model for deeper analysis, code planning and complex problem solving.',
    contextLength: 131072,
    maxTokens: 65536,
    reasoning: true,
    pricing: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0, unit: 'per_1m_tokens' },
    compat: { supportsUsageInStreaming: true, supportsReasoningEffort: false, maxTokensField: 'max_tokens' },
    tags: ['deepseek', 'text', 'reasoning'],
  },
  {
    id: 'moonshotai/kimi-k2.6',
    name: 'moonshotai/kimi-k2.6',
    displayName: 'Kimi K2.6',
    provider: 'OpenRouter',
    type: 'TEXT',
    description: 'Moonshot Kimi K2.6 via OpenRouter for long-context chat, coding, agents and multimodal analysis.',
    contextLength: 200000,
    tags: ['openrouter', 'kimi', 'moonshot', 'text', 'long-context', 'agents'],
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'anthropic/claude-3.5-sonnet',
    displayName: 'Claude 3.5 Sonnet',
    provider: 'OpenRouter',
    type: 'TEXT',
    description: 'Anthropic Claude Sonnet through OpenRouter for balanced reasoning, writing and code assistance.',
    contextLength: 200000,
    tags: ['openrouter', 'anthropic', 'claude', 'text', 'reasoning'],
  },
  {
    id: 'x-ai/grok-4',
    name: 'x-ai/grok-4',
    displayName: 'Grok 4',
    provider: 'OpenRouter',
    type: 'TEXT',
    description: 'xAI Grok through OpenRouter for reasoning-heavy chat and current-event style assistance.',
    contextLength: 256000,
    tags: ['openrouter', 'xai', 'grok', 'text', 'reasoning'],
  },
  {
    id: 'meta-llama/llama-3.1-70b-instruct',
    name: 'meta-llama/llama-3.1-70b-instruct',
    displayName: 'Llama 3.1 70B Instruct',
    provider: 'OpenRouter',
    type: 'TEXT',
    description: 'Meta Llama through OpenRouter for general chat, multilingual work and open-model routing.',
    contextLength: 131000,
    tags: ['openrouter', 'meta', 'llama', 'text', 'open-model'],
  },
  {
    id: 'openai/gpt-5.4-image-2',
    name: 'openai/gpt-5.4-image-2',
    displayName: 'GPT-5.4 Image 2',
    provider: 'OpenRouter',
    type: 'IMAGE',
    description: 'OpenAI GPT-5.4 Image 2 via OpenRouter for high quality image generation.',
    tags: ['openrouter', 'openai', 'gpt', 'image', 'professional'],
  },
  {
    id: 'google/gemini-3.1-flash-image-preview',
    name: 'google/gemini-3.1-flash-image-preview',
    displayName: 'Gemini 3.1 Flash Image',
    provider: 'OpenRouter',
    type: 'IMAGE',
    description: 'Google Gemini 3.1 Flash Image Preview via OpenRouter with fast image generation.',
    tags: ['openrouter', 'google', 'gemini', 'image', 'fast'],
  },
  {
    id: 'google/gemini-3-pro-image-preview',
    name: 'google/gemini-3-pro-image-preview',
    displayName: 'Gemini 3 Pro Image',
    provider: 'OpenRouter',
    type: 'IMAGE',
    description: 'Google Gemini 3 Pro Image Preview via OpenRouter for professional image generation.',
    tags: ['openrouter', 'google', 'gemini', 'image', 'professional'],
  },
  {
    id: 'google/gemini-2.5-flash-image',
    name: 'google/gemini-2.5-flash-image',
    displayName: 'Gemini 2.5 Flash Image',
    provider: 'OpenRouter',
    type: 'IMAGE',
    description: 'Google Gemini 2.5 Flash Image via OpenRouter for reliable image fallback generation.',
    tags: ['openrouter', 'google', 'gemini', 'image', 'fast'],
  },
  {
    id: 'bytedance-seed/seedream-4.5',
    name: 'bytedance-seed/seedream-4.5',
    displayName: 'Seedream 4.5',
    provider: 'OpenRouter',
    type: 'IMAGE',
    description: 'ByteDance Seedream 4.5 via OpenRouter for professional image generation.',
    tags: ['openrouter', 'bytedance', 'seedream', 'image', 'professional'],
  },
  {
    id: 'recraftai/recraft-v3',
    name: 'recraftai/recraft-v3',
    displayName: 'Recraft V3',
    provider: 'OpenRouter',
    type: 'IMAGE',
    description: 'Recraft V3 via OpenRouter: vector art, illustration and branding.',
    tags: ['openrouter', 'recraft', 'image', 'illustration', 'branding'],
  },
  {
    id: 'ideogram/ideogram-v2',
    name: 'ideogram/ideogram-v2',
    displayName: 'Ideogram V2',
    provider: 'OpenRouter',
    type: 'IMAGE',
    description: 'Ideogram V2 via OpenRouter: text-in-image generation and typography.',
    tags: ['openrouter', 'ideogram', 'image', 'typography'],
  },
  {
    id: 'black-forest-labs/flux-1.1-pro',
    name: 'black-forest-labs/flux-1.1-pro',
    displayName: 'Flux 1.1 Pro',
    provider: 'OpenRouter',
    type: 'IMAGE',
    description: 'Flux 1.1 Pro via OpenRouter: photorealistic image generation.',
    tags: ['openrouter', 'flux', 'image', 'photorealistic', 'professional'],
  },
  {
    id: 'black-forest-labs/flux-1.1-ultra',
    name: 'black-forest-labs/flux-1.1-ultra',
    displayName: 'Flux 1.1 Ultra',
    provider: 'OpenRouter',
    type: 'IMAGE',
    description: 'Flux 1.1 Ultra via OpenRouter: maximum quality image generation.',
    tags: ['openrouter', 'flux', 'image', 'photorealistic', 'ultra'],
  },
  {
    id: 'gpt-image-2',
    name: 'gpt-image-2',
    displayName: 'GPT Image 2',
    provider: 'OpenAI',
    type: 'IMAGE',
    description: 'OpenAI GPT Image 2: high quality image generation through the direct OpenAI Images API.',
    tags: ['openai', 'gpt', 'image', 'professional'],
  },
  {
    id: 'gpt-image-1',
    name: 'gpt-image-1',
    displayName: 'GPT Image 1',
    provider: 'OpenAI',
    type: 'IMAGE',
    description: 'OpenAI GPT Image 1: reliable image generation through the direct OpenAI Images API.',
    tags: ['openai', 'gpt', 'image', 'reliable'],
  },
  {
    id: 'gpt-image-1.5',
    name: 'gpt-image-1.5',
    displayName: 'GPT Image 1.5',
    provider: 'OpenAI',
    type: 'IMAGE',
    description: 'OpenAI GPT Image 1.5: reliable image generation through the direct OpenAI Images API.',
    tags: ['openai', 'gpt', 'image', 'reliable'],
  },
  {
    id: 'gpt-image-1-mini',
    name: 'gpt-image-1-mini',
    displayName: 'GPT Image 1 Mini',
    provider: 'OpenAI',
    type: 'IMAGE',
    description: 'OpenAI GPT Image 1 Mini: compact image generation through the direct OpenAI Images API.',
    tags: ['openai', 'gpt', 'image', 'fast'],
  },
  {
    id: 'gpt-image-2-2026-04-21',
    name: 'gpt-image-2-2026-04-21',
    displayName: 'GPT Image 2 (2026-04-21)',
    provider: 'OpenAI',
    type: 'IMAGE',
    description: 'Pinned OpenAI GPT Image 2 release for high quality image generation.',
    tags: ['openai', 'gpt', 'image', 'professional'],
  },
  {
    id: 'dall-e-3',
    name: 'dall-e-3',
    displayName: 'DALL-E 3',
    provider: 'OpenAI',
    type: 'IMAGE',
    description: 'DALL-E 3 de OpenAI: generacion de imagenes creativa y detallada.',
    tags: ['openai', 'dall-e', 'image', 'creative'],
  },
  {
    id: 'dall-e-2',
    name: 'dall-e-2',
    displayName: 'DALL-E 2',
    provider: 'OpenAI',
    type: 'IMAGE',
    description: 'DALL-E 2 de OpenAI: generacion de imagenes rapida y economica.',
    tags: ['openai', 'dall-e', 'image', 'fast'],
  },
  {
    id: 'imagen-4.0-generate-001',
    name: 'imagen-4.0-generate-001',
    displayName: 'Imagen 4',
    provider: 'Gemini',
    type: 'IMAGE',
    description: 'Imagen 4 de Google: generacion de imagenes fotorealistas.',
    tags: ['gemini', 'google', 'imagen', 'image', 'photorealistic'],
  },
  {
    id: 'fal-ai/flux/schnell',
    name: 'fal-ai/flux/schnell',
    displayName: 'FLUX Schnell (fal.ai)',
    provider: 'Fal',
    type: 'IMAGE',
    description: 'FLUX.1 [schnell] vía fal.ai: generación de imágenes ultrarrápida (1-3 s), ideal para evitar timeouts.',
    pricing: { provider: 'fal.ai', billing: 'per_generation' },
    tags: ['fal.ai', 'flux', 'image', 'fast'],
  },
  {
    id: 'fal-ai/flux/dev',
    name: 'fal-ai/flux/dev',
    displayName: 'FLUX Dev (fal.ai)',
    provider: 'Fal',
    type: 'IMAGE',
    description: 'FLUX.1 [dev] vía fal.ai: alta calidad fotorealista con buen balance velocidad/detalle.',
    pricing: { provider: 'fal.ai', billing: 'per_generation' },
    tags: ['fal.ai', 'flux', 'image', 'photorealistic'],
  },
  {
    id: 'fal-ai/flux-pro/v1.1',
    name: 'fal-ai/flux-pro/v1.1',
    displayName: 'FLUX 1.1 Pro (fal.ai)',
    provider: 'Fal',
    type: 'IMAGE',
    description: 'FLUX 1.1 Pro vía fal.ai: máxima calidad profesional de imagen.',
    pricing: { provider: 'fal.ai', billing: 'per_generation' },
    tags: ['fal.ai', 'flux', 'image', 'professional', 'ultra'],
  },
  // ── VIDEO models via fal.ai, ordered from highest to lower quality ──────
  ...listFalVideoModels(),
  // ── AUDIO models ───────────────────────────────────────────────────────
  {
    id: 'whisper-1',
    name: 'whisper-1',
    displayName: 'Whisper',
    provider: 'OpenAI',
    type: 'AUDIO',
    description: 'OpenAI Whisper: transcripción y traducción de audio a texto de alta precisión.',
    tags: ['openai', 'audio', 'speech-to-text', 'transcription'],
  },
  {
    id: 'tts-1',
    name: 'tts-1',
    displayName: 'TTS-1',
    provider: 'OpenAI',
    type: 'AUDIO',
    description: 'OpenAI TTS-1: síntesis de voz natural para text-to-speech de baja latencia.',
    tags: ['openai', 'audio', 'text-to-speech', 'voice', 'fast'],
  },
  {
    id: 'tts-1-hd',
    name: 'tts-1-hd',
    displayName: 'TTS-1 HD',
    provider: 'OpenAI',
    type: 'AUDIO',
    description: 'OpenAI TTS-1 HD: síntesis de voz de alta calidad para producción de contenido.',
    tags: ['openai', 'audio', 'text-to-speech', 'voice', 'hd', 'professional'],
  },
  {
    id: 'gemini-2.5-flash-tts',
    name: 'gemini-2.5-flash-tts',
    displayName: 'Gemini 2.5 Flash TTS',
    provider: 'Gemini',
    type: 'AUDIO',
    description: 'Google Gemini 2.5 Flash TTS: síntesis de voz expresiva y multilingüe.',
    tags: ['gemini', 'google', 'audio', 'text-to-speech', 'voice', 'multilingual'],
  },
  {
    id: 'eleven-multilingual-v2',
    name: 'eleven-multilingual-v2',
    displayName: 'ElevenLabs Multilingual V2',
    provider: 'OpenRouter',
    type: 'AUDIO',
    description: 'ElevenLabs Multilingual V2 via OpenRouter: voz ultra-realista en 29 idiomas.',
    tags: ['openrouter', 'elevenlabs', 'audio', 'text-to-speech', 'voice', 'multilingual'],
  },
  {
    id: 'eleven-turbo-v2',
    name: 'eleven-turbo-v2',
    displayName: 'ElevenLabs Turbo V2',
    provider: 'OpenRouter',
    type: 'AUDIO',
    description: 'ElevenLabs Turbo V2 via OpenRouter: síntesis de voz de baja latencia para streaming.',
    tags: ['openrouter', 'elevenlabs', 'audio', 'text-to-speech', 'voice', 'fast'],
  },
  // ── MUSIC models ───────────────────────────────────────────────────────
  {
    id: 'suno-v4',
    name: 'suno-v4',
    displayName: 'Suno V4',
    provider: 'OpenRouter',
    type: 'MUSIC',
    description: 'Suno V4 via OpenRouter: generación de música completa con voz y letra desde texto.',
    tags: ['openrouter', 'suno', 'music', 'text-to-music', 'generative'],
  },
  {
    id: 'suno-v3.5',
    name: 'suno-v3.5',
    displayName: 'Suno V3.5',
    provider: 'OpenRouter',
    type: 'MUSIC',
    description: 'Suno V3.5 via OpenRouter: generación de canciones completas con letra.',
    tags: ['openrouter', 'suno', 'music', 'text-to-music'],
  },
  {
    id: 'udio-130',
    name: 'udio-130',
    displayName: 'Udio 130',
    provider: 'OpenRouter',
    type: 'MUSIC',
    description: 'Udio 130 via OpenRouter: generación de música instrumental y con voz de alta calidad.',
    tags: ['openrouter', 'udio', 'music', 'text-to-music', 'instrumental'],
  },
]);

const PROVIDER_BY_NAME = Object.freeze(
  PROVIDER_CATALOGS.reduce((acc, provider) => {
    acc[provider.provider.toLowerCase()] = provider;
    acc[provider.key] = provider;
    return acc;
  }, {})
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compactTags(tags) {
  return [...new Set((tags || []).filter(Boolean).map((tag) => String(tag).trim()).filter(Boolean))];
}

function canonicalProvider(provider) {
  const key = String(provider || '').trim().toLowerCase();
  return PROVIDER_BY_NAME[key]?.provider || provider;
}

function defaultTagsFor(model) {
  const tags = [
    String(model.provider || '').toLowerCase(),
    String(model.type || 'TEXT').toLowerCase(),
  ];
  const id = String(model.name || model.id || '').toLowerCase();

  if (id.includes('flash') || id.includes('mini')) tags.push('fast', 'efficient');
  if (id.includes('pro') || id.includes('sonnet') || id.includes('grok')) tags.push('professional');
  if (id.includes('reason')) tags.push('reasoning');
  if (id.includes('kimi')) tags.push('kimi');
  if (id.includes('claude')) tags.push('claude', 'anthropic');
  if (id.includes('llama')) tags.push('llama', 'meta');
  if (id.includes('deepseek')) tags.push('deepseek');
  if (id.includes('gemini')) tags.push('gemini', 'google');
  if (id.includes('gpt')) tags.push('openai');

  return compactTags(tags);
}

function normalizeModelRecord(model, providerOverride = null, source = 'api') {
  const provider = canonicalProvider(providerOverride || model.provider);
  const name = model.name || model.id;
  const normalized = {
    id: model.id || name,
    name,
    displayName: model.displayName || model.name || model.id,
    provider,
    type: model.type || 'TEXT',
    icon: model.icon || null,
    description: model.description || '',
    contextLength: model.contextLength || model.context_length || null,
    maxTokens: model.maxTokens || model.max_tokens || null,
    reasoning: model.reasoning === true,
    input: Array.isArray(model.input) ? [...model.input] : ['text'],
    pricing: model.pricing || null,
    compat: model.compat || null,
    isActive: model.isActive !== false,
    tags: compactTags(model.tags || defaultTagsFor({ ...model, provider })),
    apiData: clone(model.apiData || {}),
    syncSource: model.syncSource || model.source || source,
  };

  if (!normalized.apiData.catalog) {
    normalized.apiData.catalog = {
      source,
      supportsModelCatalog: true,
      provider,
      reasoning: normalized.reasoning,
      input: normalized.input,
      maxTokens: normalized.maxTokens,
      compat: normalized.compat,
    };
  }

  return normalized;
}

function listManifestModels({ provider = null, type = null } = {}) {
  const providerName = provider ? canonicalProvider(provider) : null;
  return STATIC_MODEL_MANIFEST
    .filter((model) => !providerName || model.provider === providerName)
    .filter((model) => !type || model.type === type)
    .map((model) => normalizeModelRecord(model, model.provider, 'static_manifest'));
}

function mergeProviderModels(liveModels = [], provider, options = {}) {
  const providerName = canonicalProvider(provider);
  const byName = new Map();

  if (options.includeManifestOnly !== false) {
    for (const model of listManifestModels({ provider: providerName })) {
      byName.set(model.name, model);
    }
  }

  for (const liveModel of liveModels || []) {
    const normalizedLive = normalizeModelRecord(liveModel, providerName, 'api');
    const manifestModel = byName.get(normalizedLive.name)
      || listManifestModels({ provider: providerName }).find((model) => model.name === normalizedLive.name);
    if (!manifestModel) {
      byName.set(normalizedLive.name, normalizedLive);
      continue;
    }

    byName.set(normalizedLive.name, {
      ...manifestModel,
      ...normalizedLive,
      displayName: normalizedLive.displayName || manifestModel.displayName,
      description: normalizedLive.description || manifestModel.description,
      contextLength: normalizedLive.contextLength || manifestModel.contextLength,
      maxTokens: normalizedLive.maxTokens || manifestModel.maxTokens,
      reasoning: normalizedLive.reasoning || manifestModel.reasoning,
      input: normalizedLive.input?.length ? normalizedLive.input : manifestModel.input,
      pricing: normalizedLive.pricing || manifestModel.pricing,
      compat: normalizedLive.compat || manifestModel.compat,
      tags: compactTags([...(manifestModel.tags || []), ...(normalizedLive.tags || [])]),
      apiData: {
        ...manifestModel.apiData,
        ...normalizedLive.apiData,
        catalog: {
          source: 'api_catalog_merge',
          supportsModelCatalog: true,
          provider: providerName,
          reasoning: normalizedLive.reasoning || manifestModel.reasoning,
          input: normalizedLive.input?.length ? normalizedLive.input : manifestModel.input,
          maxTokens: normalizedLive.maxTokens || manifestModel.maxTokens,
          compat: normalizedLive.compat || manifestModel.compat,
        },
      },
      syncSource: 'api_catalog_merge',
    });
  }

  return [...byName.values()];
}

function hasConfiguredApiKey(envName) {
  const value = process.env[envName];
  return Boolean(value && !String(value).toLowerCase().includes('dummy'));
}

function getProviderCatalogDiagnostics({ includeModels = false } = {}) {
  return PROVIDER_CATALOGS.map((provider) => {
    const models = listManifestModels({ provider: provider.provider });
    return {
      key: provider.key,
      provider: provider.provider,
      displayName: provider.displayName,
      supportsModelCatalog: provider.supportsModelCatalog,
      apiKeyEnv: provider.apiKeyEnv,
      hasApiKey: hasConfiguredApiKey(provider.apiKeyEnv),
      staticModelCount: models.length,
      source: 'static_manifest',
      ...(includeModels ? { models } : {}),
    };
  });
}

// Curated set of IMAGE models that should be ACTIVE and selectable out of the
// box. Keep this to models verified against the production credentials; models
// that require different billing or provider keys remain in the catalog but
// inactive until an admin validates them. This set is shared with the seeding
// layer and /generate-image allow-list, so active defaults are accepted by chat.
const DEFAULT_ACTIVE_IMAGE_MODEL_NAMES = new Set([
  'gpt-image-2',
  'gpt-image-1',
  'gpt-image-1.5',
  'gpt-image-1-mini',
  'gpt-image-2-2026-04-21',
  'black-forest-labs/flux-1.1-pro',
  'google/gemini-3.1-flash-image-preview',
  'google/gemini-3-pro-image-preview',
  'google/gemini-2.5-flash-image',
]);

module.exports = {
  PROVIDER_CATALOGS,
  STATIC_MODEL_MANIFEST,
  DEFAULT_ACTIVE_IMAGE_MODEL_NAMES,
  getProviderCatalogDiagnostics,
  listManifestModels,
  mergeProviderModels,
  normalizeModelRecord,
};
