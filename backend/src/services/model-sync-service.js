const axios = require('axios');
const prisma = require('../config/database');

class ModelSyncService {
  constructor() {
    this.cache = {
      openai: { data: null, lastFetch: 0, ttl: 3600000 }, // 1 hour cache
      gemini: { data: null, lastFetch: 0, ttl: 3600000 },
      openrouter: { data: null, lastFetch: 0, ttl: 3600000 }
    };
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
        console.warn('⚠️ OpenAI API key not found');
        return [];
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
        .filter(model => {
          // Filter for chat completion models
          return model.id.includes('gpt') ||
            model.id.includes('o1') ||
            model.id.includes('dall-e') ||
            model.id === 'text-davinci-003' ||
            model.id === 'text-davinci-002';
        })
        .map(model => ({
          id: model.id,
          name: model.id,
          displayName: this.formatModelName(model.id),
          provider: 'OpenAI',
          type: model.id.includes('dall-e') ? 'IMAGE' : 'TEXT',
          description: this.generateModelDescription(model.id, 'OpenAI'),
          isActive: true,
          apiData: model
        }));

      cache.data = models;
      cache.lastFetch = now;

      console.log(`✅ Fetched ${models.length} OpenAI models`);
      return models;
    } catch (error) {
      console.error('❌ Error fetching OpenAI models:', error.message);
      return this.cache.openai.data || [];
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
        console.warn('⚠️ Gemini API key not found');
        return [];
      }

      console.log('🔄 Fetching Gemini models...');
      const response = await axios.get('https://generativelanguage.googleapis.com/v1beta/openai/models', {
        headers: {
          // 'Content-Type': 'application/json',
          // 'x-goog-api-key': apiKey
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      const models = response.data.data

        .filter(model => {
          const id = model.id.toLowerCase();

          const blocked = [
            'imagen',
            'image',
            'computer',
            'robot',
            'veo',
            'generate',
            'vision',
            'live',
            'audio'
          ];

          return !blocked.some(b => id.includes(b));
        })
        .map(model => {
          return {
            id: model.id,
            name: model.id,
            displayName: this.formatModelName(model.id),
            provider: 'Gemini',
            type: 'TEXT',
            description: model.description || this.generateModelDescription(model.id, 'Gemini'),
            isActive: true,
            apiData: model
          };
        });

      cache.data = models;
      cache.lastFetch = now;

      console.log(`✅ Fetched ${models.length} Gemini models`);
      return models;
    } catch (error) {
      console.error('❌ Error fetching Gemini models:', error.message);
      return this.cache.gemini.data || [];
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
      const response = await axios.get('https://openrouter.ai/api/v1/models', {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY || ''}`
        },
        timeout: 15000
      });

      const models = response.data.data
        .filter(model => {
          // Filter out deprecated or beta models, focus on stable ones
          return !model.id.includes('beta') &&
            !model.id.includes('deprecated') &&
            model.context_length > 1000; // Filter out very limited models
        })
        .map(model => ({
          id: model.id,
          name: model.id,
          displayName: model.name || this.formatModelName(model.id),
          provider: 'OpenRouter',
          type: 'TEXT', // OpenRouter primarily serves text models
          description: model.description || this.generateModelDescription(model.id, 'OpenRouter'),
          pricing: model.pricing,
          contextLength: model.context_length,
          isActive: true,
          apiData: model
        }));

      cache.data = models;
      cache.lastFetch = now;

      console.log(`✅ Fetched ${models.length} OpenRouter models`);
      return models;
    } catch (error) {
      console.error('❌ Error fetching OpenRouter models:', error.message);
      return this.cache.openrouter.data || [];
    }
  }

  /**
   * Fetch models from all providers
   */
  async fetchAllModels() {
    console.log('🚀 Starting to fetch models from all providers...');

    const [openaiModels, geminiModels, openrouterModels] = await Promise.allSettled([
      this.fetchOpenAIModels(),
      this.fetchGeminiModels(),
      this.fetchOpenRouterModels()
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

    console.log(`🎯 Total models fetched: ${allModels.length}`);
    return allModels;
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
            // Update existing model while preserving user settings
            await prisma.aiModel.update({
              where: { name: model.name },
              data: {
                displayName: model.displayName,
                description: model.description,
                provider: model.provider,
                type: model.type,
                lastSynced: new Date(),
                syncSource: 'api',
                contextLength: model.contextLength,
                pricing: model.pricing,
                // Don't override isActive - let users control this
                updatedAt: new Date()
              }
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
                isActive: model.isActive,
                icon: this.getProviderIcon(model.provider),
                lastSynced: new Date(),
                syncSource: 'api',
                contextLength: model.contextLength,
                pricing: model.pricing,
                tags: this.generateTags(model)
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
    if (modelId.includes('gemini')) return 'Google Gemini model';
    if (modelId.includes('dall-e')) return 'OpenAI image generation model';

    return `${provider} model for AI tasks`;
  }

  /**
   * Get provider icon
   */
  getProviderIcon(provider) {
    const icons = {
      'OpenAI': 'ChatGPTLogo',
      'Gemini': 'GeminiLogo',
      'OpenRouter': 'OpenRouterLogo'
    };
    return icons[provider] || 'Bot';
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
    if (modelId.includes('dall-e')) tags.push('dall-e', 'image-generation');
    if (modelId.includes('pro')) tags.push('professional');
    if (modelId.includes('mini') || modelId.includes('small')) tags.push('lightweight');
    if (modelId.includes('flash')) tags.push('fast', 'efficient');

    return [...new Set(tags)]; // Remove duplicates
  }
}

module.exports = new ModelSyncService();