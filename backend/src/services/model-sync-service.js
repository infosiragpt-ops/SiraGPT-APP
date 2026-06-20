const axios = require('axios');
const prisma = require('../config/database');
const {
  getProviderCatalogDiagnostics,
  listManifestModels,
  mergeProviderModels,
  DEFAULT_ACTIVE_IMAGE_MODEL_NAMES,
} = require('./model-catalog-manifest');
const {
  listFalVideoModels,
  normalizeFalExploreModel,
  sortFalVideoModels,
} = require('./fal-video-model-catalog');
const { cleanEnvValue, getFalApiKey } = require('./fal/fal-auth');
const modelPricingService = require('./model-pricing-service');

// Deterministic JSON stringify (keys sorted at every level) so two objects
// with the same content but different key order compare equal — needed because
// Postgres JSONB does not preserve insertion order when it round-trips.
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// Stable fingerprint of a model's pricing object that ignores the volatile
// `updatedAt` stamp (re-written on every fetch). Without this, every priced
// model looks "changed" on each sync and gets a needless UPDATE.
function pricingFingerprint(pricing) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
    return stableStringify(roundFloats(pricing));
  }
  const { updatedAt, ...rest } = pricing; // eslint-disable-line no-unused-vars
  return stableStringify(roundFloats(rest));
}

// Round numeric leaves so floating-point noise (0.4 vs 0.39999999999999997,
// produced by the pricing math) doesn't read as a real change.
function roundFloats(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toFixed(8)) : value;
  if (Array.isArray(value)) return value.map(roundFloats);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = roundFloats(value[k]);
    return out;
  }
  return value;
}

class ModelSyncService {
  constructor(options = {}) {
    this.prisma = options.prismaClient || prisma;
    this.cache = {
      openai: { data: null, lastFetch: 0, ttl: 3600000 }, // 1 hour cache
      gemini: { data: null, lastFetch: 0, ttl: 3600000 },
      openrouter: { data: null, lastFetch: 0, ttl: 3600000 },
      deepseek: { data: null, lastFetch: 0, ttl: 3600000 },
      falVideo: { data: null, lastFetch: 0, ttl: 3600000 }
    };
    // Guards the one-time reactivation of the curated default IMAGE set so it
    // does NOT override admin deactivations on every read. See
    // ensureStaticCatalogModels below. Per-instance so prod (singleton) runs it
    // once per process, while tests (fresh instances) each exercise it.
    this._curatedImageActivationDone = false;
    this._staticCatalogSyncFlights = new Map();
  }

  getStaticVideoModels() {
    return listFalVideoModels().map(model => ({
      ...model,
      isActive: false,
      syncSource: model.syncSource || 'static_manifest',
    }));
  }

  getFalApiKey() {
    return getFalApiKey(process.env);
  }

  getFalAuthorizationHeader(apiKey = null) {
    const key = cleanEnvValue(apiKey || this.getFalApiKey());
    if (!key) return null;
    return /^key\s+/i.test(key) ? key : `Key ${key}`;
  }

