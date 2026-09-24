'use strict';

/**
 * OpenAI-shaped chat.completions clients for first-party connections.
 * Claude / Kimi / xAI must not fall through to OpenAI or OpenRouter.
 */

const OpenAI = require('openai');
const { PROVIDER_UNAVAILABLE_MESSAGE } = require('./provider-inference');
const {
  anthropicAcceptsDisabledThinking,
  isAnthropicEffortParamError,
} = require('../providers/anthropic-effort');

function throwUnavailable(provider) {
  const err = new Error(PROVIDER_UNAVAILABLE_MESSAGE);
  err.code = 'PROVIDER_CONNECTION_UNAVAILABLE';
  err.status = 503;
  err.provider = provider;
  throw err;
}

function stripVendorPrefix(model, prefixes) {
  const raw = String(model || '').trim();
  const lower = raw.toLowerCase();
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) return raw.slice(prefix.length);
  }
  return raw;
}

function toOpenAiChunk(text, { model, done = false, reasoning = false } = {}) {
  return {
    id: `sira-${Date.now()}`,
    object: 'chat.completion.chunk',
    model: model || '',
    choices: [{
      index: 0,
      delta: done ? {} : (reasoning ? { reasoning_content: text } : { content: text }),
      finish_reason: done ? 'stop' : null,
    }],
  };
}

function extractAnthropicText(event) {
  if (!event) return '';
  if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
    return String(event.delta.text || '');
  }
  return '';
}

// Summarized thinking ("Pensó N s" trace). Never mixed into the answer text.
function extractAnthropicThinking(event) {
  if (event && event.type === 'content_block_delta' && event.delta && event.delta.type === 'thinking_delta') {
    return String(event.delta.thinking || '');
  }
  return '';
}

// `thinking` / `output_config` arrive already resolved per model family by
// the gateway (providers/anthropic-effort.js). A bare `disabled` from other
// callers is only forwarded to models that accept it — Fable 5.x and Opus
// 5.5 answer 400 to it.
function applyAnthropicThinkingControls(body, payload, model) {
  if (!body || typeof body !== 'object') return body;
  const thinking = payload && payload.thinking;
  const reasoningExcluded = payload && payload.reasoning && payload.reasoning.exclude === true;
  const target = model || body.model;
  if ((thinking && thinking.type === 'disabled') || reasoningExcluded) {
    if (anthropicAcceptsDisabledThinking(target)) body.thinking = { type: 'disabled' };
  } else if (thinking && (thinking.type === 'adaptive' || thinking.type === 'enabled')) {
    body.thinking = { ...thinking };
  }
  if (payload && payload.output_config && typeof payload.output_config === 'object') {
    body.output_config = { ...payload.output_config };
  }
  return body;
}

function withoutEffortControls(body) {
  const copy = { ...body };
  delete copy.thinking;
  delete copy.output_config;
  return copy;
}

function createAnthropicStreamingClient({
  apiKey = process.env.ANTHROPIC_API_KEY || process.env.SIRA_ANTHROPIC_API_KEY,
  fetchImpl,
  timeout,
  sdkClient = null,
} = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throwUnavailable('Anthropic');

  async function getSdk() {
    if (sdkClient) return sdkClient;
    const mod = await import('@anthropic-ai/sdk');
    const Sdk = mod.default || mod.Anthropic;
    return new Sdk({ apiKey: key });
  }

  return {
    __siraProvider: 'Anthropic',
    chat: {
      completions: {
        async create(payload = {}, requestOptions = {}) {
          const client = await getSdk();
          const model = stripVendorPrefix(payload.model, ['anthropic/']);
          const messages = Array.isArray(payload.messages) ? payload.messages : [];
          const system = messages
            .filter((m) => m && m.role === 'system')
            .map((m) => (typeof m.content === 'string' ? m.content : ''))
            .filter(Boolean)
            .join('\n\n');
          const transcript = messages
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
            .map((m) => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
            }));
          const body = {
            model: model || 'claude-sonnet-4-6',
            max_tokens: Number(payload.max_tokens) || 16384,
            messages: transcript,
            ...(system ? { system } : {}),
          };
          applyAnthropicThinkingControls(body, payload, model);
          const hasEffortControls = Boolean(body.thinking || body.output_config);
          if (!payload.stream) {
            const createOptions = { signal: requestOptions && requestOptions.signal };
            let resp;
            try {
              resp = await client.messages.create(body, createOptions);
            } catch (error) {
              // A model we don't classify yet may reject the effort fields:
              // retry once without them instead of failing the turn.
              if (!hasEffortControls || !isAnthropicEffortParamError(error)) throw error;
              console.warn(`[anthropic] ${model}: effort controls rejected (${error.message}); retrying without them`);
              resp = await client.messages.create(withoutEffortControls(body), createOptions);
            }
            const text = Array.isArray(resp && resp.content)
              ? resp.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
              : '';
            return {
              id: resp && resp.id,
              object: 'chat.completion',
              model,
              choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            };
          }
          const openStream = async (requestBody) => {
            const stream = client.messages.stream(requestBody);
            if (requestOptions && requestOptions.signal) {
              const abort = () => {
                try { stream.abort(); } catch { /* already closed */ }
              };
              if (requestOptions.signal.aborted) abort();
              else requestOptions.signal.addEventListener('abort', abort, { once: true });
            }
            // Pull the first event here so a 400 surfaces from create() —
            // where the caller's retry/fallback chain can see it — instead
            // of mid-iteration.
            const iterator = stream[Symbol.asyncIterator]();
            const first = await iterator.next();
            return { iterator, first };
          };
          let opened;
          try {
            opened = await openStream(body);
          } catch (error) {
            if (!hasEffortControls || !isAnthropicEffortParamError(error)) throw error;
            console.warn(`[anthropic] ${model}: effort controls rejected (${error.message}); retrying without them`);
            opened = await openStream(withoutEffortControls(body));
          }
          return (async function* anthropicOpenAiStream() {
            let step = opened.first;
            while (!step.done) {
              const event = step.value;
              const thought = extractAnthropicThinking(event);
              if (thought) yield toOpenAiChunk(thought, { model, reasoning: true });
              const text = extractAnthropicText(event);
              if (text) yield toOpenAiChunk(text, { model });
              step = await opened.iterator.next();
            }
            yield toOpenAiChunk('', { model, done: true });
          }());
        },
      },
    },
  };
}

function createMoonshotClient({ fetchImpl, timeout } = {}) {
  const apiKey = String(process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || '').trim();
  if (!apiKey) throwUnavailable('Kimi');
  return new OpenAI({
    apiKey,
    baseURL: process.env.MOONSHOT_BASE_URL || process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1',
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(timeout ? { timeout } : {}),
  });
}

function createXaiClient({ fetchImpl, timeout } = {}) {
  const apiKey = String(process.env.XAI_API_KEY || '').trim();
  if (!apiKey) throwUnavailable('xAI');
  return new OpenAI({
    apiKey,
    baseURL: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(timeout ? { timeout } : {}),
  });
}

module.exports = {
  createAnthropicStreamingClient,
  createMoonshotClient,
  createXaiClient,
  stripVendorPrefix,
  // Kept for callers/tests: true only where `disabled` is accepted.
  anthropicSupportsThinkingToggle: anthropicAcceptsDisabledThinking,
  applyAnthropicThinkingControls,
};
