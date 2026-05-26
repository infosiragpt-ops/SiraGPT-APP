'use strict';

const crypto = require('node:crypto');

function nowMs() { return Date.now(); }

function createTraceId(prefix = 'orch') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function createHeliconeProxy(env = process.env) {
  const apiKey = env.HELICONE_API_KEY;
  if (!apiKey) return null;

  return {
    enabled: true,
    wrapHeaders(baseHeaders = {}) {
      return {
        ...baseHeaders,
        'Helicone-Auth': `Bearer ${apiKey}`,
        'Helicone-User-Id': baseHeaders['Helicone-User-Id'] || env.HELICONE_USER_ID || undefined,
        'Helicone-Property-Tag': env.HELICONE_PROPERTY_TAG || undefined,
      };
    },
    wrapBaseURL(baseURL) {
      if (!baseURL || env.HELICONE_BYPASS === '1') return baseURL;
      return `https://helicone.ai/${baseURL.replace(/^https?:\/\//, '')}`;
    },
    proxyConfig(provider) {
      if (!this.enabled) return {};
      if (provider.id === 'openai') {
        return { baseURL: 'https://oai.helicone.ai/v1', defaultHeaders: this.wrapHeaders({}) };
      }
      if (provider.id === 'anthropic') {
        return { baseURL: 'https://anthropic.helicone.ai/v1', defaultHeaders: this.wrapHeaders({}) };
      }
      return {};
    },
  };
}

function createLangfuseTracer({ env = process.env, logger = console } = {}) {
  const configured = Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
  let client = null;
  if (configured) {
    try {
      const { Langfuse } = require('langfuse');
      client = new Langfuse({
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        baseUrl: env.LANGFUSE_HOST,
        flushAt: Number.parseInt(env.LANGFUSE_FLUSH_AT || '15', 10),
        flushInterval: Number.parseInt(env.LANGFUSE_FLUSH_INTERVAL_MS || '10000', 10),
      });
    } catch (err) {
      logger.warn?.({ err }, 'langfuse sdk unavailable; tracing disabled');
    }
  }

  const helicone = createHeliconeProxy(env);

  return {
    enabled: Boolean(client),
    helicone,
    startSpan(name, metadata = {}) {
      const started = nowMs();
      const traceId = metadata.traceId || createTraceId();
      const span = client?.span?.({ name, metadata: { ...metadata, traceId } });
      return {
        traceId,
        end(output = {}) {
          const durationMs = nowMs() - started;
          try {
            span?.end?.({ output, metadata: { durationMs, ...output?.metadata } });
          } catch (err) {
            logger.warn?.({ err }, 'langfuse span end failed');
          }
          return { traceId, durationMs };
        },
      };
    },

    scoreTrace(traceId, { name, value, comment } = {}) {
      try {
        client?.score?.({ traceId, name, value, comment });
      } catch (err) {
        logger.warn?.({ err }, 'langfuse score failed');
      }
    },

    async flush() {
      if (client?.flushAsync) await client.flushAsync();
    },

    recordGeneration(params) {
      const traceId = createTraceId('gen');
      const span = this.startSpan('generation', { traceId, ...params });
      try {
        client?.generation?.({
          name: params.name || 'llm-completion',
          model: params.model,
          modelParameters: params.modelParameters,
          input: params.input,
          output: params.output,
          startTime: new Date(),
          endTime: new Date(),
          usage: params.usage,
          metadata: params.metadata,
        });
      } catch (_) {}
      return { traceId, span };
    },
  };
}

function recordLLMMetrics({ model, provider, inputTokens = 0, outputTokens = 0, costUsd = 0, latencyMs = 0, cached = false } = {}) {
  return {
    model: model || 'unknown',
    provider: provider || 'unknown',
    tokens: { input: inputTokens, output: outputTokens },
    costUsd: Number.isFinite(costUsd) ? costUsd : 0,
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : 0,
    cached: Boolean(cached),
  };
}

function estimateCostUsd({ model = '', inputTokens = 0, outputTokens = 0 } = {}) {
  const rates = {
    'claude-opus-4-7': { input: 15, output: 75 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 0.80, output: 4 },
    'gpt-4o': { input: 2.5, output: 10 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'gemini-2.5-pro': { input: 1.25, output: 5 },
    'gemini-2.5-flash': { input: 0.15, output: 0.60 },
    'llama-3.3-70b': { input: 0.59, output: 0.79 },
    'deepseek-reasoner': { input: 0.55, output: 2.19 },
    'deepseek-chat': { input: 0.27, output: 1.10 },
    'voyage-3-large': { input: 0.06, output: 0 },
    'jina-embeddings-v3': { input: 0.02, output: 0 },
  };

  const modelLower = (model || '').toLowerCase();
  let rate = rates[modelLower] || { input: 0, output: 0 };

  if (!rate.input) {
    for (const [key, val] of Object.entries(rates)) {
      if (modelLower.includes(key)) { rate = val; break; }
    }
  }

  return (inputTokens / 1_000_000) * (rate.input || 3) + (outputTokens / 1_000_000) * (rate.output || 15);
}

module.exports = {
  createHeliconeProxy,
  createLangfuseTracer,
  createTraceId,
  estimateCostUsd,
  recordLLMMetrics,
};