  async fetchFalVideoModels(options = {}) {
    const apiKey = cleanEnvValue(options.apiKey || '');
    const useCache = !apiKey && !options.forceRefresh;
    const now = Date.now();
    const cache = this.cache.falVideo;
    if (useCache && cache.data && (now - cache.lastFetch) < cache.ttl) {
      console.log('📦 Using cached fal.ai video models');
      return cache.data;
    }

    const staticModels = this.getStaticVideoModels();
    const liveModels = [];
    const categories = ['text-to-video', 'image-to-video'];

    try {
      for (const category of categories) {
        let cursor = null;
        let page = 0;
        const authorization = this.getFalAuthorizationHeader(apiKey);
        do {
          const response = await axios.get('https://api.fal.ai/v1/models', {
            params: {
              category,
              status: 'active',
              limit: 100,
              ...(cursor ? { cursor } : {}),
            },
            headers: {
              ...(authorization ? { Authorization: authorization } : {}),
            },
            timeout: 10000,
          });
          const payload = response.data || {};
          const items = Array.isArray(payload.models)
            ? payload.models
            : Array.isArray(payload.items)
              ? payload.items
              : Array.isArray(payload.data)
                ? payload.data
                : [];
          for (const item of items) {
            const normalized = normalizeFalExploreModel(item, liveModels.length);
            if (normalized) liveModels.push(normalized);
          }
          cursor = payload.has_more ? payload.next_cursor : null;
          page += 1;
        } while (cursor && page < 20);
      }
    } catch (officialApiError) {
      console.warn('⚠️ fal.ai official model API fetch failed, trying legacy public catalog:', officialApiError.message);
      try {
        for (const category of categories) {
          let page = 1;
          let pages = 1;
          do {
            const response = await axios.get('https://fal.ai/api/explore/models', {
              params: { categories: category, page },
              headers: { 'Content-Type': 'application/json' },
              timeout: 10000,
            });
            const payload = response.data || {};
            const items = Array.isArray(payload.items)
              ? payload.items
              : Array.isArray(payload.models)
                ? payload.models
                : Array.isArray(payload.data)
                  ? payload.data
                  : [];
            for (const item of items) {
              const normalized = normalizeFalExploreModel(item, liveModels.length);
              if (normalized) liveModels.push(normalized);
            }
            pages = Number(payload.pages || payload.totalPages || payload.pagination?.pages || page) || page;
            page += 1;
          } while (page <= pages && page <= 10);
        }
      } catch (legacyApiError) {
        console.warn('⚠️ fal.ai public video catalog fetch failed, using static manifest:', legacyApiError.message);
      }
    }

    const byName = new Map();
    for (const model of staticModels) byName.set(model.name, model);
    for (const model of liveModels) byName.set(model.name, { ...byName.get(model.name), ...model, isActive: false });
    const merged = sortFalVideoModels([...byName.values()]);

    if (useCache) {
      cache.data = merged;
      cache.lastFetch = now;
    }
    console.log(`✅ fal.ai video catalog ready: ${merged.length} models (${liveModels.length} live discoveries)`);
    return merged;
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
            // The OpenAI-compatibility surface expects a Bearer token, not the
            // native x-goog-api-key header (which returned 400 and forced the
            // fallback every hour). Matches admin-connections-bridge convention.
            Authorization: `Bearer ${apiKey}`,
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

    const [openaiModels, geminiModels, openrouterModels, deepseekModels, imageModels, videoModels, genericModels] = await Promise.allSettled([
      this.fetchOpenAIModels(),
      this.fetchGeminiModels(),
      this.fetchOpenRouterModels(),
      this.fetchDeepSeekModels(),
      Promise.resolve(this.getStaticImageModels()),
      this.fetchFalVideoModels(),
      this._fetchGenericEnvProviderModels()
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

    if (genericModels.status === 'fulfilled') {
      allModels.push(...genericModels.value);
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

      const result = await this.persistModels(fetchedModels);
      console.log(`✅ Model sync complete: ${result.created} created, ${result.updated} updated, ${result.errors} errors`);
      return result;
    } catch (error) {
      console.error('❌ Error during model sync:', error);
      throw error;
    }
  }

  /**
   * Upsert a list of normalised models into the AiModel catalog.
   *
   * New rows are created with the model's own `isActive` flag (generic
   * discovery always passes `false` so admins curate visibility). Existing
   * rows only get metadata refreshed via buildModelSyncUpdateData, which
   * deliberately omits `isActive` so a manual admin activation survives.
   */
  // Persist discovered models. Batched for speed: the previous implementation
  // ran TWO sequential DB round-trips per model (findUnique + create/update),
  // so a few hundred models (OpenRouter alone is 300+) meant 600+ serial
  // queries and a multi-second "Sync Now". Now we: (1) look up all existing
  // names in ONE query, (2) bulk-insert the new ones with createMany, and
  // (3) run the per-row updates in bounded-concurrency batches. Same
  // {created, updated, errors} contract; discovered rows still default inactive.
  async persistModels(models = []) {
    let created = 0;
    let updated = 0;
    let errors = 0;

    // Dedup by name (last wins) so one batch never fights itself.
    const byName = new Map();
    for (const model of Array.isArray(models) ? models : []) {
      if (model && model.name) byName.set(model.name, model);
    }
    const list = [...byName.values()];
    if (list.length === 0) return { created, updated, errors };

    // 1) Pull the existing rows (with the fields we compare) in ONE query so
    //    we can skip rows that haven't changed. On a repeat "Sync Now" almost
    //    nothing changed → almost zero writes → the persist phase is near-free
    //    (single-row UPDATEs cost ~130ms each on this VPS due to per-commit
    //    fsync, so NOT writing is the real win).
    const existingByName = new Map();
    try {
      const rows = await this.prisma.aiModel.findMany({
        where: { name: { in: list.map((m) => m.name) } },
        select: {
          name: true, displayName: true, description: true, provider: true,
          type: true, contextLength: true, pricing: true, tags: true, icon: true,
        },
      });
      for (const r of rows) existingByName.set(r.name, r);
    } catch (lookupErr) {
      console.error('❌ persistModels: existing-name lookup failed:', lookupErr.message);
    }

    const toCreate = list.filter((m) => !existingByName.has(m.name));
    const toUpdate = list.filter(
      (m) => existingByName.has(m.name) && this._modelNeedsUpdate(existingByName.get(m.name), m),
    );
    const skipped = list.length - toCreate.length - toUpdate.length;

    // 2) Bulk-insert new models in one statement.
    if (toCreate.length) {
      try {
        const data = toCreate.map((model) => ({
          name: model.name,
          displayName: model.displayName,
          description: model.description,
          provider: model.provider,
          type: model.type,
          isActive: model.isActive === true,
          icon: this.getModelIcon(model),
          lastSynced: new Date(),
          syncSource: model.syncSource || 'api',
          contextLength: model.contextLength,
          pricing: model.pricing,
          tags: model.tags && model.tags.length ? model.tags : this.generateTags(model),
        }));
        const res = await this.prisma.aiModel.createMany({ data, skipDuplicates: true });
        created += typeof res?.count === 'number' ? res.count : toCreate.length;
      } catch (createErr) {
        console.error('❌ persistModels: createMany failed:', createErr.message);
        errors += toCreate.length;
      }
    }

    // 3) Per-row updates (Prisma can't bulk-set differing values) run in
    //    bounded-concurrency batches instead of strictly serially.
    const CONCURRENCY = Number.parseInt(process.env.MODEL_SYNC_DB_CONCURRENCY, 10) || 16;
    for (let i = 0; i < toUpdate.length; i += CONCURRENCY) {
      const chunk = toUpdate.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((model) =>
          this.prisma.aiModel.update({
            where: { name: model.name },
            data: this.buildModelSyncUpdateData(model),
          }),
        ),
      );
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled') {
          updated++;
        } else {
          errors++;
          console.error(`❌ persistModels: update failed for ${chunk[j].name}:`, results[j].reason?.message);
        }
      }
    }

