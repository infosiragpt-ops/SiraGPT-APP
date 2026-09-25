'use strict';

/**
 * Gemini native adapter — `models/{model}:streamGenerateContent?alt=sse`.
 *
 * - functionDeclarations with an OpenAPI-subset schema (JSON Schema is
 *   down-converted: type unions → nullable, unsupported keywords dropped).
 * - functionCall / functionResponse parts; Gemini 3 `thoughtSignature`s are
 *   kept on the exact part that carried them and replayed on later turns
 *   (required for multi-step function calling on thinking models).
 * - thinkingConfig: Gemini 3 → thinkingLevel low|high, Gemini 2.5 →
 *   thinkingBudget; thought summaries streamed as thinking deltas.
 */

const { readSse, parseSseJson } = require('../sse');
const { postJsonStream } = require('../http');
const { HarnessProviderError } = require('../errors');

const DROP_KEYS = new Set(['$schema', '$id', '$ref', '$defs', 'definitions', 'additionalProperties', 'examples', 'const', 'default', 'patternProperties', 'unevaluatedProperties', 'dependentRequired', 'if', 'then', 'else', 'not', 'allOf', 'contentMediaType', 'contentEncoding']);

function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROP_KEYS.has(key)) continue;
    if (key === 'type' && Array.isArray(value)) {
      const types = value.filter((t) => t !== 'null');
      out.type = types[0] || 'string';
      if (types.length !== value.length) out.nullable = true;
    } else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]));
    } else if (key === 'items') {
      out.items = toGeminiSchema(value);
    } else if (key === 'anyOf' || key === 'oneOf') {
      out.anyOf = (value || []).map(toGeminiSchema);
    } else if (key === 'enum' && Array.isArray(value)) {
      out.enum = value.map(String);
    } else {
      out[key] = value;
    }
  }
  if (out.const !== undefined) delete out.const;
  return out;
}

function geminiThinkingConfig(model, effort = {}) {
  const id = String(model || '').toLowerCase();
  const isThree = /gemini-3/.test(id);
  const isTwoFive = /gemini-2\.5/.test(id);
  if (!isThree && !isTwoFive) return null;
  const level = effort && effort.explicit ? String(effort.level || '').toLowerCase() : '';
  const cfg = { includeThoughts: true };
  if (!level) return cfg;
  if (isThree) {
    cfg.thinkingLevel = level === 'high' || level === 'xhigh' || level === 'max' ? 'high' : 'low';
  } else {
    const budgets = { disabled: 0, low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 24576 };
    if (level in budgets) cfg.thinkingBudget = /pro/.test(id) && level === 'disabled' ? 128 : budgets[level];
  }
  return cfg;
}

function userParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  const parts = [];
  for (const p of content || []) {
    if (!p) continue;
    if (p.type === 'text' && p.text) parts.push({ text: p.text });
    else if (p.type === 'image' && p.data) parts.push({ inlineData: { mimeType: p.mediaType || 'image/png', data: p.data } });
    else if (p.type === 'image' && p.url) parts.push({ fileData: { mimeType: p.mediaType || 'image/png', fileUri: p.url } });
  }
  return parts;
}

function toGeminiContents(messages, model) {
  const contents = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  const namesById = new Map();
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'user') push('user', userParts(m.content));
    else if (m.role === 'assistant') {
      const sameModel = (b) => b.meta && b.meta.origin && b.meta.origin.model === model;
      const parts = [];
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b) continue;
        if (b.type === 'text' && b.text) {
          parts.push({ text: b.text, ...(sameModel(b) && b.meta.thoughtSignature ? { thoughtSignature: b.meta.thoughtSignature } : {}) });
        } else if (b.type === 'tool_call') {
          namesById.set(String(b.id), b.name);
          parts.push({
            functionCall: { name: b.name, args: b.input || {}, ...(b.meta && b.meta.geminiId ? { id: b.meta.geminiId } : {}) },
            ...(sameModel(b) && b.meta.thoughtSignature ? { thoughtSignature: b.meta.thoughtSignature } : {}),
          });
        }
      }
      push('model', parts);
    } else if (m.role === 'tool') {
      const parts = (m.content || []).filter((b) => b && b.type === 'tool_result').map((b) => ({
        functionResponse: {
          name: b.name || namesById.get(String(b.toolCallId)) || 'tool',
          response: b.isError ? { error: String(b.content || '') } : { result: String(b.content == null ? '' : b.content) },
        },
      }));
      push('user', parts);
    }
  }
  return contents;
}

