'use strict';

/**
 * OpenAI-shaped chat.completions clients for first-party connections.
 * Claude / Kimi / xAI must not fall through to OpenAI or OpenRouter.
 */

const OpenAI = require('openai');
const { PROVIDER_UNAVAILABLE_MESSAGE } = require('./provider-inference');
const {
  anthropicAcceptsDisabledThinking,
  anthropicThinkingFamily,
  isAnthropicEffortParamError,
} = require('../providers/anthropic-effort');
const {
  toAnthropicTranscript,
  toAnthropicTools,
  toAnthropicToolChoice,
  toOpenAICompletion,
  mapStopReason,
} = require('../providers/anthropic-openai-adapter');

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

// ── Tool calling (agent loop) ───────────────────────────────────────────────
// The ReAct loop speaks OpenAI `tools` / `tool_calls` / role:'tool'. When a
// request carries any of those, it goes through the adapter's transcript
// translation instead of the text-only path, and native `tool_use` blocks
// come back as OpenAI `tool_calls` (finish_reason 'tool_calls').

function hasToolTraffic(payload) {
  if (Array.isArray(payload.tools) && payload.tools.length > 0) return true;
  return (Array.isArray(payload.messages) ? payload.messages : []).some((m) => m && (
    m.role === 'tool' || (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
  ));
}

// Forced tool_choice (`any` / `tool`) is rejected while thinking is on, and
// always on Fable 5.1 / Mythos 5.1 / Opus 5.5. Those requests run `auto`
// plus an explicit instruction attached to the last user/tool message. The
// instruction is stored ON that message object so every later request of the
// same loop renders it identically (append-only history: preserved thinking
// rejects edited earlier turns).
function forcedToolRejected(model, body) {
  const id = String(model || '').toLowerCase().replace(/(\d+)\.(\d+)/g, '$1-$2');
  if (/^claude-(?:fable|mythos)-5-1(?:-|$)|^claude-opus-5-5(?:-|$)/.test(id)) return true;
  if (anthropicThinkingFamily(model) === 'always_on') return true;
  const thinking = body && body.thinking;
  return Boolean(thinking && thinking.type && thinking.type !== 'disabled');
}

function forcedToolName(choice) {
  if (choice === 'required') return '';
  if (choice && typeof choice === 'object' && choice.type === 'function' && choice.function && choice.function.name) {
    return String(choice.function.name);
  }
  return null;
}

function attachToolNudge(messages, toolName) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || (m.role !== 'user' && m.role !== 'tool')) continue;
    if (!m._anthropicToolNudge) {
      const text = toolName
        ? `Llama ahora a la herramienta \`${toolName}\`; no respondas con texto sin llamarla.`
        : 'Llama ahora a una de las herramientas disponibles; no respondas con texto sin llamarla.';
      try {
        Object.defineProperty(m, '_anthropicToolNudge', { value: text, enumerable: false, configurable: true, writable: true });
      } catch { /* frozen message: fall through without the nudge */ }
    }
    return;
  }
}

