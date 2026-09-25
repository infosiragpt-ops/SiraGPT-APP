'use strict';

/**
 * OpenAI Responses API adapter (streaming) for reasoning models (o-series,
 * gpt-5.x). Reasoning effort goes in `reasoning.effort`; with `store:false`
 * the encrypted reasoning items are requested and replayed verbatim before
 * their function calls on later turns, which keeps the model's chain of
 * thought across tool rounds without server-side state.
 */

const { readSse, parseSseJson } = require('../sse');
const { postJsonStream, safeJsonParse } = require('../http');
const { HarnessProviderError } = require('../errors');

function mapEffort(effort = {}) {
  const level = String(effort.level || '').toLowerCase();
  if (!level) return null;
  if (level === 'disabled' || level === 'off' || level === 'minimal') return 'low';
  if (level === 'xhigh' || level === 'max') return 'high';
  return ['low', 'medium', 'high'].includes(level) ? level : null;
}

function userToInput(content) {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  const parts = [];
  for (const part of content || []) {
    if (!part) continue;
    if (part.type === 'text' && part.text) parts.push({ type: 'input_text', text: part.text });
    else if (part.type === 'image') {
      const url = part.data ? `data:${part.mediaType || 'image/png'};base64,${part.data}` : part.url;
      if (url) parts.push({ type: 'input_image', image_url: url });
    }
  }
  return parts;
}

function toResponsesInput(messages, model) {
  const input = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'user') input.push({ role: 'user', content: userToInput(m.content) });
    else if (m.role === 'assistant') {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b) continue;
        if (b.type === 'thinking' && b.origin && b.origin.adapter === 'openai-responses' && b.origin.model === model && b.meta && b.meta.item) {
          input.push(b.meta.item);
        } else if (b.type === 'text' && b.text) {
          input.push({ role: 'assistant', content: [{ type: 'output_text', text: b.text }] });
        } else if (b.type === 'tool_call') {
          input.push({ type: 'function_call', call_id: String(b.id), name: b.name, arguments: JSON.stringify(b.input || {}) });
        }
      }
    } else if (m.role === 'tool') {
      for (const b of m.content || []) {
        if (b && b.type === 'tool_result') input.push({ type: 'function_call_output', call_id: String(b.toolCallId), output: String(b.content == null ? '' : b.content) || '(sin salida)' });
      }
    }
  }
  return input;
}

function buildResponsesRequest({ model, system, messages, tools, effort, maxTokens, toolChoice }) {
  const body = {
    model: String(model).replace(/^openai\//, ''),
    input: toResponsesInput(messages, model),
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: Number(maxTokens) > 0 ? Math.trunc(Number(maxTokens)) : 16_384,
  };
  if (system) body.instructions = String(system);
  const e = mapEffort(effort);
  body.reasoning = { summary: 'auto', ...(e ? { effort: e } : {}) };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } }));
    body.tool_choice = toolChoice === 'none' ? 'none' : 'auto';
  }
  return body;
}