function buildGeminiRequest({ model, system, messages, tools, effort, maxTokens, toolChoice }) {
  const body = { contents: toGeminiContents(messages, model), generationConfig: {} };
  if (system) body.systemInstruction = { parts: [{ text: String(system) }] };
  if (Array.isArray(tools) && tools.length) {
    body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description || '', parameters: toGeminiSchema(t.input_schema || { type: 'object', properties: {} }) })) }];
    body.toolConfig = { functionCallingConfig: { mode: toolChoice === 'none' ? 'NONE' : 'AUTO' } };
  }
  if (Number(maxTokens) > 0) body.generationConfig.maxOutputTokens = Math.trunc(Number(maxTokens));
  const thinking = geminiThinkingConfig(model, effort);
  if (thinking) body.generationConfig.thinkingConfig = thinking;
  return body;
}

const FINISH_MAP = { STOP: 'end_turn', MAX_TOKENS: 'max_tokens', SAFETY: 'refusal', RECITATION: 'refusal', PROHIBITED_CONTENT: 'refusal', BLOCKLIST: 'refusal', SPII: 'refusal', MALFORMED_FUNCTION_CALL: 'malformed_tool_call' };

function createGeminiAdapter({ endpoint, fetchImpl } = {}) {
  const provider = 'Gemini';

  async function streamTurn({ model, system, messages, tools, effort, maxTokens, toolChoice, signal, emit = () => {} }) {
    const apiModel = String(model).replace(/^google\//, '').replace(/^models\//, '');
    const body = buildGeminiRequest({ model, system, messages, tools, effort, maxTokens, toolChoice });
    const res = await postJsonStream(`${endpoint.baseURL}/models/${encodeURIComponent(apiModel)}:streamGenerateContent?alt=sse`, {
      headers: { 'x-goog-api-key': endpoint.apiKey }, body, signal, fetchImpl, provider,
    });
    const origin = { adapter: 'gemini', model };
    const content = [];
    let text = null;
    let thinking = null;
    let finish = null;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let seq = 0;

    for await (const { data } of readSse(res.body)) {
      const chunk = parseSseJson(data);
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.error) {
        const status = Number(chunk.error.code) || null;
        throw new HarnessProviderError(`Gemini stream error: ${chunk.error.message || chunk.error.status}`, { provider, status });
      }
      if (chunk.usageMetadata) {
        usage.inputTokens = chunk.usageMetadata.promptTokenCount || usage.inputTokens;
        usage.outputTokens = (chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0);
        usage.cacheReadTokens = chunk.usageMetadata.cachedContentTokenCount || usage.cacheReadTokens;
      }
      const cand = Array.isArray(chunk.candidates) ? chunk.candidates[0] : null;
      if (!cand) continue;
      for (const part of (cand.content && cand.content.parts) || []) {
        if (part.functionCall) {
          seq += 1;
          const id = part.functionCall.id || `gcall_${Date.now().toString(36)}_${seq}`;
          const block = {
            type: 'tool_call', id, name: part.functionCall.name, input: part.functionCall.args || {},
            meta: { origin, ...(part.functionCall.id ? { geminiId: part.functionCall.id } : {}), ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) },
          };
          content.push(block);
          text = null;
          emit({ type: 'tool_call_start', id, name: block.name });
          emit({ type: 'tool_call_end', id, name: block.name, input: block.input, parseError: null });
        } else if (typeof part.text === 'string') {
          if (part.thought) {
            if (!thinking) { thinking = { type: 'thinking', text: '', origin }; content.push(thinking); }
            thinking.text += part.text;
            if (part.text) emit({ type: 'thinking_delta', text: part.text });
          } else {
            if (!text) { text = { type: 'text', text: '', meta: { origin } }; content.push(text); }
            text.text += part.text;
            if (part.thoughtSignature) text.meta.thoughtSignature = part.thoughtSignature;
            if (part.text) emit({ type: 'text_delta', text: part.text });
          }
        } else if (part.thoughtSignature && text) {
          text.meta.thoughtSignature = part.thoughtSignature;
        }
      }
      if (cand.finishReason) finish = cand.finishReason;
    }
    const cleaned = content.filter((b) => !(b.type === 'text' && !b.text && !(b.meta && b.meta.thoughtSignature)));
    const hasCalls = cleaned.some((b) => b.type === 'tool_call');
    if (finish === 'MALFORMED_FUNCTION_CALL' && !hasCalls) {
      throw new HarnessProviderError('Gemini devolvió una llamada de función mal formada', { provider, code: 'MALFORMED_FUNCTION_CALL', retryable: true });
    }
    return { content: cleaned, stopReason: hasCalls ? 'tool_use' : (FINISH_MAP[finish] || 'end_turn'), usage };
  }

  return { name: 'gemini', provider, streamTurn, appendOnlyHistory: () => false };
}

module.exports = { createGeminiAdapter, buildGeminiRequest, toGeminiContents, toGeminiSchema, geminiThinkingConfig };