// Native blocks (thinking + text + tool_use, in the model's order) are kept
// on the assistant message and replayed verbatim on the next request: tool
// loops with thinking must echo the thinking blocks unchanged.
function rememberNativeContent(message, content, model) {
  if (!message || !Array.isArray(content)) return;
  try {
    Object.defineProperty(message, '_anthropicContent', { value: content, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(message, '_anthropicModel', { value: model, enumerable: false, configurable: true, writable: true });
  } catch { /* noop */ }
}

function nativeBlocksFor(message, model) {
  const raw = message && message._anthropicContent;
  if (!Array.isArray(raw) || message._anthropicModel !== model) return null;
  const rawIds = raw.filter((b) => b && b.type === 'tool_use').map((b) => String(b.id)).sort();
  const callIds = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((c) => String(c && c.id)).sort();
  if (rawIds.join('|') !== callIds.join('|')) return null;
  return raw.filter((b) => b && ['thinking', 'redacted_thinking', 'text', 'tool_use'].includes(b.type));
}

function buildToolTranscript(messages, model) {
  const list = Array.isArray(messages) ? messages : [];
  const out = toAnthropicTranscript(list);
  // Re-walk to splice native assistant blocks and persistent nudges. The
  // adapter coalesces same-role neighbours, so rebuild turn by turn.
  const turns = [];
  const push = (role, blocks) => {
    const clean = blocks.filter(Boolean);
    if (!clean.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...clean);
    else turns.push({ role, content: clean });
  };
  for (const m of list) {
    if (!m || m.role === 'system') continue;
    const native = m.role === 'assistant' ? nativeBlocksFor(m, model) : null;
    if (native && native.length) {
      push('assistant', native.map((b) => ({ ...b })));
    } else {
      const single = toAnthropicTranscript([m]).messages;
      // toAnthropicTranscript prepends a synthetic user turn when the first
      // turn isn't user; drop it for per-message conversion.
      const own = single.filter((t) => !(t.role === 'user' && t.content.length === 1
        && t.content[0].type === 'text' && t.content[0].text === 'Continua con la tarea solicitada.' && m.role !== 'user'));
      for (const t of own) push(t.role, t.content);
    }
    if (m._anthropicToolNudge && (m.role === 'user' || m.role === 'tool' || m.role === 'function')) {
      push('user', [{ type: 'text', text: m._anthropicToolNudge }]);
    }
  }
  if (!turns.length || turns[0].role !== 'user') {
    turns.unshift({ role: 'user', content: [{ type: 'text', text: 'Continua con la tarea solicitada.' }] });
  }
  return { system: out.system, messages: turns };
}

function toolCallChunk(model, toolCalls, finishReason = null) {
  return {
    id: `sira-${Date.now()}`,
    object: 'chat.completion.chunk',
    model: model || '',
    choices: [{ index: 0, delta: toolCalls ? { tool_calls: toolCalls } : {}, finish_reason: finishReason }],
  };
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

  async function createWithTools(client, payload, requestOptions, model) {
    const resolvedModel = model || 'claude-sonnet-4-6';
    const tools = toAnthropicTools(payload.tools);
    const body = {
      model: resolvedModel,
      max_tokens: Number(payload.max_tokens) || 16384,
      ...(tools.length ? { tools } : {}),
    };
    applyAnthropicThinkingControls(body, payload, resolvedModel);
    let toolChoice = tools.length ? toAnthropicToolChoice(payload.tool_choice) : null;
    const forcedName = tools.length ? forcedToolName(payload.tool_choice) : null;
    if (forcedName !== null && forcedToolRejected(resolvedModel, body)) {
      attachToolNudge(Array.isArray(payload.messages) ? payload.messages : [], forcedName);
      toolChoice = { type: 'auto' };
    }
    if (toolChoice) body.tool_choice = toolChoice;
    const transcript = buildToolTranscript(payload.messages, resolvedModel);
    body.messages = transcript.messages;
    if (transcript.system) body.system = transcript.system;
    const hasEffortControls = Boolean(body.thinking || body.output_config);
    const createOptions = { signal: requestOptions && requestOptions.signal };

    if (!payload.stream) {
      let resp;
      try {
        resp = await client.messages.create(body, createOptions);
      } catch (error) {
        if (!hasEffortControls || !isAnthropicEffortParamError(error)) throw error;
        console.warn(`[anthropic] ${resolvedModel}: effort controls rejected (${error.message}); retrying without them`);
        resp = await client.messages.create(withoutEffortControls(body), createOptions);
      }
      const completion = toOpenAICompletion(resp, resolvedModel);
      const message = completion.choices[0].message;
      const thinking = (Array.isArray(resp && resp.content) ? resp.content : [])
        .filter((b) => b && b.type === 'thinking' && b.thinking)
        .map((b) => b.thinking).join('\n');
      if (thinking) message.reasoning_content = thinking;
      rememberNativeContent(message, resp && resp.content, resolvedModel);
      return completion;
    }

    const openStream = async (requestBody) => {
      const stream = client.messages.stream(requestBody);
      if (requestOptions && requestOptions.signal) {
        const abort = () => { try { stream.abort(); } catch { /* closed */ } };
        if (requestOptions.signal.aborted) abort();
        else requestOptions.signal.addEventListener('abort', abort, { once: true });
      }
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      return { iterator, first };
    };
    let opened;
    try {
      opened = await openStream(body);
    } catch (error) {
      if (!hasEffortControls || !isAnthropicEffortParamError(error)) throw error;
      console.warn(`[anthropic] ${resolvedModel}: effort controls rejected (${error.message}); retrying without them`);
      opened = await openStream(withoutEffortControls(body));
    }
    return (async function* anthropicToolStream() {
      const blockToCall = new Map();
      let callIndex = 0;
      let stopReason = null;
      let step = opened.first;
      while (!step.done) {
        const event = step.value;
        if (event && event.type === 'content_block_start' && event.content_block && event.content_block.type === 'tool_use') {
          const index = callIndex++;
          blockToCall.set(event.index, index);
          yield toolCallChunk(resolvedModel, [{
            index,
            id: String(event.content_block.id || `call_${index}`),
            type: 'function',
            function: { name: String(event.content_block.name || ''), arguments: '' },
          }]);
        } else if (event && event.type === 'content_block_delta' && event.delta && event.delta.type === 'input_json_delta') {
          const index = blockToCall.get(event.index);
          if (index !== undefined && event.delta.partial_json) {
            yield toolCallChunk(resolvedModel, [{ index, function: { arguments: String(event.delta.partial_json) } }]);
          }
        } else if (event && event.type === 'message_delta' && event.delta && event.delta.stop_reason) {
          stopReason = event.delta.stop_reason;
        } else {
          const thought = extractAnthropicThinking(event);
          if (thought) yield toOpenAiChunk(thought, { model: resolvedModel, reasoning: true });
          const text = extractAnthropicText(event);
          if (text) yield toOpenAiChunk(text, { model: resolvedModel });
        }
        step = await opened.iterator.next();
      }
      yield toolCallChunk(resolvedModel, null, mapStopReason(stopReason, callIndex > 0));
    }());
  }

  return {
    __siraProvider: 'Anthropic',
    chat: {
      completions: {
        async create(payload = {}, requestOptions = {}) {
          const client = await getSdk();
          const model = stripVendorPrefix(payload.model, ['anthropic/']);
          if (hasToolTraffic(payload)) {
            return createWithTools(client, payload, requestOptions, model);
          }
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
  buildToolTranscript,
};
