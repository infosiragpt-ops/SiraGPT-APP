const axios = require('axios');

const LITELLM_PRICING_URL = process.env.LITELLM_MODEL_COST_MAP_URL
  || 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

const PROVIDER_PREFIXES = {
  OpenAI: ['openai'],
  Gemini: ['gemini', 'vertex_ai-language-models'],
  DeepSeek: ['deepseek'],
  OpenRouter: ['openrouter'],
  Groq: ['groq'],
};

class ModelPricingService {
  constructor() {
    this.cache = {
      litellm: { data: null, lastFetch: 0, ttl: 6 * 60 * 60 * 1000 },
      openrouter: { data: null, lastFetch: 0, ttl: 60 * 60 * 1000 },
    };
  }

  async fetchLiteLLMPricing() {
    const now = Date.now();
    if (this.cache.litellm.data && now - this.cache.litellm.lastFetch < this.cache.litellm.ttl) {
      return this.cache.litellm.data;
    }

    const response = await axios.get(LITELLM_PRICING_URL, {
      timeout: 10000,
      headers: { Accept: 'application/json' },
    });

    this.cache.litellm = { ...this.cache.litellm, data: response.data || {}, lastFetch: now };
    return this.cache.litellm.data;
  }

  async fetchOpenRouterPricing() {
    const now = Date.now();
    if (this.cache.openrouter.data && now - this.cache.openrouter.lastFetch < this.cache.openrouter.ttl) {
      return this.cache.openrouter.data;
    }

    const headers = { Accept: 'application/json' };
    if (process.env.OPENROUTER_API_KEY) {
      headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
    }

    const response = await axios.get(OPENROUTER_MODELS_URL, {
      timeout: 15000,
      headers,
    });

    const byId = new Map();
    for (const model of response.data?.data || []) {
      if (model?.id && model?.pricing) byId.set(model.id, model);
    }

    this.cache.openrouter = { ...this.cache.openrouter, data: byId, lastFetch: now };
    return byId;
  }

  normalizeOpenRouterPricing(model) {
    if (!model?.pricing) return null;
    const pricing = model.pricing;
    const input = this.perTokenToPerMillion(pricing.prompt);
    const output = this.perTokenToPerMillion(pricing.completion);

    if (input == null && output == null) return null;

    return {
      input,
      output,
      cacheRead: this.perTokenToPerMillion(pricing.input_cache_read),
      cacheWrite: this.perTokenToPerMillion(pricing.input_cache_write),
      request: this.nullableNumber(pricing.request),
      image: this.nullableNumber(pricing.image),
      webSearch: this.nullableNumber(pricing.web_search),
      internalReasoning: this.perTokenToPerMillion(pricing.internal_reasoning),
      unit: 'per_1m_tokens',
      currency: 'USD',
      source: 'openrouter_models_api',
      sourceUrl: OPENROUTER_MODELS_URL,
      updatedAt: new Date().toISOString(),
      raw: pricing,
    };
  }

  normalizeLiteLLMPricing(key, row) {
    if (!row || typeof row !== 'object') return null;
    const input = this.perTokenToPerMillion(row.input_cost_per_token);
    const output = this.perTokenToPerMillion(row.output_cost_per_token);

    if (input == null && output == null) return null;

    return {
      input,
      output,
      cacheRead: this.perTokenToPerMillion(row.cache_read_input_token_cost),
      cacheWrite: this.perTokenToPerMillion(row.cache_creation_input_token_cost),
      image: this.nullableNumber(row.input_cost_per_image),
      audioInput: this.perTokenToPerMillion(row.input_cost_per_audio_token),
      audioOutput: this.perTokenToPerMillion(row.output_cost_per_audio_token),
      unit: 'per_1m_tokens',
      currency: 'USD',
      source: 'litellm_model_cost_map',
      sourceUrl: row.source || LITELLM_PRICING_URL,
      pricingKey: key,
      updatedAt: new Date().toISOString(),
    };
  }

  async resolvePricing(model) {
    if (model?.provider === 'OpenRouter') {
      const direct = this.normalizeOpenRouterPricing(model.apiData || model);
      if (direct) return direct;

      try {
        const openrouterMap = await this.fetchOpenRouterPricing();
        const openrouterModel = openrouterMap.get(model.name) || openrouterMap.get(model.id);
        const openrouterPricing = this.normalizeOpenRouterPricing(openrouterModel);
        if (openrouterPricing) return openrouterPricing;
      } catch (error) {
        console.warn(`⚠️ OpenRouter pricing lookup failed for ${model.name}: ${error.message}`);
      }
    }

    try {
      const litellm = await this.fetchLiteLLMPricing();
      const match = this.findLiteLLMMatch(model, litellm);
      if (match) return this.normalizeLiteLLMPricing(match.key, match.row);
    } catch (error) {
      console.warn(`⚠️ LiteLLM pricing lookup failed for ${model.name}: ${error.message}`);
    }

    return null;
  }

  async enrichModels(models = []) {
    return Promise.all((models || []).map(async (model) => ({
      ...model,
      pricing: model.pricing ? this.normalizeExistingPricing(model.pricing) : await this.resolvePricing(model),
    })));
  }

  normalizeExistingPricing(pricing) {
    if (!pricing || typeof pricing !== 'object') return null;
    if (pricing.unit === 'per_1m_tokens') return pricing;

    const normalized = this.normalizeOpenRouterPricing({ pricing });
    return normalized || pricing;
  }

  findLiteLLMMatch(model, pricingMap) {
    const candidates = this.pricingCandidates(model);
    for (const key of candidates) {
      if (pricingMap[key]) return { key, row: pricingMap[key] };
    }

    const targetProvider = String(model.provider || '').toLowerCase();
    const bareName = this.stripKnownPrefix(model.name).toLowerCase();
    for (const [key, row] of Object.entries(pricingMap)) {
      const provider = String(row?.litellm_provider || '').toLowerCase();
      if (!provider || !targetProvider) continue;
      if (!this.providerMatches(targetProvider, provider)) continue;
      if (this.stripKnownPrefix(key).toLowerCase() === bareName) return { key, row };
    }

    return null;
  }

  pricingCandidates(model) {
    const name = String(model?.name || model?.id || '').replace(/^models\//, '');
    const id = String(model?.id || '').replace(/^models\//, '');
    const bare = this.stripKnownPrefix(name);
    const provider = model?.provider || '';
    const prefixes = PROVIDER_PREFIXES[provider] || [];
    const values = [name, id, bare];

    for (const prefix of prefixes) {
      values.push(`${prefix}/${name}`, `${prefix}/${bare}`);
    }

    if (provider === 'OpenRouter') {
      values.push(`openrouter/${name}`);
    }

    return [...new Set(values.filter(Boolean))];
  }

  stripKnownPrefix(value) {
    return String(value || '')
      .replace(/^models\//, '')
      .replace(/^(openai|gemini|deepseek|openrouter|groq|vertex_ai-language-models)\//, '');
  }

  providerMatches(targetProvider, litellmProvider) {
    const prefixes = PROVIDER_PREFIXES[Object.keys(PROVIDER_PREFIXES).find(
      (key) => key.toLowerCase() === targetProvider
    )] || [targetProvider];
    return prefixes.some((prefix) => litellmProvider === prefix || litellmProvider.includes(prefix));
  }

  perTokenToPerMillion(value) {
    const number = this.nullableNumber(value);
    return number == null ? null : number * 1_000_000;
  }

  nullableNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
}

module.exports = new ModelPricingService();
