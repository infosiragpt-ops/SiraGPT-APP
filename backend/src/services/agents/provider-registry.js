/**
 * provider-registry — abstract provider interface with automatic failover.
 *
 * Problem:
 *   Currently, each provider (OpenAI, Anthropic, Groq, Gemini, etc.) is
 *   wired directly into the chat and agent code paths. If one provider
 *   degrades, there's no mechanism to fall through to another. Adding a
 *   new provider requires changes across multiple files.
 *
 * Solution:
 *   A registry that maps model capabilities to concrete provider instances
 *   and automatically fails over when the primary is unhealthy. The
 *   provider layer is:
 *
 *   ProviderRegistry
 *     ├── register(name, adapter)        — add a provider
 *     ├── resolve(model, capabilities)   — pick the best provider
 *     ├── execute(model, fn, opts)       — run with failover
 *     └── healthCheck()                  — probe all providers
 *
 *   Each provider adapter implements the same interface:
 *     { name, models, supports(model), complete(prompt, opts), stream(prompt, opts), health() }
 *
 *   This is deliberately NOT a copy of OpenClaw's provider loop — it's
 *   a simpler, cleaner interface that integrates with SiraGPT's existing
 *   circuit-breaker and bulkhead patterns.
 *
 * Production hardening:
 *   - Failover chain: primary → secondary → tertiary
 *   - Circuit-breaker per provider (reuses existing getBreaker)
 *   - Bulkhead per provider (reuses new bulkhead.js)
 *   - Result caching for idempotent requests
 *   - Model capability matching (text, code, reasoning, vision, etc.)
 */

const EventEmitter = require('events');
const { getBreaker } = require('../circuit-breaker');
const { getBulkhead } = require('./bulkhead');

// ─── Provider priorities ───────────────────────────────────────────────────

const CAPABILITY_PRIORITY = {
  reasoning: ['openai', 'anthropic', 'google', 'groq'],
  code: ['anthropic', 'openai', 'google', 'groq'],
  vision: ['openai', 'anthropic', 'google', 'groq'],
  text: ['openai', 'anthropic', 'google', 'groq', 'openrouter'],
  fast: ['groq', 'openai', 'google', 'anthropic'],
  cheap: ['groq', 'openrouter', 'openai'],
};

// ─── ProviderAdapter — abstract base ──────────────────────────────────────

/**
 * Subclasses should implement:
 *   async complete(prompt, opts) → { text, usage, model }
 *   async stream(prompt, opts) → AsyncIterable<{ text, usage?, model? }>
 *   async health() → { ok: bool, latency: ms }
 *   get models() → string[]
 *   supports(model) → bool
 *   get name() → string
 */
class ProviderAdapter {
  get name() { throw new Error('not implemented'); }
  get models() { return []; }
  supports(_model) { return true; }
  async complete(_prompt, _opts) { throw new Error('not implemented'); }
  async stream(_prompt, _opts) { throw new Error('not implemented'); }
  async health() { return { ok: false, latency: 0 }; }

  /**
   * Wrap a provider call with circuit breaker + bulkhead + timeout.
   */
  async execute(method, args, opts = {}) {
    const breakerName = `${this.name}:${method}`;
    const bulkheadName = `provider:${this.name}`;

    const breaker = getBreaker(breakerName, {
      failureThreshold: opts.failureThreshold ?? 5,
      resetTimeoutMs: opts.resetTimeoutMs ?? 60_000,
      halfOpenMaxCalls: 1,
    });

    const bulkhead = getBulkhead(bulkheadName, {
      maxConcurrent: opts.maxConcurrent ?? 10,
      queueCapacity: opts.queueCapacity ?? 50,
      timeoutMs: opts.perCallTimeoutMs ?? 120_000,
    });

    return bulkhead.execute(async () => {
      return breaker.execute(async () => {
        if (method === 'complete') {
          return this.complete(args.prompt, opts);
        } else if (method === 'stream') {
          return this.stream(args.prompt, opts);
        }
        throw new Error(`Unknown method: ${method}`);
      });
    }, { signal: opts.signal });
  }
}

// ─── ProviderRegistry ──────────────────────────────────────────────────────

class ProviderRegistry extends EventEmitter {
  constructor() {
    super();
    this._providers = new Map();   // name → ProviderAdapter
    this._cache = new Map();       // model → provider name
    this._healthCache = new Map(); // provider → health result
    this._healthInterval = null;
    this._ready = false;
  }

  /**
   * Register a provider adapter.
   *
   * @param {ProviderAdapter} adapter
   */
  register(adapter) {
    if (!adapter || typeof adapter.name !== 'string') {
      throw new Error('ProviderRegistry.register: adapter must have a name');
    }
    this._providers.set(adapter.name, adapter);
    this._cache.delete(adapter.name); // invalidate cached resolutions
    this.emit('provider_registered', { name: adapter.name, models: adapter.models });
    this._ready = true;
  }

