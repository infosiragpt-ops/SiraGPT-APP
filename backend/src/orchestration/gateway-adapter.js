'use strict';

const { LLMGateway } = require('./llm-gateway');
const { createUpstashSemanticCache } = require('./semantic-cache');
const { createLangfuseTracer } = require('./observability');
const { searchFreshContext, needsFreshWebContext } = require('./web-search-tools');
const { createMemoryAdapter } = require('./memory-adapter');
const { createSSEReplayBuffer, attachSSEStream, writeSSE } = require('./sse-stream');
const { classifySource, labelFor: confidenceLabel } = require('../services/search/source-confidence');

let _gatewaySingleton = null;
let _cacheSingleton = null;
let _tracerSingleton = null;
let _memoryAdapterSingleton = null;
let _sseBufferSingleton = null;

function getGateway(opts = {}) {
  if (!_gatewaySingleton) {
    const cache = opts.cache || getCache(opts);
    const tracer = opts.tracer || getTracer(opts);
    _gatewaySingleton = new LLMGateway({
      env: opts.env || process.env,
      cache,
      tracer,
    });
  }
  return _gatewaySingleton;
}

function getCache(opts = {}) {
  if (!_cacheSingleton) {
    _cacheSingleton = createUpstashSemanticCache({ env: opts.env || process.env });
  }
  return _cacheSingleton;
}

function getTracer(opts = {}) {
  if (!_tracerSingleton) {
    _tracerSingleton = createLangfuseTracer({ env: opts.env || process.env });
  }
  return _tracerSingleton;
}

function getMemoryAdapter(opts = {}) {
  if (!_memoryAdapterSingleton) {
    _memoryAdapterSingleton = createMemoryAdapter({
      gateway: opts.gateway || getGateway(opts),
    });
  }
  return _memoryAdapterSingleton;
}

function getSSEBuffer(opts = {}) {
  if (!_sseBufferSingleton) {
    _sseBufferSingleton = createSSEReplayBuffer({
      maxEvents: Number.parseInt(opts.maxEvents || '500', 10) || 500,
      heartbeatMs: Number.parseInt(opts.heartbeatMs || '15000', 10) || 15000,
    });
  }
  return _sseBufferSingleton;
}

async function enrichWithWebSearch(prompt, opts = {}) {
  const mode = String(opts.mode || 'auto').toLowerCase();
  const dedicated = mode === 'dedicated';
  if (!dedicated && !needsFreshWebContext(prompt)) return null;

  try {
    const results = await searchFreshContext(prompt, {
      env: opts.env || process.env,
      fetchImpl: opts.fetchImpl || globalThis.fetch,
      limit: dedicated ? 12 : 5,
    });

    if (!results?.results?.length) return null;

    const sliceCount = dedicated ? 10 : 5;
    const sliced = results.results.slice(0, sliceCount);
    const tally = { verified: 0, unverified: 0, inferred: 0 };
    const snippets = sliced.map((r) => {
      const cls = classifySource({ url: r.url });
      tally[cls.confidence] = (tally[cls.confidence] || 0) + 1;
      const label = confidenceLabel(cls.confidence);
      const title = r.title || 'Source';
      const url = r.url || '#';
      const snippet = (r.content || r.snippet || '').slice(0, dedicated ? 500 : 300);
      return `- [${label}] [${title}](${url}): ${snippet}`;
    });

    const trustGuidance =
      'Cita cada fuente con su etiqueta de confianza entre paréntesis (verificada / sin verificar / inferida). ' +
      'No afirmes hechos respaldados solo por fuentes "sin verificar" sin advertirlo al usuario, y nunca presentes ' +
      'información "inferida" como verificada.';
    const tallyLine =
      `Resumen de fuentes — verificadas: ${tally.verified || 0}, sin verificar: ${tally.unverified || 0}, ` +
      `inferidas: ${tally.inferred || 0}.`;

    return {
      source: results.provider,
      mode: dedicated ? 'dedicated' : 'auto',
      injectedAt: new Date().toISOString(),
      sourceConfidence: tally,
      block:
        `\n\n[Fresh Web Context — ${results.provider}${dedicated ? ' (dedicated)' : ''}]\n` +
        `${snippets.join('\n')}\n` +
        `\n${tallyLine}\n${trustGuidance}\n` +
        `[/Fresh Web Context]`,
    };
  } catch (_) {
    return null;
  }
}

function toOpenAIResponseFormat(gatewayResult) {
  if (!gatewayResult?.response) return null;

  if (gatewayResult.response.choices) {
    return gatewayResult.response;
  }

  if (gatewayResult.provider === 'anthropic') {
    const content = gatewayResult.response.content?.[0]?.text || '';
    return {
      choices: [{ message: { content, role: 'assistant' }, index: 0, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: gatewayResult.response.usage?.input_tokens || 0,
        completion_tokens: gatewayResult.response.usage?.output_tokens || 0,
        total_tokens: (gatewayResult.response.usage?.input_tokens || 0) + (gatewayResult.response.usage?.output_tokens || 0),
      },
      model: gatewayResult.model,
    };
  }

  return gatewayResult.response;
}

async function gatewayComplete({ messages, prompt, files, temperature, signal, taskType, cacheContext, skipCache, res }) {
  const gateway = getGateway();

  const result = await gateway.complete({
    messages,
    prompt,
    files,
    taskType,
    temperature: typeof temperature === 'number' ? temperature : 0.55,
    signal,
    stream: false,
    cacheContext: cacheContext || {},
    skipCache,
  });

  const openaiFormat = toOpenAIResponseFormat(result);
  return {
    ...openaiFormat,
    _gateway: {
      provider: result.provider,
      model: result.model,
      cached: result.cached,
      attempts: result.attempts,
      metrics: result.metrics,
      taskType,
    },
  };
}

async function enrichUserContext({ userId, prompt, chatId, req, opts = {} }) {
  const enrichments = {};

  if (userId && prompt) {
    try {
      const memoryAdapter = getMemoryAdapter(opts);
      const memoryBlock = await memoryAdapter.buildMemoryPrompt(userId, prompt);
      if (memoryBlock) enrichments.memoryBlock = memoryBlock;
    } catch (_) {}
  }

  try {
    const webContext = await enrichWithWebSearch(prompt, opts);
    if (webContext) enrichments.webContext = webContext;
  } catch (_) {}

  return enrichments;
}

async function embedTexts(texts, opts = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const gateway = getGateway(opts);

  const results = [];
  for (const input of texts) {
    const result = await gateway.embed({ input, signal: opts.signal });
    if (result?.response?.data?.[0]?.embedding) {
      results.push(new Float32Array(result.response.data[0].embedding));
    }
  }
  return results;
}

function resetOrchestrationCache() {
  _gatewaySingleton = null;
  _cacheSingleton = null;
  _tracerSingleton = null;
  _memoryAdapterSingleton = null;
  _sseBufferSingleton = null;
}

module.exports = {
  enrichUserContext,
  enrichWithWebSearch,
  gatewayComplete,
  getCache,
  getGateway,
  getMemoryAdapter,
  getSSEBuffer,
  getTracer,
  embedTexts,
  resetOrchestrationCache,
  toOpenAIResponseFormat,
};
