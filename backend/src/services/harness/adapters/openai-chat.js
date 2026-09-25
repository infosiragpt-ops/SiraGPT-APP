'use strict';

/**
 * OpenAI Chat Completions adapter (streaming) — the transport for every
 * OpenAI-compatible provider we route: xAI Grok, DeepSeek (Sira Rápido /
 * Pro), Meta Muse Spark, OpenRouter, Cerebras, Groq, Mistral, Kimi, Z.ai
 * and OpenAI's non-reasoning models.
 *
 * Provider quirks are NOT re-implemented here: the payload goes through
 * litellm-gateway `buildProviderChatPayload`, the same builder the chat
 * uses, which already knows `reasoning_effort` (mandatory on Muse Spark,
 * DeepSeek V4 thinking on/off, grok-3-mini only, OpenAI reasoning
 * models), OpenRouter's `reasoning` object, `max_completion_tokens`, and
 * DeepSeek's rule that assistant tool-call turns carry `reasoning_content`.
 */

const { readSse, parseSseJson } = require('../sse');
const { postJsonStream, safeJsonParse } = require('../http');
const { HarnessProviderError } = require('../errors');
const { buildProviderChatPayload } = require('../../ai-product-os/litellm-gateway');

function userContentToOpenAI(content) {
  if (typeof content === 'string') return content;
  const parts = [];
  for (const part of content || []) {
    if (!part) continue;
    if (part.type === 'text' && part.text) parts.push({ type: 'text', text: part.text });
    else if (part.type === 'image') {
      const url = part.data ? `data:${part.mediaType || 'image/png'};base64,${part.data}` : part.url;
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => p.text).join('\n\n');
  return parts;
}

function toOpenAIChatMessages({ system, messages, model, adapterName = 'openai-chat' }) {
  const out = [];
  if (system) out.push({ role: 'system', content: String(system) });
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'user') {
      out.push({ role: 'user', content: userContentToOpenAI(m.content) });
    } else if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
      const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
      const toolCalls = blocks.filter((b) => b && b.type === 'tool_call').map((b) => ({
        id: String(b.id),
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input && typeof b.input === 'object' ? b.input : {}) },
      }));
      const msg = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      const own = blocks.filter((b) => b && b.type === 'thinking' && b.origin && b.origin.adapter === adapterName && b.origin.model === model);
      if (own.length) {
        const reasoning = own.map((b) => b.text || '').join('');
        msg.reasoning_content = reasoning;
        const details = own.flatMap((b) => (b.meta && Array.isArray(b.meta.reasoningDetails) ? b.meta.reasoningDetails : []));
        if (details.length) msg.reasoning_details = details;
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      for (const b of m.content || []) {
        if (!b || b.type !== 'tool_result') continue;
        out.push({ role: 'tool', tool_call_id: String(b.toolCallId), content: String(b.content == null ? '' : b.content) || '(sin salida)' });
      }
    }
  }
  return out;
}

function toOpenAITools(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
  }));
}

const STREAM_USAGE_PROVIDERS = new Set(['xAI', 'DeepSeek']);

function buildOpenAIChatRequest({ provider, model, system, messages, tools, effort = {}, maxTokens, toolChoice }) {
  const oaTools = toOpenAITools(tools);
  const built = buildProviderChatPayload({
    provider,
    model,
    messages: toOpenAIChatMessages({ system, messages, model }),
    stream: true,
    tools: oaTools,
    toolChoice: oaTools.length ? (toolChoice === 'none' ? 'none' : 'auto') : undefined,
    maxOutputTokens: Number(maxTokens) > 0 ? Math.trunc(Number(maxTokens)) : 8_192,
    thinkingLevel: effort.level || null,
    thinkingLevelExplicit: Boolean(effort.explicit && effort.level),
  });
  const payload = built.payload;
  // xAI and DeepSeek stream token usage only when asked; the gateway profile
  // leaves it off for them, the harness needs it for budgets and telemetry.
  if (STREAM_USAGE_PROVIDERS.has(provider) && !payload.stream_options) payload.stream_options = { include_usage: true };
  return payload;
}