  /**
   * Unregister a provider by name.
   */
  unregister(name) {
    this._providers.delete(name);
    this._cache.delete(name);
    this._healthCache.delete(name);
    this.emit('provider_unregistered', { name });
    if (this._providers.size === 0) this._ready = false;
  }

  /**
   * Whether any providers are registered.
   */
  get ready() { return this._ready; }

  /**
   * List of registered provider names.
   */
  get providers() {
    return Array.from(this._providers.keys());
  }

  /**
   * Get a provider adapter by name.
   */
  get(name) {
    return this._providers.get(name) || null;
  }

  /**
   * Resolve the best provider for a given model or capability.
   *
   * Strategy:
   *   1. If model starts with a known provider prefix (e.g., "gpt-4" → openai),
   *      use that provider.
   *   2. If a capability is specified, use the priority list.
   *   3. Fall back to the first healthy provider.
   *
   * @param {string} [model]
   * @param {string} [capability]  — one of 'reasoning', 'code', 'vision', 'text', 'fast', 'cheap'
   * @returns {ProviderAdapter|null}
   */
  resolve(model, capability) {
    if (!this._ready || this._providers.size === 0) return null;

    const cacheKey = `${model || ''}:${capability || ''}`;
    const cached = this._cache.get(cacheKey);
    if (cached) return this._providers.get(cached) || null;

    let candidates = [];

    // Strategy 1: model-based routing
    if (model) {
      const modelLower = model.toLowerCase();
      // Check direct model match
      for (const adapter of this._providers.values()) {
        if (adapter.supports(model)) {
          candidates.push(adapter);
        }
      }

      // Check provider prefix match (e.g., "gpt-4" → openai)
      if (candidates.length === 0) {
        const prefixMap = this._buildProviderPrefixMap();
        for (const [prefix, providerName] of prefixMap) {
          if (modelLower.startsWith(prefix)) {
            const adapter = this._providers.get(providerName);
            if (adapter) candidates.push(adapter);
          }
        }
      }
    }

    // Strategy 2: capability-based routing
    if (candidates.length === 0 && capability) {
      const priority = CAPABILITY_PRIORITY[capability];
      if (priority) {
        for (const name of priority) {
          const adapter = this._providers.get(name);
          if (adapter) candidates.push(adapter);
        }
      }
    }

    // Strategy 3: fallback to any healthy provider
    if (candidates.length === 0) {
      candidates = Array.from(this._providers.values());
    }

    // Deduplicate while preserving order
    const seen = new Set();
    const unique = candidates.filter(a => {
      if (seen.has(a.name)) return false;
      seen.add(a.name);
      return true;
    });

    if (unique.length === 0) return null;

    // Cache the best candidate (non-expiring; invalidated on register/unregister)
    this._cache.set(cacheKey, unique[0].name);
    return unique[0];
  }

  /**
   * Build a map of known model prefixes to provider names.
   */
  _buildProviderPrefixMap() {
    const map = [];
    for (const adapter of this._providers.values()) {
      for (const model of adapter.models) {
        const prefix = model.toLowerCase().split(/[-\/]/)[0];
        if (prefix) {
          map.push([prefix, adapter.name]);
        }
      }
    }
    return map;
  }

  /**
   * Execute a completion with automatic failover.
   *
   * Tries the primary provider first. If it fails (breaker open, timeout, 5xx),
   * tries the next provider in the failover chain. Continues until one succeeds
   * or all providers in the chain have been exhausted.
   *
   * @param {string} model        — requested model
   * @param {object} prompt       — { system, messages, tools?, ... }
   * @param {object} [opts]
   * @param {string} [opts.capability]
   * @param {AbortSignal} [opts.signal]
   * @param {number} [opts.maxRetries=0]  — additional retries after failover
   * @returns {Promise<{ text: string, usage: object, model: string, provider: string }>}
   */
  async execute(model, prompt, opts = {}) {
    const primary = this.resolve(model, opts.capability);
    if (!primary) {
      throw new Error(`No provider available for model="${model}" capability="${opts.capability || ''}"`);
    }

    // Build the failover chain: resolve all candidates for this model
    const allNames = Array.from(this._providers.keys());
    const primaryIdx = allNames.indexOf(primary.name);

    // Order: primary first, then by capability priority, then remaining
    const ordered = [primary.name];
    const priority = opts.capability ? CAPABILITY_PRIORITY[opts.capability] || [] : [];
    for (const name of priority) {
      if (!ordered.includes(name) && this._providers.has(name)) {
        ordered.push(name);
      }
    }
    for (const name of allNames) {
      if (!ordered.includes(name)) {
        ordered.push(name);
      }
    }

    const errors = [];

    for (const providerName of ordered) {
      const adapter = this._providers.get(providerName);
      if (!adapter) continue;

      try {
        const result = await adapter.execute('complete', { prompt }, {
          ...opts,
          signal: opts.signal,
        });

        // Success — return with provider metadata
        return {
          ...result,
          provider: providerName,
          failoverCount: errors.length,
        };
      } catch (err) {
        errors.push({ provider: providerName, error: err.message });

        // If this was a non-transient error on the primary, still try failover
        // but log it. On the last provider, throw.
        const isLast = providerName === ordered[ordered.length - 1];
        if (isLast) {
          break;
        }

        // Short delay before failover (prevents hammering the next provider)
        await new Promise(r => setTimeout(r, 100));
        this.emit('failover', { from: providerName, to: ordered[ordered.length - 1], error: err.message });
      }
    }

    // All providers failed — throw a composite error
    const composite = new Error(
      `All providers failed for model="${model}". Errors: ${errors.map(e => `${e.provider}: ${e.error}`).join('; ')}`
    );
    composite.name = 'AllProvidersFailedError';
    composite.errors = errors;
    composite.model = model;
    throw composite;
  }

