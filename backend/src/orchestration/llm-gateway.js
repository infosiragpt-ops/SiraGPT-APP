'use strict';

// Lazy-require optional / heavy SDK deps so this module loads even when they
// aren't installed (fresh checkouts, partial installs, environments that only
// use embeddings/anthropic). Mirrors the document-* analyzer "lazy require"
// pattern (CLAUDE.md) and the r2-storage.js loadSdk() helper. The constructors
// are only resolved on first actual call to the gateway, keeping
// `require('./orchestration')` resilient when these deps are absent.
let _OpenAICtor = null;
function loadOpenAI() {
  if (_OpenAICtor) return _OpenAICtor;
  // eslint-disable-next-line global-require
  _OpenAICtor = require('openai');
  return _OpenAICtor;
}

let _CircuitBreakerCtor = null;
function loadCircuitBreaker() {
  if (_CircuitBreakerCtor) return _CircuitBreakerCtor;
  // eslint-disable-next-line global-require
  _CircuitBreakerCtor = require('opossum');
  return _CircuitBreakerCtor;
}

const { sharedFetch } = require('../utils/provider-http-agent');
const { configuredProviders, detectTaskType, providerApiKey, TASK_MODEL_HINTS } = require('./llm-routing.config');
const {
  createUpstashSemanticCache,
  resolveCacheTtlSeconds,
  semanticCacheKey,
  shouldBypassSemanticCache,
} = require('./semantic-cache');
const { createLangfuseTracer, recordLLMMetrics } = require('./observability');

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.SIRAGPT_LLM_GATEWAY_TIMEOUT_MS || '45000', 10);
const DEFAULT_RESET_MS = Number.parseInt(process.env.SIRAGPT_LLM_GATEWAY_BREAKER_RESET_MS || '60000', 10);

