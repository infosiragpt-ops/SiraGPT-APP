'use strict';

/**
 * OpenAI-shaped chat.completions clients for first-party connections.
 * Claude / Kimi / xAI must not fall through to OpenAI or OpenRouter.
 */

const OpenAI = require('openai');
const { CONNECTION_UNAVAILABLE_MESSAGE } = require('./provider-inference');

function throwUnavailable(provider) {
  const err = new Error(CONNECTION_UNAVAILABLE_MESSAGE);
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

function toOpenAiChunk(text, { model, done = false } = {}) {
  return {
    id: `sira-${Date.now()}`,
    object: 'chat.completion.chunk',
    model: model || '',
    choices: [{
      index: 0,
      delta: done ? {} : { content: text },
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

function anthropicSupportsThinkingToggle(model) {
  return /claude-(?:3-7|(?:sonnet|opus|haiku)-[4-9]|[4-9]|fable)/i.test(String(model || ''));
}

function applyAnthropicThinkingControls(body, payload, model) {
  if (!body || typeof body !== 'object') return body;
  const thinking = payload && payload.thinking;
  const reasoningExcluded = payload && payload.reasoning && payload.reasoning.exclude === true;
  if ((thinking && thinking.type === 'disabled') || reasoningExcluded) {
    if (anthropicSupportsThinkingToggle(model || body.model)) {
      body.thinking = { type: 'disabled' };
    }
  }
  return body;
}

function createAnthropicStreamingClient({
  apiKey = process.env.ANTHROPIC_API_KEY || process.env.SIRA_ANTHROPIC_API_KEY,
  fetchImpl,
  timeout,
} = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throwUnavailable('Anthropic');

  async function getSdk() {
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
          if (!payload.stream) {
            const resp = await client.messages.create(body, {
              signal: requestOptions && requestOptions.signal,
            });
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
          const stream = client.messages.stream(body);
          if (requestOptions && requestOptions.signal) {
            const abort = () => {
              try { stream.abort(); } catch { /* already closed */ }
            };
            if (requestOptions.signal.aborted) abort();
            else requestOptions.signal.addEventListener('abort', abort, { once: true });
          }
          return (async function* anthropicOpenAiStream() {
            for await (const event of stream) {
              const text = extractAnthropicText(event);
              if (text) yield toOpenAiChunk(text, { model });
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
  anthropicSupportsThinkingToggle,
  applyAnthropicThinkingControls,
};