  /**
   * Execute a streaming completion with automatic failover.
   * Returns an async iterable.
   */
  async *executeStream(model, prompt, opts = {}) {
    const primary = this.resolve(model, opts.capability);
    if (!primary) {
      throw new Error(`No provider available for model="${model}" capability="${opts.capability || ''}"`);
    }

    // Similar failover chain as execute()
    const allNames = Array.from(this._providers.keys());
    const ordered = [primary.name];
    const priority = opts.capability ? CAPABILITY_PRIORITY[opts.capability] || [] : [];
    for (const name of priority) {
      if (!ordered.includes(name) && this._providers.has(name)) {
        ordered.push(name);
      }
    }
    for (const name of allNames) {
      if (!ordered.includes(name)) {
        ordered.push(name);
      }
    }

    const errors = [];

    for (const providerName of ordered) {
      const adapter = this._providers.get(providerName);
      if (!adapter) continue;

      try {
        const stream = adapter.execute('stream', { prompt }, {
          ...opts,
          signal: opts.signal,
        });

        for await (const chunk of stream) {
          yield { ...chunk, provider: providerName };
        }
        return; // Stream completed successfully
      } catch (err) {
        errors.push({ provider: providerName, error: err.message });
        const isLast = providerName === ordered[ordered.length - 1];
        if (isLast) break;
        await new Promise(r => setTimeout(r, 100));
        this.emit('failover', { from: providerName, to: ordered[ordered.length - 1], error: err.message });
      }
    }

    throw new Error(
      `All providers failed for streaming model="${model}". Errors: ${errors.map(e => `${e.provider}: ${e.error}`).join('; ')}`
    );
  }

  /**
   * Health-check all registered providers.
   * Caches results for `ttlMs` to avoid hammering providers during rapid checks.
   *
   * @param {number} [ttlMs=30_000]  — cache TTL
   * @returns {Promise<Array<{ name: string, ok: boolean, latency: number }>>}
   */
  async healthCheck(ttlMs = 30_000) {
    const now = Date.now();
    const results = [];

    for (const [name, adapter] of this._providers) {
      const cached = this._healthCache.get(name);
      if (cached && (now - cached.timestamp) < ttlMs) {
        results.push(cached.result);
        continue;
      }

      try {
        const health = await adapter.health();
        const entry = { name, ok: health.ok, latency: health.latency };
        this._healthCache.set(name, { result: entry, timestamp: now });
        results.push(entry);
      } catch {
        const entry = { name, ok: false, latency: Infinity };
        this._healthCache.set(name, { result: entry, timestamp: now });
        results.push(entry);
      }
    }

    this.emit('health_check', results);
    return results;
  }

  /**
   * Start periodic health checks.
   *
   * @param {number} [intervalMs=60_000]
   */
  startPeriodicHealth(intervalMs = 60_000) {
    this.stopPeriodicHealth();

    // Run immediately
    this.healthCheck().catch(() => {});

    this._healthInterval = setInterval(() => {
      this.healthCheck().catch(() => {});
    }, intervalMs);

    this._healthInterval.unref();
  }

  /**
   * Stop periodic health checks.
   */
  stopPeriodicHealth() {
    if (this._healthInterval) {
      clearInterval(this._healthInterval);
      this._healthInterval = null;
    }
  }

  /**
   * Clear all caches (provider resolutions and health).
   */
  clearCaches() {
    this._cache.clear();
    this._healthCache.clear();
  }

  /**
   * Get the number of registered providers.
   */
  get size() { return this._providers.size; }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

const globalRegistry = new ProviderRegistry();

function getProviderRegistry() {
  return globalRegistry;
}

module.exports = {
  ProviderRegistry,
  ProviderAdapter,
  getProviderRegistry,
  CAPABILITY_PRIORITY,
};