function parseRetryAfter(headers = {}) {
  const raw = headers['retry-after'] || headers['Retry-After'];
  if (!raw) return null;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function classifyRateLimit(err) {
  const status = err?.status || err?.statusCode || err?.response?.status;
  const headers = err?.headers || err?.response?.headers || {};
  if (status === 429 || headers['x-ratelimit-remaining'] === '0') {
    return { limited: true, retryAfterMs: parseRetryAfter(headers), headers };
  }
  return { limited: false, retryAfterMs: null, headers };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jitteredBackoff(attempt, retryAfterMs) {
  if (retryAfterMs != null) return Math.min(retryAfterMs, 15_000);
  return Math.min(10_000, 300 * (2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 250));
}

function toProviderModel(candidate) {
  const [providerId, ...modelParts] = String(candidate || '').split(':');
  return { providerId, model: modelParts.join(':') };
}

function scoreProvider(provider, taskType) {
  const weights = taskType === 'speed'
    ? { quality: 0.25, latency: 0.55, cost: 0.20 }
    : taskType === 'deep_reasoning' || taskType === 'code'
      ? { quality: 0.60, latency: 0.20, cost: 0.20 }
      : { quality: 0.45, latency: 0.30, cost: 0.25 };
  const s = provider.score || {};
  return (s.quality || 0) * weights.quality + (s.latency || 0) * weights.latency + (s.cost || 0) * weights.cost + ((provider.priority || 0) / 1000);
}

class LLMGateway {
  constructor({ env = process.env, cache = createUpstashSemanticCache({ env }), tracer = createLangfuseTracer({ env }) } = {}) {
    this.env = env;
    this.breakers = new Map();
    this.cache = cache;
    this.tracer = tracer;
  }

  getBreaker(provider, model) {
    const key = `${provider.id}:${model}`;
    if (!this.breakers.has(key)) {
      const CircuitBreaker = loadCircuitBreaker();
      this.breakers.set(key, new CircuitBreaker(
        payload => this.invokeProvider(provider, model, payload),
        {
          timeout: DEFAULT_TIMEOUT_MS,
          errorThresholdPercentage: 50,
          resetTimeout: DEFAULT_RESET_MS,
          rollingCountTimeout: 60_000,
        },
      ));
    }
    return this.breakers.get(key);
  }

  clientFor(provider) {
    const apiKey = providerApiKey(provider, this.env);
    if (!apiKey) throw Object.assign(new Error(`${provider.envKey} is not configured`), { status: 503 });
    const opts = { apiKey, fetch: sharedFetch };
    if (provider.baseURL) opts.baseURL = provider.baseURL;
    if (provider.id === 'openrouter') {
      opts.defaultHeaders = {
        'HTTP-Referer': this.env.NEXT_PUBLIC_URL || this.env.FRONTEND_URL || 'http://localhost:3000',
        'X-Title': 'SiraGPT',
      };
    }
    const OpenAI = loadOpenAI();
    return new OpenAI(opts);
  }

  async invokeProvider(provider, model, { messages, temperature, stream, signal, input }) {
    if (provider.id === 'anthropic') {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: providerApiKey(provider, this.env), fetch: sharedFetch });
      const system = messages?.find(message => message.role === 'system')?.content;
      const anthropicMessages = (messages || [])
        .filter(message => message.role !== 'system')
        .map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content || '') }));
      return client.messages.create({
        model,
        max_tokens: Number.parseInt(this.env.SIRAGPT_LLM_MAX_TOKENS || '4096', 10),
        temperature,
        system,
        messages: anthropicMessages,
        stream: Boolean(stream),
      }, { signal });
    }

    if (provider.id === 'voyage') {
      const res = await sharedFetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${providerApiKey(provider, this.env)}` },
        body: JSON.stringify({ model, input: input || messages?.map(m => m.content).join('\n') || '' }),
        signal,
      });
      if (!res.ok) throw Object.assign(new Error(`Voyage embeddings failed: ${res.status}`), { status: res.status, headers: Object.fromEntries(res.headers.entries()) });
      return res.json();
    }

    if (provider.id === 'jina') {
      const res = await sharedFetch('https://api.jina.ai/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${providerApiKey(provider, this.env)}` },
        body: JSON.stringify({ model, input: input || messages?.map(m => m.content).join('\n') || '' }),
        signal,
      });
      if (!res.ok) throw Object.assign(new Error(`Jina embeddings failed: ${res.status}`), { status: res.status, headers: Object.fromEntries(res.headers.entries()) });
      return res.json();
    }

    const client = this.clientFor(provider);
    return client.chat.completions.create({
      model,
      messages,
      temperature,
      stream: Boolean(stream),
    }, { signal });
  }

  candidatesFor(taskType) {
    const configured = configuredProviders(this.env);
    const byId = new Map(configured.map(provider => [provider.id, provider]));
    const hinted = (TASK_MODEL_HINTS[taskType] || TASK_MODEL_HINTS.default)
      .map(toProviderModel)
      .filter(({ providerId }) => byId.has(providerId));
    const hintedKeys = new Set(hinted.map(c => `${c.providerId}:${c.model}`));
    const scored = configured
      .filter(provider => provider.capabilities.includes(taskType === 'embeddings' ? 'embeddings' : 'chat'))
      .sort((a, b) => scoreProvider(b, taskType) - scoreProvider(a, taskType))
      .flatMap(provider => provider.models.map(model => ({ providerId: provider.id, model })))
      .filter(c => !hintedKeys.has(`${c.providerId}:${c.model}`));
    return [...hinted, ...scored].map(c => ({ ...c, provider: byId.get(c.providerId) })).filter(c => c.provider);
  }

  async complete({ messages, prompt = '', files = [], taskType, temperature = 0.55, signal, stream = false, cacheContext = {} } = {}) {
    const resolvedTask = taskType || detectTaskType({ prompt, files });
    const candidates = this.candidatesFor(resolvedTask);
    if (candidates.length === 0) {
      throw Object.assign(new Error(`No configured LLM providers for task ${resolvedTask}`), { status: 503 });
    }
    const primary = candidates[0];
    const ttlSeconds = resolveCacheTtlSeconds(resolvedTask, this.env);
    const cacheKey = semanticCacheKey({ prompt: prompt || messages?.map(m => m.content).join('\n'), context: cacheContext, model: primary.model, temperature });
    if (!stream && !shouldBypassSemanticCache({ prompt, ttlSeconds })) {
      const cached = await this.cache?.get?.(cacheKey);
      if (cached) return { ...cached, cached: true, metrics: recordLLMMetrics({ ...cached.metrics, cached: true }) };
    }

    const span = this.tracer?.startSpan?.('llm.gateway.complete', { taskType: resolvedTask, model: primary.model, provider: primary.providerId });
    const startedAt = Date.now();
    const errors = [];
    for (const candidate of candidates) {
      const breaker = this.getBreaker(candidate.provider, candidate.model);
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await breaker.fire({ messages, temperature, stream, signal });
          const result = {
            response,
            provider: candidate.providerId,
            model: candidate.model,
            taskType: resolvedTask,
            attempts: attempt,
            cached: false,
            metrics: recordLLMMetrics({ provider: candidate.providerId, model: candidate.model, latencyMs: Date.now() - startedAt }),
          };
          span?.end?.({ provider: candidate.providerId, model: candidate.model, attempts: attempt });
          if (!stream && ttlSeconds > 0) await this.cache?.set?.(cacheKey, result, ttlSeconds);
          return result;
        } catch (err) {
          const rateLimit = classifyRateLimit(err);
          errors.push({ provider: candidate.providerId, model: candidate.model, message: err.message, rateLimit });
          if (signal?.aborted) throw err;
          if (attempt < 2 && (rateLimit.limited || err.status >= 500 || err.name === 'TimeoutError')) {
            await sleep(jitteredBackoff(attempt, rateLimit.retryAfterMs));
            continue;
          }
          break;
        }
      }
    }
    const err = new Error('All LLM gateway providers failed');
    err.status = 503;
    err.causes = errors;
    span?.end?.({ error: err.message, providersTried: errors.length });
    throw err;
  }

  async embed({ input, taskType = 'embeddings', signal } = {}) {
    const candidates = this.candidatesFor(taskType);
    const errors = [];
    for (const candidate of candidates) {
      const breaker = this.getBreaker(candidate.provider, candidate.model);
      try {
        const response = await breaker.fire({ input, messages: [], temperature: 0, stream: false, signal });
        return { response, provider: candidate.providerId, model: candidate.model };
      } catch (err) {
        errors.push({ provider: candidate.providerId, model: candidate.model, message: err.message });
      }
    }
    const err = new Error('All embedding providers failed');
    err.status = 503;
    err.causes = errors;
    throw err;
  }
}

module.exports = {
  LLMGateway,
  classifyRateLimit,
  jitteredBackoff,
  scoreProvider,
};
