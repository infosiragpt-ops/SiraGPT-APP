'use strict';

/**
 * Anthropic Messages API adapter (streaming, raw fetch).
 *
 * - tool_use / tool_result blocks, parallel tool calls in one turn.
 * - Thinking: controls resolved per model family by
 *   providers/anthropic-effort.js (adaptive + output_config.effort on
 *   Fable/Opus/Sonnet 4.6+, budget_tokens on Haiku 4.5). Thinking and
 *   redacted_thinking blocks — with their signatures — are replayed
 *   VERBATIM on later turns of the same model (required across tool turns)
 *   and dropped for any other model.
 * - Prompt caching: `cache_control` on the system prefix (covers tools +
 *   system) and on the newest message block (incremental loop caching).
 * - Never sends temperature/top_p (400 on 4.7+/5.x) nor forced tool_choice
 *   (400 on Fable 5.1 / Opus 5.5).
 */

const { readSse, parseSseJson } = require('../sse');
const { postJsonStream, safeJsonParse } = require('../http');
const { HarnessProviderError } = require('../errors');
const {
  resolveAnthropicEffortControls,
  anthropicThinkingFamily,
  normalizeAnthropicModel,
} = require('../../providers/anthropic-effort');

const ANTHROPIC_VERSION = '2023-06-01';

function sanitizeToolId(id) {
  const clean = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean || `toolu_${Math.random().toString(36).slice(2, 12)}`;
}

function userPartsToAnthropic(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const out = [];
  for (const part of content || []) {
    if (!part) continue;
    if (part.type === 'text' && part.text) out.push({ type: 'text', text: part.text });
    else if (part.type === 'image') {
      if (part.data) out.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType || 'image/png', data: part.data } });
      else if (part.url) out.push({ type: 'image', source: { type: 'url', url: part.url } });
    }
  }
  return out;
}

function assistantToAnthropic(content, model) {
  const out = [];
  for (const block of content || []) {
    if (!block) continue;
    if (block.type === 'text') {
      if (block.text) out.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      const sameModel = block.origin && block.origin.adapter === 'anthropic' && block.origin.model === model;
      if (!sameModel) continue;
      if (block.redacted) out.push({ type: 'redacted_thinking', data: block.data });
      else if (block.signature) out.push({ type: 'thinking', thinking: block.text || '', signature: block.signature });
    } else if (block.type === 'tool_call') {
      out.push({ type: 'tool_use', id: sanitizeToolId(block.id), name: block.name, input: block.input && typeof block.input === 'object' ? block.input : {} });
    }
  }
  return out;
}

function toAnthropicMessages(messages, model) {
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'user') push('user', userPartsToAnthropic(m.content));
    else if (m.role === 'assistant') push('assistant', assistantToAnthropic(m.content, model));
    else if (m.role === 'tool') {
      push('user', (m.content || []).filter((b) => b && b.type === 'tool_result').map((b) => ({
        type: 'tool_result',
        tool_use_id: sanitizeToolId(b.toolCallId),
        content: String(b.content == null ? '' : b.content) || '(sin salida)',
        ...(b.isError ? { is_error: true } : {}),
      })));
    }
  }
  return out;
}

function addMessageCacheBreakpoint(messages) {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content) || !last.content.length) return;
  const block = last.content[last.content.length - 1];
  if (block && block.type !== 'thinking' && block.type !== 'redacted_thinking') block.cache_control = { type: 'ephemeral' };
}

function buildAnthropicRequest({ model, system, messages, tools, effort = {}, maxTokens, toolChoice, promptCaching = true }) {
  const apiModel = normalizeAnthropicModel(model);
  const body = {
    model: apiModel,
    max_tokens: Number(maxTokens) > 0 ? Math.trunc(Number(maxTokens)) : 16_384,
    messages: toAnthropicMessages(messages, model),
    stream: true,
  };
  if (system) {
    body.system = [{ type: 'text', text: String(system), ...(promptCaching ? { cache_control: { type: 'ephemeral' } } : {}) }];
  }
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: t.input_schema || { type: 'object', properties: {} } }));
    if (!system && promptCaching) body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' };
    if (toolChoice === 'none') body.tool_choice = { type: 'none' };
  }
  if (promptCaching) addMessageCacheBreakpoint(body.messages);
  const controls = resolveAnthropicEffortControls({
    model: apiModel,
    level: effort.level || null,
    explicit: Boolean(effort.explicit && effort.level),
    maxTokens: body.max_tokens,
  });
  if (controls.thinking) body.thinking = controls.thinking;
  if (controls.output_config) body.output_config = controls.output_config;
  if (controls.max_tokens) body.max_tokens = controls.max_tokens;
  return body;
}

