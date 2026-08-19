const { listFalVideoModels } = require('./fal-video-catalog');

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
    key: 'fal',
    provider: 'Fal.ai',
    displayName: 'Fal.ai Video',
    apiKeyEnv: 'FAL_KEY',
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
    description: model.description || '',
    contextLength: model.contextLength || model.context_length || null,
    maxTokens: model.maxTokens || model.max_tokens || null,
    reasoning: model.reasoning === true,
    input: Array.isArray(model.input) ? [...model.input] : ['text'],
    icon: model.icon || null,
    qualityRank: model.qualityRank || null,
    qualityLabel: model.qualityLabel || null,
    speedTier: model.speedTier || null,
    capabilities: model.capabilities || null,
    fal: model.fal || null,
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
      qualityRank: normalized.qualityRank,
      qualityLabel: normalized.qualityLabel,
      speedTier: normalized.speedTier,
      fal: normalized.fal,
      maxTokens: normalized.maxTokens,
      compat: normalized.compat,
    };
  }

  return normalized;
}

function listManifestModels({ provider = null, type = null } = {}) {
  const providerName = provider ? canonicalProvider(provider) : null;
  const falModels = !providerName || providerName === 'Fal.ai'
    ? listFalVideoModels()
    : [];

  return [...STATIC_MODEL_MANIFEST, ...falModels]
    .filter((model) => !providerName || model.provider === providerName)
    .filter((model) => !type || model.type === type)
    .map((model) => normalizeModelRecord(model, model.provider, 'static_manifest'));
}

function mergeProviderModels(liveModels = [], provider) {
  const providerName = canonicalProvider(provider);
  const byName = new Map();

  for (const model of listManifestModels({ provider: providerName })) {
    byName.set(model.name, model);
  }

  for (const liveModel of liveModels || []) {
    const normalizedLive = normalizeModelRecord(liveModel, providerName, 'api');
    const manifestModel = byName.get(normalizedLive.name);
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

module.exports = {
  PROVIDER_CATALOGS,
  STATIC_MODEL_MANIFEST,
  getProviderCatalogDiagnostics,
  listManifestModels,
  mergeProviderModels,
  normalizeModelRecord,
};
