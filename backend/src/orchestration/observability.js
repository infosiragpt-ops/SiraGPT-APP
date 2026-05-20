'use strict';

const crypto = require('node:crypto');

function nowMs() { return Date.now(); }

function createTraceId(prefix = 'orch') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
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
      });
    } catch (err) {
      logger.warn?.({ err }, 'langfuse sdk unavailable; tracing disabled');
    }
  }

  return {
    enabled: Boolean(client),
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
    async flush() {
      if (client?.flushAsync) await client.flushAsync();
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

module.exports = { createLangfuseTracer, createTraceId, recordLLMMetrics };
