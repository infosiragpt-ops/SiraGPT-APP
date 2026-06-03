const axios = require('axios');
const prisma = require('../config/database');
const {
  getProviderCatalogDiagnostics,
  listManifestModels,
  mergeProviderModels,
  DEFAULT_ACTIVE_IMAGE_MODEL_NAMES,
} = require('./model-catalog-manifest');
const modelPricingService = require('./model-pricing-service');

class ModelSyncService {
  constructor(options = {}) {
    this.prisma = options.prismaClient || prisma;
    this.cache = {
      openai: { data: null, lastFetch: 0, ttl: 3600000 }, // 1 hour cache
      gemini: { data: null, lastFetch: 0, ttl: 3600000 },
      openrouter: { data: null, lastFetch: 0, ttl: 3600000 },
      deepseek: { data: null, lastFetch: 0, ttl: 3600000 }
    };
    // Guards the one-time reactivation of the curated default IMAGE set so it
    // does NOT override admin deactivations on every read. See
    // ensureStaticCatalogModels below. Per-instance so prod (singleton) runs it
    // once per process, while tests (fresh instances) each exercise it.
    this._curatedImageActivationDone = false;
  }

  getStaticVideoModels() {
    const configured = Boolean(process.env.FAL_KEY || process.env.FAL_API_KEY || process.env.TAL_AI_API_KEY);
    return [
      {
        id: 'veo-fast',
        name: 'veo-fast',
        displayName: 'Veo Fast (fal.ai)',
        provider: 'Custom',
        type: 'VIDEO',
        description: configured
          ? 'Generación de video con Veo Fast vía fal.ai.'
          : 'Generación de video con Veo Fast vía fal.ai. Requiere FAL_API_KEY o FAL_KEY.',
        icon: 'GeminiLogo',
        contextLength: null,
        pricing: { provider: 'fal.ai', billing: 'per_generation' },
        tags: ['video', 'fal.ai', 'veo', 'text-to-video', 'image-to-video'],
        syncSource: 'static',
        isActive: false,
      },
      {
        id: 'fal-ai/veo3/fast',
        name: 'fal-ai/veo3/fast',
        displayName: 'Veo 3 Fast',
        provider: 'Custom',
        type: 'VIDEO',
        description: 'Modelo text-to-video de Veo 3 Fast servido por fal.ai.',
        icon: 'GeminiLogo',
        contextLength: null,
        pricing: { provider: 'fal.ai', billing: 'per_generation' },
        tags: ['video', 'fal.ai', 'veo3', 'text-to-video'],
        syncSource: 'static',
        isActive: false,
      },
      {
        id: 'fal-ai/veo3/fast/image-to-video',
        name: 'fal-ai/veo3/fast/image-to-video',
        displayName: 'Veo 3 Fast Image to Video',
        provider: 'Custom',
        type: 'VIDEO',
        description: 'Modelo image-to-video de Veo 3 Fast servido por fal.ai.',
        icon: 'GeminiLogo',
        contextLength: null,
        pricing: { provider: 'fal.ai', billing: 'per_generation' },
        tags: ['video', 'fal.ai', 'veo3', 'image-to-video'],
        syncSource: 'static',
        isActive: false,
      },
    ];
  }

  getStaticImageModels() {
    return listManifestModels({ type: 'IMAGE' }).map(model => ({
      ...model,
      isActive: false,
      syncSource: model.syncSource || 'static_manifest',
    }));
  }

  getStaticAudioModels() {
    return listManifestModels({ type: 'AUDIO' }).map(model => ({
      ...model,
      isActive: false,
      syncSource: model.syncSource || 'static_manifest',
    }));
  }

  getStaticMusicModels() {
    return listManifestModels({ type: 'MUSIC' }).map(model => ({
      ...model,
      isActive: false,
      syncSource: model.syncSource || 'static_manifest',
    }));
  }