    if (skipped > 0) console.log(`⏭️  persistModels: skipped ${skipped} unchanged model(s)`);
    return { created, updated, skipped, errors };
  }

  // True when a fetched model differs from the stored row in any field we
  // persist. Used to skip no-op UPDATEs. `pricing` is compared with a stable
  // (key-sorted) stringify because Postgres JSONB does not preserve key order.
  _modelNeedsUpdate(existing, model) {
    const norm = (v) => (v === undefined || v === '' ? null : v);
    const icon = this.getModelIcon(model);
    const tags = model.tags && model.tags.length ? model.tags : this.generateTags(model);
    const tagKey = (t) => (Array.isArray(t) ? [...t].sort().join('') : '');
    return (
      norm(existing.displayName) !== norm(model.displayName) ||
      norm(existing.description) !== norm(model.description) ||
      norm(existing.provider) !== norm(model.provider) ||
      norm(existing.type) !== norm(model.type) ||
      norm(existing.contextLength) !== norm(model.contextLength) ||
      norm(existing.icon) !== norm(icon) ||
      pricingFingerprint(norm(existing.pricing)) !== pricingFingerprint(norm(model.pricing)) ||
      tagKey(existing.tags) !== tagKey(tags)
    );
  }

  buildModelSyncUpdateData(model) {
    const data = {
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
    return data;
  }

  /**
   * Normalise a raw provider /models payload into catalog model shapes.
   * Handles the OpenAI `{ id }`, Anthropic `{ id, display_name }`, and bare
   * `{ name }` row variants. Discovered models are always inactive — admins
   * decide visibility from Admin → Modelos.
   */
  _normalizeRawModelList(rawList, providerLabel, sourceTag = 'connection') {
    if (!Array.isArray(rawList)) return [];
    const out = [];
    for (const raw of rawList) {
      if (!raw) continue;
      const rawId = raw.id || raw.name || raw.model || raw.slug || '';
      const name = String(rawId).replace(/^models\//, '').trim();
      if (!name) continue;
      out.push({
        id: name,
        name,
        displayName: raw.display_name || raw.displayName || this.formatModelName(name),
        provider: providerLabel,
        type: this.inferModelType(name, raw),
        description: raw.description || this.generateModelDescription(name, providerLabel),
        contextLength: raw.context_length || raw.contextLength || raw.inputTokenLimit || raw.max_context_length || undefined,
        pricing: raw.pricing || undefined,
        isActive: false,
        syncSource: sourceTag,
        apiData: raw,
      });
    }
    return out;
  }

  /**
   * Fetch + normalise the model list from any OpenAI-compatible (or
   * Anthropic) `/models` endpoint. Provider-agnostic: the caller supplies
   * the URL, key and auth style. Never throws — returns a structured
   * `{ ok, status, error, models }` so callers can branch without a
   * try/catch. `providerKey === 'anthropic'` switches to `x-api-key` +
   * `anthropic-version` auth automatically.
   */
  async fetchModelsFromEndpoint(options = {}) {
    const {
      url,
      apiKey = null,
      authType = 'Bearer',
      headers = null,
      providerLabel,
      providerKey = '',
      modelIdsFilter = null,
      sourceTag = 'connection',
      timeoutMs = Number.parseInt(process.env.MODEL_SYNC_PROBE_TIMEOUT_MS, 10) || 7000,
      fetchImpl = (typeof fetch === 'function' ? fetch : null),
    } = options;

    if (!url) return { ok: false, status: 0, error: 'missing_url', models: [] };
    if (typeof fetchImpl !== 'function') return { ok: false, status: 0, error: 'fetch_unavailable', models: [] };

    const reqHeaders = { Accept: 'application/json' };
    const pk = String(providerKey || '').toLowerCase();
    if (pk === 'anthropic') {
      if (apiKey) reqHeaders['x-api-key'] = apiKey;
      reqHeaders['anthropic-version'] = '2023-06-01';
    } else if (authType === 'Key' && apiKey) {
      reqHeaders['Authorization'] = this.getFalAuthorizationHeader(apiKey);
    } else if (authType !== 'None' && apiKey) {
      reqHeaders['Authorization'] = `Bearer ${apiKey}`;
    }
    if (headers && typeof headers === 'object') Object.assign(reqHeaders, headers);

    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers: reqHeaders, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      return { ok: false, status: 0, error: err.message, models: [] };
    }
    if (!response.ok) {
      let txt = '';
      try { txt = await response.text(); } catch (_) { /* noop */ }
      return { ok: false, status: response.status, error: `HTTP ${response.status} ${String(txt).slice(0, 160)}`.trim(), models: [] };
    }
    let body;
    try { body = await response.json(); } catch (err) {
      return { ok: false, status: response.status, error: `bad_json: ${err.message}`, models: [] };
    }

    const rawList = Array.isArray(body?.data) ? body.data
      : Array.isArray(body?.models) ? body.models
      : Array.isArray(body) ? body
      : [];
    let normalized = this._normalizeRawModelList(rawList, providerLabel || pk || 'Custom', sourceTag);

    if (Array.isArray(modelIdsFilter) && modelIdsFilter.length) {
      const allow = new Set(modelIdsFilter.map((x) => String(x).toLowerCase()));
      normalized = normalized.filter((m) => allow.has(m.name.toLowerCase()));
    }

    // Best-effort manifest merge + pricing enrichment; degrade to the plain
    // list on any failure (unknown providers have no manifest entries, which
    // mergeProviderModels tolerates by passing the live row through).
    let enriched = normalized;
    try {
      enriched = await modelPricingService.enrichModels(
        mergeProviderModels(normalized, providerLabel, { includeManifestOnly: false })
      );
      enriched = enriched.map((m) => ({ ...m, isActive: false, syncSource: m.syncSource || sourceTag }));
    } catch (_) {
      enriched = normalized;
    }

    return { ok: true, status: response.status, error: null, models: enriched };
  }

  /**
   * Discover + persist models for a single admin connection. `conn.apiKey`
   * must be the decrypted plaintext key (the route decrypts before calling).
   * Returns the fetch verdict merged with persist counts.
   */
  async syncConnectionModels(conn = {}) {
    let catalogMap = {};
    try { catalogMap = require('./admin-connections-bridge').PROVIDER_CATALOG_MAP || {}; } catch (_) { /* noop */ }
    const providerLabel = conn.providerLabel
      || catalogMap[String(conn.providerKey || '').toLowerCase()]
      || conn.providerKey
      || 'Custom';
    const providerKey = String(conn.providerKey || '').toLowerCase();

    if (providerKey === 'fal') {
      const apiKey = cleanEnvValue(conn.apiKey || '');
      if (!apiKey) return { ok: false, status: 0, error: 'missing_api_key', created: 0, updated: 0, errors: 0, count: 0, models: [] };

      const fetchImpl = conn.fetchImpl || (typeof fetch === 'function' ? fetch : null);
      if (typeof fetchImpl !== 'function') return { ok: false, status: 0, error: 'fetch_unavailable', created: 0, updated: 0, errors: 0, count: 0, models: [] };

      const validation = await fetchImpl('https://api.fal.ai/v1/models?limit=1', {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: this.getFalAuthorizationHeader(apiKey) },
        signal: AbortSignal.timeout(10000),
      }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }));

      if (!validation.ok) {
        let detail = '';
        try { detail = await validation.text(); } catch (_) { /* noop */ }
        return {
          ok: false,
          status: validation.status || 0,
          error: `fal.ai API key rejected${validation.status ? ` (HTTP ${validation.status})` : ''}: ${String(detail).slice(0, 180)}`.trim(),
          created: 0,
          updated: 0,
          errors: 0,
          count: 0,
          models: [],
        };
      }

      const models = await this.fetchFalVideoModels({ apiKey, forceRefresh: true });
      const filteredModels = Array.isArray(conn.modelIds) && conn.modelIds.length
        ? models.filter((model) => conn.modelIds.some((id) => String(id).toLowerCase() === String(model.name).toLowerCase()))
        : models;
      const persisted = filteredModels.length ? await this.persistModels(filteredModels) : { created: 0, updated: 0, errors: 0 };
      return { ok: true, error: null, ...persisted, count: filteredModels.length, models: filteredModels };
    }

    const base = String(conn.url || '').replace(/\/+$/, '');
    if (!base) return { ok: false, error: 'missing_url', created: 0, updated: 0, errors: 0, count: 0, models: [] };
    const url = /\/models$/.test(base) ? base : `${base}/models`;

    const res = await this.fetchModelsFromEndpoint({
      url,
      apiKey: conn.apiKey || null,
      authType: conn.authType || 'Bearer',
      headers: conn.headers || null,
      providerLabel,
      providerKey: conn.providerKey,
      modelIdsFilter: Array.isArray(conn.modelIds) && conn.modelIds.length ? conn.modelIds : null,
      sourceTag: 'connection',
      fetchImpl: conn.fetchImpl,
    });

    if (!res.ok) return { ...res, created: 0, updated: 0, errors: 0, count: 0 };
    if (!res.models.length) return { ok: true, error: null, created: 0, updated: 0, errors: 0, count: 0, models: [] };

    const persisted = await this.persistModels(res.models);
    return { ok: true, error: null, ...persisted, count: res.models.length, models: res.models };
  }

  /**
   * Discover models from providers whose API key lives only in the
   * environment (no hardcoded fetch* method) — Anthropic, Groq, Mistral,
   * xAI, Together, Fireworks. Lets "Sync Models" + the scheduler cover every
   * configured provider, not just OpenAI/Gemini/DeepSeek/OpenRouter.
   */
  async _fetchGenericEnvProviderModels(fetchImpl) {
    const providers = [
      { providerLabel: 'Anthropic', providerKey: 'anthropic', envVar: 'ANTHROPIC_API_KEY', url: 'https://api.anthropic.com/v1/models' },
      { providerLabel: 'Groq', providerKey: 'groq', envVar: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/models' },
      { providerLabel: 'Mistral', providerKey: 'mistral', envVar: 'MISTRAL_API_KEY', url: 'https://api.mistral.ai/v1/models' },
      { providerLabel: 'xAI', providerKey: 'xai', envVar: 'XAI_API_KEY', url: 'https://api.x.ai/v1/models' },
      { providerLabel: 'Together', providerKey: 'together', envVar: 'TOGETHER_API_KEY', url: 'https://api.together.xyz/v1/models' },
      { providerLabel: 'Fireworks', providerKey: 'fireworks', envVar: 'FIREWORKS_API_KEY', url: 'https://api.fireworks.ai/inference/v1/models' },
    ];
    const out = [];
    await Promise.all(providers.map(async (p) => {
      const apiKey = process.env[p.envVar];
      if (!apiKey) return;
      const res = await this.fetchModelsFromEndpoint({
        url: p.url,
        apiKey,
        providerKey: p.providerKey,
        providerLabel: p.providerLabel,
        sourceTag: 'api',
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      if (res.ok && res.models.length) {
        console.log(`✅ Discovered ${res.models.length} ${p.providerLabel} models from env key`);
        out.push(...res.models);
      }
    }));
    return out;
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

  _getStaticCatalogSyncFlightKey(options = {}) {
    const types = Array.isArray(options.types)
      ? [...new Set(options.types.map(type => String(type).toUpperCase()).filter(Boolean))].sort()
      : [];
    return types.length ? `types:${types.join(',')}` : 'types:*';
  }

  ensureStaticCatalogModels(options = {}) {
    const flightKey = this._getStaticCatalogSyncFlightKey(options);
    if (this._staticCatalogSyncFlights.has(flightKey)) {
      return this._staticCatalogSyncFlights.get(flightKey);
    }

    const flight = this._ensureStaticCatalogModels(options).finally(() => {
      this._staticCatalogSyncFlights.delete(flightKey);
    });
    this._staticCatalogSyncFlights.set(flightKey, flight);
    return flight;
  }

  async _ensureStaticCatalogModels(options = {}) {
    const types = Array.isArray(options.types) && options.types.length
      ? new Set(options.types.map(type => String(type).toUpperCase()))
      : null;
    const wantsVideo = !types || types.has('VIDEO');
    const videoModels = wantsVideo ? await this.fetchFalVideoModels() : [];
    const catalogModels = [
      ...listManifestModels().filter(model => String(model.type || '').toUpperCase() !== 'VIDEO'),
      ...videoModels,
      ...this.getStaticAudioModels(),
      ...this.getStaticMusicModels(),
    ].filter(model => !types || types.has(String(model.type || '').toUpperCase()));
    const dedupedCatalogModels = [];
    const catalogNames = new Set();
    for (const model of catalogModels) {
      if (!model?.name || catalogNames.has(model.name)) continue;
      catalogNames.add(model.name);
      dedupedCatalogModels.push(model);
    }

    let created = 0;
    let updated = 0;
    const existingRows = await this.prisma.aiModel.findMany({
      where: { name: { in: dedupedCatalogModels.map(model => model.name) } },
      select: { name: true },
    });
    const existingNames = new Set(existingRows.map(row => row.name));

    for (const model of dedupedCatalogModels) {
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
      const modelType = String(model.type || '').toUpperCase();

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
            // Curated IMAGE models seed ACTIVE; other IMAGE models stay inactive
            // until an admin enables them. VIDEO/AUDIO/MUSIC rows also stay
            // inactive on import; activating an AI Models row is the explicit
            // user-visible publish action.
            isActive: modelType === 'IMAGE'
              ? DEFAULT_ACTIVE_IMAGE_MODEL_NAMES.has(model.name)
              : false,
          },
        });
      } catch (err) {
        if (err?.code !== 'P2002') throw err;
        const fallbackData = { ...data };
        delete fallbackData.isActive;
        await this.prisma.aiModel.update({
          where: { name: model.name },
          data: fallbackData,
        });
        updated++;
        existingNames.add(model.name);
        continue;
      }
      created++;
      existingNames.add(model.name);
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

    return { created, updated, existing: existingRows.length, count: dedupedCatalogModels.length };
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
    if (model.icon) return model.icon;
    const modelName = `${model.name || ''} ${model.displayName || ''}`.toLowerCase();
    const provider = `${model.provider || ''}`.toLowerCase();

    if (/sora/.test(modelName)) return 'SoraLogo';
    if (/kling/.test(modelName)) return 'KlingLogo';
    if (/pixverse/.test(modelName)) return 'PixverseLogo';
    if (/minimax|hailuo/.test(modelName)) return 'MinimaxLogo';
    if (/\bwan\b/.test(modelName)) return 'WanLogo';
    if (/ltx/.test(modelName)) return 'LtxLogo';
    if (/nvidia|cosmos/.test(modelName)) return 'NvidiaLogo';
    if (/fal\.ai/.test(provider)) return 'FalLogo';
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