const STOP_MAP = { end_turn: 'end_turn', stop_sequence: 'end_turn', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal', pause_turn: 'pause_turn', model_context_window_exceeded: 'max_tokens' };

function createAnthropicAdapter({ endpoint, fetchImpl } = {}) {
  const provider = 'Anthropic';

  async function streamTurn({ model, system, messages, tools, effort, maxTokens, toolChoice, signal, emit = () => {} }) {
    const body = buildAnthropicRequest({ model, system, messages, tools, effort, maxTokens, toolChoice });
    const res = await postJsonStream(`${endpoint.baseURL}/v1/messages`, {
      headers: { 'x-api-key': endpoint.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body,
      signal,
      fetchImpl,
      provider,
    });

    const blocks = [];
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let stopReason = null;
    const origin = { adapter: 'anthropic', model };

    for await (const { data } of readSse(res.body)) {
      const ev = parseSseJson(data);
      if (!ev || typeof ev !== 'object') continue;
      switch (ev.type) {
        case 'message_start': {
          const u = (ev.message && ev.message.usage) || {};
          usage.inputTokens = u.input_tokens || 0;
          usage.cacheReadTokens = u.cache_read_input_tokens || 0;
          usage.cacheWriteTokens = u.cache_creation_input_tokens || 0;
          usage.outputTokens = u.output_tokens || 0;
          break;
        }
        case 'content_block_start': {
          const cb = ev.content_block || {};
          let block;
          if (cb.type === 'text') block = { type: 'text', text: cb.text || '' };
          else if (cb.type === 'thinking') block = { type: 'thinking', text: cb.thinking || '', signature: cb.signature || '', origin };
          else if (cb.type === 'redacted_thinking') block = { type: 'thinking', redacted: true, data: cb.data, text: '', origin };
          else if (cb.type === 'tool_use') {
            block = { type: 'tool_call', id: cb.id, name: cb.name, input: {}, _json: '' };
            emit({ type: 'tool_call_start', id: cb.id, name: cb.name });
          } else block = { type: 'unknown', raw: cb };
          blocks[ev.index] = block;
          break;
        }
        case 'content_block_delta': {
          const block = blocks[ev.index];
          const d = ev.delta || {};
          if (!block) break;
          if (d.type === 'text_delta' && d.text) {
            block.text += d.text;
            emit({ type: 'text_delta', text: d.text });
          } else if (d.type === 'thinking_delta' && d.thinking) {
            block.text += d.thinking;
            emit({ type: 'thinking_delta', text: d.thinking });
          } else if (d.type === 'signature_delta') {
            block.signature = (block.signature || '') + (d.signature || '');
          } else if (d.type === 'input_json_delta') {
            block._json += d.partial_json || '';
            if (d.partial_json) emit({ type: 'tool_input_delta', id: block.id, partial: d.partial_json });
          }
          break;
        }
        case 'content_block_stop': {
          const block = blocks[ev.index];
          if (block && block.type === 'tool_call') {
            const parsed = safeJsonParse(block._json);
            if (parsed.error) block.parseError = parsed.error;
            else block.input = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
            delete block._json;
            emit({ type: 'tool_call_end', id: block.id, name: block.name, input: block.input, parseError: block.parseError || null });
          }
          break;
        }
        case 'message_delta': {
          if (ev.delta && ev.delta.stop_reason) stopReason = STOP_MAP[ev.delta.stop_reason] || ev.delta.stop_reason;
          if (ev.usage && ev.usage.output_tokens != null) usage.outputTokens = ev.usage.output_tokens;
          break;
        }
        case 'error': {
          const e = ev.error || {};
          const overloaded = e.type === 'overloaded_error' || e.type === 'rate_limit_error' || e.type === 'api_error';
          throw new HarnessProviderError(`Anthropic stream error: ${e.type || 'error'}: ${e.message || ''}`.trim(), {
            provider, status: e.type === 'overloaded_error' ? 529 : null, retryable: overloaded, code: e.type || null,
          });
        }
        default:
          break;
      }
    }

    // A tool_use block cut by max_tokens never got its stop event.
    for (const block of blocks) {
      if (block && block.type === 'tool_call' && '_json' in block) {
        const parsed = safeJsonParse(block._json);
        if (parsed.error) block.parseError = `entrada incompleta (${parsed.error})`;
        else block.input = parsed.value || {};
        delete block._json;
      }
    }
    const content = blocks.filter((b) => b && b.type !== 'unknown' && !(b.type === 'text' && !b.text));
    return { content, stopReason: stopReason || 'end_turn', usage };
  }

  return {
    name: 'anthropic',
    provider,
    streamTurn,
    /** Preserved thinking (Fable 5.x, Mythos, Opus 5.5) rejects edited history. */
    appendOnlyHistory: (model) => anthropicThinkingFamily(model) === 'always_on',
  };
}

module.exports = { createAnthropicAdapter, buildAnthropicRequest, toAnthropicMessages };