  /**
   * Fetch all available models from OpenAI
   */
  async fetchOpenAIModels() {
    try {
      const now = Date.now();
      const cache = this.cache.openai;

      if (cache.data && (now - cache.lastFetch) < cache.ttl) {
        console.log('📦 Using cached OpenAI models');
        return cache.data;
      }

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.warn('⚠️ OpenAI API key not found, using static model catalog');
        const models = await this.fallbackManifestModels('OpenAI');
        cache.data = models;
        cache.lastFetch = now;
        return models;
      }

      console.log('🔄 Fetching OpenAI models...');
      const response = await axios.get('https://api.openai.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      const models = response.data.data
        .map(model => ({
          id: model.id,
          name: model.id,
          displayName: this.formatModelName(model.id),
          provider: 'OpenAI',
          type: this.inferModelType(model.id, model),
          description: this.generateModelDescription(model.id, 'OpenAI'),
          isActive: false,
          apiData: model
        }));

      const mergedModels = await modelPricingService.enrichModels(
        mergeProviderModels(models, 'OpenAI', { includeManifestOnly: false })
      );

      cache.data = mergedModels;
      cache.lastFetch = now;

      console.log(`✅ Fetched ${models.length} OpenAI models, ${mergedModels.length} available after catalog merge`);
      return mergedModels;
    } catch (error) {
      console.error('❌ Error fetching OpenAI models:', error.message);
      return this.cache.openai.data || this.fallbackManifestModels('OpenAI');
    }
  }