function createOpenAIResponsesAdapter({ endpoint, fetchImpl } = {}) {
  const provider = endpoint.provider;

  async function streamTurn({ model, system, messages, tools, effort, maxTokens, toolChoice, signal, emit = () => {} }) {
    const body = buildResponsesRequest({ model, system, messages, tools, effort, maxTokens, toolChoice });
    const res = await postJsonStream(`${endpoint.baseURL}/responses`, {
      headers: { authorization: `Bearer ${endpoint.apiKey}` }, body, signal, fetchImpl, provider,
    });
    const origin = { adapter: 'openai-responses', model };
    const content = [];
    const byItem = new Map();
    let text = null;
    let status = null;
    let incomplete = null;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    for await (const { data } of readSse(res.body)) {
      const ev = parseSseJson(data);
      if (!ev || typeof ev !== 'object') continue;
      switch (ev.type) {
        case 'response.output_item.added': {
          const item = ev.item || {};
          if (item.type === 'function_call') {
            const block = { type: 'tool_call', id: item.call_id || item.id, name: item.name, input: {}, _json: item.arguments || '' };
            byItem.set(item.id, block);
            content.push(block);
            emit({ type: 'tool_call_start', id: block.id, name: block.name });
          } else if (item.type === 'reasoning') {
            const block = { type: 'thinking', text: '', origin, meta: { item: null } };
            byItem.set(item.id, block);
            content.push(block);
          } else if (item.type === 'message') {
            text = { type: 'text', text: '' };
            byItem.set(item.id, text);
            content.push(text);
          }
          break;
        }
        case 'response.output_text.delta': {
          let block = byItem.get(ev.item_id);
          if (!block) { block = { type: 'text', text: '' }; byItem.set(ev.item_id, block); content.push(block); }
          block.text += ev.delta || '';
          if (ev.delta) emit({ type: 'text_delta', text: ev.delta });
          break;
        }
        case 'response.reasoning_summary_text.delta': {
          const block = byItem.get(ev.item_id);
          if (block) block.text += ev.delta || '';
          if (ev.delta) emit({ type: 'thinking_delta', text: ev.delta });
          break;
        }
        case 'response.function_call_arguments.delta': {
          const block = byItem.get(ev.item_id);
          if (block) block._json += ev.delta || '';
          if (ev.delta && block) emit({ type: 'tool_input_delta', id: block.id, partial: ev.delta });
          break;
        }
        case 'response.output_item.done': {
          const item = ev.item || {};
          const block = byItem.get(item.id);
          if (!block) break;
          if (item.type === 'function_call') {
            const parsed = safeJsonParse(item.arguments != null ? item.arguments : block._json);
            if (parsed.error) block.parseError = parsed.error; else block.input = parsed.value || {};
            delete block._json;
            emit({ type: 'tool_call_end', id: block.id, name: block.name, input: block.input, parseError: block.parseError || null });
          } else if (item.type === 'reasoning') {
            block.meta.item = { type: 'reasoning', id: item.id, summary: item.summary || [], ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}) };
          }
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          const r = ev.response || {};
          status = r.status || (ev.type === 'response.completed' ? 'completed' : 'incomplete');
          incomplete = r.incomplete_details || null;
          const u = r.usage || {};
          usage.inputTokens = u.input_tokens || 0;
          usage.outputTokens = u.output_tokens || 0;
          usage.cacheReadTokens = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
          break;
        }
        case 'response.failed':
        case 'error': {
          const e = (ev.response && ev.response.error) || ev.error || ev;
          throw new HarnessProviderError(`${provider} Responses error: ${e.message || e.code || 'error'}`, { provider, code: e.code || null, retryable: /server_error|rate_limit/.test(String(e.code || '')) });
        }
        default:
          break;
      }
    }
    for (const block of content) {
      if (block.type === 'tool_call' && '_json' in block) {
        const parsed = safeJsonParse(block._json);
        if (parsed.error) block.parseError = parsed.error; else block.input = parsed.value || {};
        delete block._json;
      }
    }
    const cleaned = content.filter((b) => !(b.type === 'text' && !b.text) && !(b.type === 'thinking' && !b.text && !(b.meta && b.meta.item)));
    const hasCalls = cleaned.some((b) => b.type === 'tool_call');
    let stopReason = hasCalls ? 'tool_use' : 'end_turn';
    if (status === 'incomplete' && incomplete && incomplete.reason === 'max_output_tokens') stopReason = hasCalls ? 'tool_use' : 'max_tokens';
    if (status === 'incomplete' && incomplete && incomplete.reason === 'content_filter') stopReason = 'refusal';
    return { content: cleaned, stopReason, usage };
  }

  return { name: 'openai-responses', provider, streamTurn, appendOnlyHistory: () => false };
}

module.exports = { createOpenAIResponsesAdapter, buildResponsesRequest, toResponsesInput };