const FINISH_MAP = { stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

function createOpenAIChatAdapter({ endpoint, fetchImpl, name = 'openai-chat' } = {}) {
  const provider = endpoint.provider;

  async function streamTurn({ model, system, messages, tools, effort, maxTokens, toolChoice, signal, emit = () => {}, bodyOverride = null }) {
    const body = bodyOverride || buildOpenAIChatRequest({ provider, model, system, messages, tools, effort, maxTokens, toolChoice });
    const headers = { authorization: `Bearer ${endpoint.apiKey}` };
    if (provider === 'OpenRouter') {
      headers['http-referer'] = 'https://siragpt.com';
      headers['x-title'] = 'SiraGPT';
    }
    const res = await postJsonStream(`${endpoint.baseURL}/chat/completions`, { headers, body, signal, fetchImpl, provider });

    let text = '';
    let reasoning = '';
    const reasoningDetails = [];
    const calls = new Map(); // index → { id, name, args }
    let finish = null;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let callSeq = 0;

    for await (const { data } of readSse(res.body)) {
      const chunk = parseSseJson(data);
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.error) {
        const e = chunk.error;
        const status = Number(e.code) || Number(e.status) || null;
        throw new HarnessProviderError(`${provider} stream error: ${e.message || JSON.stringify(e)}`, { provider, status, retryable: status ? undefined : true });
      }
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens || usage.inputTokens;
        usage.outputTokens = chunk.usage.completion_tokens || usage.outputTokens;
        const details = chunk.usage.prompt_tokens_details || {};
        usage.cacheReadTokens = details.cached_tokens || chunk.usage.prompt_cache_hit_tokens || usage.cacheReadTokens;
      }
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      if (!choice) continue;
      const d = choice.delta || choice.message || {};
      const r = typeof d.reasoning_content === 'string' ? d.reasoning_content : (typeof d.reasoning === 'string' ? d.reasoning : '');
      if (r) {
        reasoning += r;
        emit({ type: 'thinking_delta', text: r });
      }
      if (Array.isArray(d.reasoning_details)) reasoningDetails.push(...d.reasoning_details);
      if (typeof d.content === 'string' && d.content) {
        text += d.content;
        emit({ type: 'text_delta', text: d.content });
      }
      if (Array.isArray(d.tool_calls)) {
        d.tool_calls.forEach((tc, pos) => {
          const index = Number.isInteger(tc.index) ? tc.index : pos;
          let call = calls.get(index);
          if (!call) {
            callSeq += 1;
            call = { id: tc.id || `call_${Date.now().toString(36)}_${callSeq}`, name: '', args: '', started: false };
            calls.set(index, call);
          }
          if (tc.id && !call.started) call.id = tc.id;
          const fn = tc.function || {};
          if (fn.name) call.name = call.name ? call.name : fn.name;
          if (!call.started && call.name) {
            call.started = true;
            emit({ type: 'tool_call_start', id: call.id, name: call.name });
          }
          if (typeof fn.arguments === 'string' && fn.arguments) {
            call.args += fn.arguments;
            emit({ type: 'tool_input_delta', id: call.id, partial: fn.arguments });
          } else if (fn.arguments && typeof fn.arguments === 'object') {
            call.args = JSON.stringify(fn.arguments);
          }
        });
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const content = [];
    const origin = { adapter: name, model };
    if (reasoning || reasoningDetails.length) {
      content.push({ type: 'thinking', text: reasoning, origin, ...(reasoningDetails.length ? { meta: { reasoningDetails } } : {}) });
    }
    if (text) content.push({ type: 'text', text });
    const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    for (const call of ordered) {
      if (!call.name) continue;
      const parsed = safeJsonParse(call.args);
      const block = { type: 'tool_call', id: call.id, name: call.name, input: {} };
      if (parsed.error) block.parseError = parsed.error;
      else block.input = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value : {};
      if (!call.started) emit({ type: 'tool_call_start', id: call.id, name: call.name });
      emit({ type: 'tool_call_end', id: block.id, name: block.name, input: block.input, parseError: block.parseError || null });
      content.push(block);
    }
    const hasCalls = content.some((b) => b.type === 'tool_call');
    const stopReason = hasCalls && finish !== 'length' ? 'tool_use' : (FINISH_MAP[finish] || 'end_turn');
    return { content, stopReason, usage };
  }

  return { name, provider, streamTurn, appendOnlyHistory: () => false };
}

module.exports = { createOpenAIChatAdapter, buildOpenAIChatRequest, toOpenAIChatMessages, toOpenAITools };