  /**
   * Fetch all available models from Gemini
   */
  async fetchGeminiModels() {
    try {
      const now = Date.now();
      const cache = this.cache.gemini;

      if (cache.data && (now - cache.lastFetch) < cache.ttl) {
        console.log('📦 Using cached Gemini models');
        return cache.data;
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.warn('⚠️ Gemini API key not found, using static model catalog');
        const models = await this.fallbackManifestModels('Gemini');
        cache.data = models;
        cache.lastFetch = now;
        return models;
      }

      console.log('🔄 Fetching Gemini models...');
      let modelRows = [];
      try {
        const response = await axios.get('https://generativelanguage.googleapis.com/v1beta/openai/models', {
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        });
        modelRows = response.data.data || [];
      } catch (openAiCompatError) {
        console.warn(`⚠️ Gemini OpenAI-compatible model listing failed: ${openAiCompatError.message}`);
        const response = await axios.get('https://generativelanguage.googleapis.com/v1beta/models', {
          params: { key: apiKey },
          timeout: 10000
        });
        modelRows = (response.data.models || []).map(model => ({
          ...model,
          id: String(model.name || '').replace(/^models\//, ''),
          name: String(model.name || '').replace(/^models\//, '')
        }));
      }

      const models = modelRows
        .map(model => {
          const modelId = model.id || model.name || '';
          return {
            id: modelId,
            name: modelId.replace(/^models\//, ''),
            displayName: model.display_name || model.name || this.formatModelName(modelId),
            provider: 'Gemini',
            type: this.inferModelType(modelId, model),
            description: model.description || this.generateModelDescription(modelId, 'Gemini'),
            contextLength: model.inputTokenLimit || model.context_length || model.contextLength,
            isActive: false,
            apiData: model
          };
        });

      const mergedModels = await modelPricingService.enrichModels(
        mergeProviderModels(models, 'Gemini', { includeManifestOnly: false })
      );

      cache.data = mergedModels;
      cache.lastFetch = now;

      console.log(`✅ Fetched ${models.length} Gemini models, ${mergedModels.length} available after catalog merge`);
      return mergedModels;
    } catch (error) {
      console.error('❌ Error fetching Gemini models:', error.message);
      return this.cache.gemini.data || this.fallbackManifestModels('Gemini');
    }
  }

  /**
   * Fetch currently available models from DeepSeek direct API.
   *
   * DeepSeek's public OpenAI-compatible API exposes stable V4
   * identifiers for this account. We preserve the official API IDs
   * for requests and use polished names in the product picker.
   */
  async fetchDeepSeekModels() {
    try {
      const now = Date.now();
      const cache = this.cache.deepseek;

      if (cache.data && (now - cache.lastFetch) < cache.ttl) {
        console.log('📦 Using cached DeepSeek models');
        return cache.data;
      }

      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) {
        console.warn('⚠️ DeepSeek API key not found, using static model catalog');
        const models = await this.fallbackManifestModels('DeepSeek');
        cache.data = models;
        cache.lastFetch = now;
        return models;
      }

      console.log('🔄 Fetching DeepSeek models...');
      const response = await axios.get('https://api.deepseek.com/models', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      const models = (response.data.data || [])
        .map(model => ({
          id: model.id,
          name: model.id,
          displayName: model.name || this.formatModelName(model.id),
          provider: 'DeepSeek',
          type: this.inferModelType(model.id, model),
          description: this.generateModelDescription(model.id, 'DeepSeek'),
          contextLength: model.context_length || model.contextLength || 128000,
          isActive: false,
          apiData: model
        }));

      const mergedModels = await modelPricingService.enrichModels(
        mergeProviderModels(models, 'DeepSeek', { includeManifestOnly: false })
      );

      cache.data = mergedModels;
      cache.lastFetch = now;

      console.log(`✅ Fetched ${models.length} DeepSeek models, ${mergedModels.length} available after catalog merge`);
      return mergedModels;
    } catch (error) {
      console.error('❌ Error fetching DeepSeek models:', error.message);
      return this.cache.deepseek.data || this.fallbackManifestModels('DeepSeek');
    }
  }

  /**
   * Fetch all available models from OpenRouter
   */
  async fetchOpenRouterModels() {
    try {
      const now = Date.now();
      const cache = this.cache.openrouter;

      if (cache.data && (now - cache.lastFetch) < cache.ttl) {
        console.log('📦 Using cached OpenRouter models');
        return cache.data;
      }

      console.log('🔄 Fetching OpenRouter models...');
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        console.warn('⚠️ OpenRouter API key not found, using static model catalog');
        const models = await this.fallbackManifestModels('OpenRouter');
        cache.data = models;
        cache.lastFetch = now;
        return models;
      }

      const response = await axios.get('https://openrouter.ai/api/v1/models', {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        timeout: 15000
      });

      const models = response.data.data
        .map(model => ({
          id: model.id,
          name: model.id,
          displayName: model.name || this.formatModelName(model.id),
          provider: 'OpenRouter',
          type: this.inferModelType(model.id, model),
          description: model.description || this.generateModelDescription(model.id, 'OpenRouter'),
          pricing: model.pricing,
          contextLength: model.context_length,
          isActive: false,
          apiData: model
        }));

      const mergedModels = await modelPricingService.enrichModels(
        mergeProviderModels(models, 'OpenRouter', { includeManifestOnly: false })
      );

      cache.data = mergedModels;
      cache.lastFetch = now;

      console.log(`✅ Fetched ${models.length} OpenRouter models, ${mergedModels.length} available after catalog merge`);
      return mergedModels;
    } catch (error) {
      console.error('❌ Error fetching OpenRouter models:', error.message);
      return this.cache.openrouter.data || this.fallbackManifestModels('OpenRouter');
    }
  }

  /**
   * Fetch models from all providers
   */
  async fetchAllModels() {
    console.log('🚀 Starting to fetch models from all providers...');

    const [openaiModels, geminiModels, openrouterModels, deepseekModels, imageModels, videoModels] = await Promise.allSettled([
      this.fetchOpenAIModels(),
      this.fetchGeminiModels(),
      this.fetchOpenRouterModels(),
      this.fetchDeepSeekModels(),
      Promise.resolve(this.getStaticImageModels()),
      Promise.resolve(this.getStaticVideoModels())
    ]);

    const allModels = [];

    if (openaiModels.status === 'fulfilled') {
      allModels.push(...openaiModels.value);
    }

    if (geminiModels.status === 'fulfilled') {
      allModels.push(...geminiModels.value);
    }

    if (openrouterModels.status === 'fulfilled') {
      allModels.push(...openrouterModels.value);
    }

    if (deepseekModels.status === 'fulfilled') {
      allModels.push(...deepseekModels.value);
    }

    if (imageModels.status === 'fulfilled') {
      allModels.push(...imageModels.value);
    }

    if (videoModels.status === 'fulfilled') {
      allModels.push(...videoModels.value);
    }

    const deduped = [];
    const seen = new Set();
    for (const model of allModels) {
      if (!model?.name || seen.has(model.name)) continue;
      seen.add(model.name);
      deduped.push(model);
    }

    console.log(`🎯 Total models fetched: ${deduped.length}`);
    return deduped;
  }

  /**
   * Sync models with database
   */
  async syncModelsToDatabase() {
    try {
      console.log('🔄 Starting model sync to database...');
      const fetchedModels = await this.fetchAllModels();

      if (fetchedModels.length === 0) {
        console.log('⚠️ No models fetched, skipping database sync');
        return { updated: 0, created: 0, errors: 0 };
      }

      let created = 0;
      let updated = 0;
      let errors = 0;

      for (const model of fetchedModels) {
        try {
          const existingModel = await prisma.aiModel.findUnique({
            where: { name: model.name }
          });

          if (existingModel) {
            // Update metadata only. Admin availability must survive refreshes
            // so an activated model immediately remains visible to users.
            await prisma.aiModel.update({
              where: { name: model.name },
              data: this.buildModelSyncUpdateData(model)
            });
            updated++;
          } else {
            // Create new model
            await prisma.aiModel.create({
              data: {
                name: model.name,
                displayName: model.displayName,
                description: model.description,
                provider: model.provider,
                type: model.type,
                isActive: false,
                icon: this.getModelIcon(model),
                lastSynced: new Date(),
                syncSource: model.syncSource || 'api',
                contextLength: model.contextLength,
                pricing: model.pricing,
                tags: model.tags && model.tags.length ? model.tags : this.generateTags(model)
              }
            });
            created++;
          }
        } catch (modelError) {
          console.error(`❌ Error syncing model ${model.name}:`, modelError.message);
          errors++;
        }
      }

      console.log(`✅ Model sync complete: ${created} created, ${updated} updated, ${errors} errors`);
      return { created, updated, errors };
    } catch (error) {
      console.error('❌ Error during model sync:', error);
      throw error;
    }
  }

  buildModelSyncUpdateData(model) {
    return {
      displayName: model.displayName,
      description: model.description,
      provider: model.provider,
      type: model.type,
      icon: this.getModelIcon(model),
      lastSynced: new Date(),
      syncSource: model.syncSource || 'api',
      contextLength: model.contextLength,
      pricing: model.pricing,
      tags: model.tags && model.tags.length ? model.tags : this.generateTags(model),
      updatedAt: new Date()
    };
  }

  /**
   * One-time production guard for the admin catalog.
   *
   * Earlier builds seeded/provider-synced models as active. The SQL
   * migration handles normal deploys, but this runtime guard covers hosts
   * where migrations are skipped or delayed. It runs once, then preserves
   * future manual admin activations.
   */
  async ensureDefaultInactiveOnce() {
    const markerKey = 'ai_models_default_inactive_v1_applied';
    const markerValue = JSON.stringify({
      appliedAt: new Date().toISOString(),
      reason: 'admin_models_default_inactive',
    });

    const existingMarker = await this.prisma.systemSettings.findUnique({
      where: { key: markerKey },
      select: { id: true },
    });

    if (existingMarker) {
      return { applied: false, count: 0, reason: 'already_applied' };
    }

    const result = await this.prisma.aiModel.updateMany({
      where: { isActive: true },
      data: { isActive: false },
    });

    await this.prisma.systemSettings.upsert({
      where: { key: markerKey },
      update: { value: markerValue },
      create: { key: markerKey, value: markerValue },
    });

    return { applied: true, count: result.count || 0, reason: 'default_inactive_enforced' };
  }

  async ensureStaticCatalogModels(options = {}) {
    const types = Array.isArray(options.types) && options.types.length
      ? new Set(options.types.map(type => String(type).toUpperCase()))
      : null;
    const catalogModels = [
      ...listManifestModels(),
      ...this.getStaticVideoModels(),
      ...this.getStaticAudioModels(),
      ...this.getStaticMusicModels(),
    ].filter(model => !types || types.has(String(model.type || '').toUpperCase()));

    let created = 0;
    let updated = 0;
    const existingRows = await this.prisma.aiModel.findMany({
      where: { name: { in: catalogModels.map(model => model.name) } },
      select: { name: true },
    });
    const existingNames = new Set(existingRows.map(row => row.name));

    for (const model of catalogModels) {
      const data = {
        displayName: model.displayName,
        description: model.description,
        provider: model.provider,
        type: model.type,
        icon: this.getModelIcon(model),
        syncSource: model.syncSource || 'static_manifest',
        contextLength: model.contextLength,
        pricing: model.pricing,
        tags: model.tags && model.tags.length ? model.tags : this.generateTags(model),
        lastSynced: new Date(),
      };

      if (existingNames.has(model.name)) {
        await this.prisma.aiModel.update({
          where: { name: model.name },
          data,
        });
        updated++;
        continue;
      }

      try {
        await this.prisma.aiModel.create({
          data: {
            name: model.name,
            ...data,
            // Curated, verified IMAGE models seed ACTIVE so they are immediately
            // selectable in the picker (across OpenAI/Gemini/OpenRouter/fal.ai).
            // Everything else seeds inactive and stays admin-controlled.
            isActive: DEFAULT_ACTIVE_IMAGE_MODEL_NAMES.has(model.name),
          },
        });
        created++;
      } catch (err) {
        // Concurrency guard: this method runs on the hot path (/ai/models read,
        // /admin/models/sync) so two requests can both miss the row in findMany
        // and race to create it. The loser hits a P2002 unique-constraint
        // violation on `name`. Treat that as "already created" and fall back to
        // a metadata update WITHOUT isActive, preserving admin activation state.
        if (err && err.code === 'P2002') {
          await this.prisma.aiModel.update({
            where: { name: model.name },
            data,
          });
          updated++;
        } else {
          throw err;
        }
      }
    }

    // One-time-per-process reactivation of the curated default IMAGE set, even
    // for rows that already existed inactive (e.g. seeded by a previous deploy
    // or disabled long ago). These are shipped defaults the user (sole admin)
    // explicitly wants enabled; without this, pre-existing inactive rows would
    // never surface in the picker. Guarded by `_curatedImageActivationDone` so
    // it runs once and does NOT silently override a deliberate admin
    // deactivation on every subsequent /models read or /generate-image call.
    if ((!types || types.has('IMAGE')) && !this._curatedImageActivationDone) {
      const defaultActiveImageNames = catalogModels
        .filter(model => String(model.type || '').toUpperCase() === 'IMAGE'
          && DEFAULT_ACTIVE_IMAGE_MODEL_NAMES.has(model.name))
        .map(model => model.name);
      if (defaultActiveImageNames.length) {
        await this.prisma.aiModel.updateMany({
          where: { name: { in: defaultActiveImageNames }, type: 'IMAGE', isActive: false },
          data: { isActive: true },
        });
      }
      this._curatedImageActivationDone = true;
    }

    return { created, updated, existing: existingRows.length, count: catalogModels.length };
  }

  /**
   * Clear cache for a specific provider or all providers
   */
  clearCache(provider = null) {
    if (provider && this.cache[provider]) {
      this.cache[provider] = { data: null, lastFetch: 0, ttl: this.cache[provider].ttl };
      console.log(`🧹 Cleared cache for ${provider}`);
    } else {
      Object.keys(this.cache).forEach(key => {
        this.cache[key].data = null;
        this.cache[key].lastFetch = 0;
      });
      console.log('🧹 Cleared all model caches');
    }
  }

  /**
   * Return static catalog visibility and configuration diagnostics for admin UI.
   */
  getModelCatalogDiagnostics(options = {}) {
    return getProviderCatalogDiagnostics(options);
  }

  /**
   * Format model name for display
   */
  formatModelName(modelId) {
    return modelId
      .split('/')
      .pop() // Get the last part after slash
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
      .replace(/\b(Gpt|Api|V)\b/g, match => match.toUpperCase());
  }

  async fallbackManifestModels(provider) {
    const models = listManifestModels({ provider }).map(model => ({
      ...model,
      isActive: false,
    }));
    return modelPricingService.enrichModels(models);
  }

  /**
   * Generate description for models
   */
  generateModelDescription(modelId, provider) {
    const descriptions = {
      'gpt-4': 'Most capable GPT model for complex tasks',
      'gpt-4-turbo': 'Faster GPT-4 with improved efficiency',
      'gpt-3.5-turbo': 'Fast and efficient for most tasks',
      'dall-e-3': 'Advanced image generation model',
      'dall-e-2': 'High-quality image generation',
      'gemini-pro': 'Google\'s most capable model',
      'gemini-flash': 'Google\'s fast and efficient model'
    };

    // Check for exact match first
    if (descriptions[modelId]) {
      return descriptions[modelId];
    }

    // Generate based on patterns
    if (modelId.includes('gpt-4')) return 'Advanced GPT-4 based model';
    if (modelId.includes('gpt-3.5')) return 'Efficient GPT-3.5 based model';
    if (modelId.includes('claude')) return 'Anthropic Claude model via OpenRouter';
    if (modelId.includes('llama')) return 'Meta Llama model via OpenRouter';
    if (modelId.includes('kimi')) return 'Moonshot Kimi model via OpenRouter';
    if (modelId.includes('gemini')) return 'Google Gemini model';
    if (modelId.includes('deepseek')) return 'DeepSeek direct API model';
    if (modelId.includes('dall-e')) return 'OpenAI image generation model';

    return `${provider} model for AI tasks`;
  }

  inferModelType(modelId, apiData = {}) {
    const id = String(modelId || '').toLowerCase();
    const mode = String(apiData.mode || '').toLowerCase();
    const modalities = [
      ...(apiData.supported_output_modalities || []),
      ...(apiData.supported_modalities || []),
      ...(apiData.output || []),
      ...(apiData.input || []),
    ].map(value => String(value).toLowerCase());

    if (
      id.includes('dall-e') ||
      id.includes('gpt-image') ||
      id.includes('imagen') ||
      id.includes('seedream') ||
      id.includes('flux') ||
      id.includes('recraft') ||
      id.includes('ideogram') ||
      mode.includes('image') ||
      modalities.includes('image')
    ) {
      return 'IMAGE';
    }

    if (
      id.includes('video') ||
      id.includes('veo') ||
      id.includes('kling') ||
      id.includes('runway') ||
      id.includes('pika') ||
      id.includes('luma') ||
      id.includes('sora') ||
      mode.includes('video') ||
      modalities.includes('video')
    ) {
      return 'VIDEO';
    }

    if (
      id.includes('suno') ||
      id.includes('udio') ||
      id.includes('music') ||
      mode.includes('music') ||
      modalities.includes('music')
    ) {
      return 'MUSIC';
    }

    if (
      id.includes('whisper') ||
      id.includes('tts-') ||
      id.includes('-tts') ||
      id.includes('speech') ||
      id.includes('eleven') ||
      id.includes('elevenlabs') ||
      id.includes('audio') ||
      mode.includes('audio') ||
      modalities.includes('audio')
    ) {
      return 'AUDIO';
    }

    return 'TEXT';
  }

  /**
   * Get provider/model icon. OpenRouter is a transport provider, so model
   * slugs such as anthropic/claude-* or moonshotai/kimi-* keep their brand.
   */
  getModelIcon(model = {}) {
    const modelName = `${model.name || ''} ${model.displayName || ''}`.toLowerCase();
    const provider = `${model.provider || ''}`.toLowerCase();

    if (/(^|[/\s-])(gpt|chatgpt|dall[-\s]?e)\b|openai\//.test(modelName)) return 'ChatGPTLogo';
    if (/gemini|google\/|imagen|veo/.test(modelName)) return 'GeminiLogo';
    if (/claude|anthropic\//.test(modelName)) return 'ClaudeLogo';
    if (/grok|x-ai\//.test(modelName)) return 'GrokLogo';
    if (/deepseek/.test(modelName)) return 'DeepseekLogo';
    if (/kimi|moonshot/.test(modelName)) return 'KimiLogo';
    if (/\bz\.?ai\b|z-ai\/|zhipu|chatglm|\bglm[-\s]?\d?/.test(modelName)) return 'ZaiLogo';
    if (/seedream|bytedance|doubao/.test(modelName)) return 'SeedreamLogo';
    if (/qwen|alibaba/.test(modelName)) return 'QwenLogo';
    if (/llama|meta-llama|meta\//.test(modelName)) return 'MetaLogo';
    if (/mistral|codestral/.test(modelName)) return 'MistralLogo';

    return this.getProviderIcon(provider);
  }

  /**
   * Get provider icon
   */
  getProviderIcon(provider) {
    const normalized = `${provider || ''}`.toLowerCase();
    const icons = {
      openai: 'ChatGPTLogo',
      gemini: 'GeminiLogo',
      google: 'GeminiLogo',
      anthropic: 'ClaudeLogo',
      'x-ai': 'GrokLogo',
      xai: 'GrokLogo',
      openrouter: 'OpenRouterLogo',
      deepseek: 'DeepseekLogo'
    };
    return icons[normalized] || 'Bot';
  }

  /**
   * Get provider statistics
   */
  async getProviderStats() {
    try {
      const stats = await prisma.aiModel.groupBy({
        by: ['provider'],
        _count: {
          id: true
        },
        where: {
          isActive: true
        }
      });

      return stats.reduce((acc, stat) => {
        acc[stat.provider] = stat._count.id;
        return acc;
      }, {});
    } catch (error) {
      console.error('Error getting provider stats:', error);
      return {};
    }
  }

  /**
   * Generate tags for models based on their name and provider
   */
  generateTags(model) {
    const tags = [];

    // Add provider as tag
    tags.push(model.provider.toLowerCase());

    // Add type as tag
    tags.push(model.type.toLowerCase());

    // Add specific tags based on model name patterns
    const modelId = model.name.toLowerCase();

    if (modelId.includes('gpt-4')) tags.push('gpt-4', 'advanced');
    if (modelId.includes('gpt-3.5')) tags.push('gpt-3.5', 'efficient');
    if (modelId.includes('turbo')) tags.push('fast');
    if (modelId.includes('vision')) tags.push('vision', 'multimodal');
    if (modelId.includes('claude')) tags.push('claude', 'anthropic');
    if (modelId.includes('llama')) tags.push('llama', 'meta', 'open-source');
    if (modelId.includes('gemini')) tags.push('gemini', 'google');
    if (modelId.includes('deepseek')) tags.push('deepseek');
    if (modelId.includes('dall-e')) tags.push('dall-e', 'image-generation');
    if (modelId.includes('pro')) tags.push('professional');
    if (modelId.includes('mini') || modelId.includes('small')) tags.push('lightweight');
    if (modelId.includes('flash')) tags.push('fast', 'efficient');

    return [...new Set(tags)]; // Remove duplicates
  }
}

const modelSyncService = new ModelSyncService();

module.exports = modelSyncService;
module.exports.ModelSyncService = ModelSyncService;
