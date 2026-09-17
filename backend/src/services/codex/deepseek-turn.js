'use strict';

/**
 * codex/deepseek-turn — "one model step" driven by DeepSeek V4 through its
 * OpenAI-compatible API with NATIVE function calling (no prompted fences).
 *
 * Same contract as anthropic-turn / llm-turn.defaultLlmTurn: takes
 * provider-safe messages (system/user/assistant strings; tool results are
 * encoded by the loop as `[TOOL_RESULT tool]` user messages) and returns
 * `{ text, reasoning, toolCalls, truncated, usage }`.
 *
 * Why this exists: the product policy is "solo DeepSeek V4 Flash/Pro" (alias
 * Sira Rápido / Sira Pro). Until now only Anthropic had a native tool-use
 * path in codex; every other model — DeepSeek included — fell back to the
 * prompted protocol (tools described in the system prompt, JSON parsed out of
 * fenced blocks). Native `tool_calls` is measurably more reliable for the
 * agent loop (no fence truncation, no JSON-in-prose leaks, arguments arrive
 * as structured objects) and cheaper (no tool catalogue in the prompt).
 *
 * Engine selection lives in llm-turn.resolveTurnEngine: when DEEPSEEK_API_KEY
 * is configured this engine is preferred for every tier (policy), with the
 * tier picking the model (power → Pro, otherwise → Flash). Fully injectable
 * (`createClient`) so tests never touch the network.
 */

const { parsePromptedToolCalls } = require('../agents/prompted-tool-calling');

const DEFAULT_MODEL_FLASH = 'deepseek-v4-flash';
const DEFAULT_MODEL_PRO = 'deepseek-v4-pro';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
// DeepSeek caps chat output well above this; 8K is the cost/latency sweet
// spot for write_file payloads and matches the ladder's OpenAI-compat rungs.
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TIERS = 'eco,standard,power';
const DEFAULT_TEMPERATURE = 0.2;

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isDeepSeekV4Model(model) {
  return model === DEFAULT_MODEL_FLASH || model === DEFAULT_MODEL_PRO;
}

/**
 * Map whatever the composer/run row carries to a DeepSeek model id, or null
 * when the request is not a DeepSeek choice (caller then uses the tier
 * default). Accepts the raw ids, the branded aliases (Sira Rápido / Sira Pro)
 * and OpenRouter-style `deepseek/...` slugs.
 */
function normalizeDeepSeekModel(requested) {
  const raw = clean(requested);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (/^sira[\s_-]*pro$/.test(lower)) return DEFAULT_MODEL_PRO;
  if (/^sira[\s_-]*r[aá]pido$/.test(lower)) return DEFAULT_MODEL_FLASH;
  const slug = lower.startsWith('deepseek/') ? lower.slice('deepseek/'.length) : lower;
  if (!/^deepseek-[a-z0-9._-]+$/.test(slug)) return null;
  if (/v4/.test(slug)) return /pro/.test(slug) ? DEFAULT_MODEL_PRO : DEFAULT_MODEL_FLASH;
  return slug;
}

function getDeepSeekTurnConfig({ env = process.env, tier = null, modelOverride = null } = {}) {
  const apiKey = clean(env.DEEPSEEK_API_KEY);
  const disabled = String(env.CODEX_DEEPSEEK_DISABLED || '') === '1';
  const tiers = String(env.CODEX_DEEPSEEK_TIERS || DEFAULT_TIERS)
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const normalizedTier = String(tier || '').toLowerCase();
  const configuredModel = normalizedTier === 'power'
    ? (clean(env.CODEX_DEEPSEEK_MODEL_POWER) || clean(env.CODEX_DEEPSEEK_MODEL) || DEFAULT_MODEL_PRO)
    : (clean(env.CODEX_DEEPSEEK_MODEL_STANDARD) || clean(env.CODEX_DEEPSEEK_MODEL) || DEFAULT_MODEL_FLASH);
  const model = normalizeDeepSeekModel(modelOverride) || configuredModel;
  const envMax = Number(env.CODEX_DEEPSEEK_MAX_TOKENS);
  const envTemp = Number(env.CODEX_DEEPSEEK_TEMPERATURE);
  return {
    enabled: Boolean(apiKey) && !disabled,
    apiKey,
    baseURL: clean(env.DEEPSEEK_BASE_URL) || DEFAULT_BASE_URL,
    tiers,
    model,
    // A run with an unknown/absent tier is still served (eco semantics): the
    // list only lets ops carve tiers OUT, never strands a run without engine.
    tierEligible: tiers.includes(normalizedTier || 'eco'),
    maxTokens: Number.isFinite(envMax) && envMax > 0 ? Math.floor(envMax) : DEFAULT_MAX_TOKENS,
    temperature: Number.isFinite(envTemp) && envTemp >= 0 && envTemp <= 2 ? envTemp : DEFAULT_TEMPERATURE,
  };
}

/**
 * Thinking controls for V4. `CODEX_DEEPSEEK_THINKING` forces on (1) / off (0);
 * otherwise Pro thinks (it is the "Power" engine) and Flash only thinks on a
 * high-effort request. Non-V4 ids never receive the field (the API 400s).
 */
function resolveThinking({ model, effort = null, env = process.env } = {}) {
  if (!isDeepSeekV4Model(model)) return null;
  const forced = String(env.CODEX_DEEPSEEK_THINKING ?? '').trim();
  const level = String(effort || '').toLowerCase();
  let enabled;
  if (forced === '1') enabled = true;
  else if (forced === '0') enabled = false;
  else enabled = model === DEFAULT_MODEL_PRO || level === 'high';
  if (!enabled) return { thinking: { type: 'disabled' } };
  return {
    thinking: { type: 'enabled' },
    reasoning_effort: level === 'high' ? 'high' : (level === 'low' ? 'low' : 'medium'),
  };
}

/** Registry projection [{name, description, parameters}] → OpenAI tools. */
function toOpenAITools(tools) {
  return (Array.isArray(tools) ? tools : []).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  let dropped = false;
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block) dropped = true;
  }
  // DeepSeek is text-only: a dropped image/document block is announced so the
  // model does not silently assume it saw the attachment.
  if (dropped) parts.push('[Adjunto no textual omitido; usa el texto extraído disponible.]');
  return parts.join('\n');
}

/**
 * Provider-safe transcript → OpenAI-compatible messages. Consecutive
 * same-role messages are merged (the loop emits several `[TOOL_RESULT]` user
 * messages in a row) and a leading user turn is guaranteed — the safe shape
 * for every OpenAI-compatible reasoning endpoint.
 */
function toDeepSeekMessages(messages) {
  const out = [];
  const systemParts = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    const text = textOf(m.content);
    if (m.role === 'system') {
      if (text) systemParts.push(text);
      continue;
    }
    if (!text) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${text}`;
    else out.push({ role, content: text });
  }
  if (out.length === 0 || out[0].role !== 'user') out.unshift({ role: 'user', content: 'Continúa con la tarea.' });
  if (systemParts.length) out.unshift({ role: 'system', content: systemParts.join('\n\n') });
  return out;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return { args: raw, parseError: false };
  const s = clean(raw);
  if (!s) return { args: {}, parseError: false };
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { args: parsed, parseError: false }
      : { args: {}, parseError: true };
  } catch {
    return { args: {}, parseError: true };
  }
}

function normalizeToolCalls(rawCalls, names) {
  const calls = [];
  for (const [index, tc] of (Array.isArray(rawCalls) ? rawCalls : []).entries()) {
    const name = clean(tc?.function?.name || tc?.name);
    if (!name) continue;
    const { args, parseError } = parseArgs(tc?.function?.arguments ?? tc?.arguments);
    const call = { id: clean(tc?.id) || `call_${index + 1}`, name, args };
    if (parseError) call.argsParseError = true;
    if (names && names.size && !names.has(name)) call.unknownTool = true;
    calls.push(call);
  }
  return calls;
}

/**
 * Some weaker checkpoints keep emitting the prompted protocol out of habit
 * even when native tools are offered. When native `tool_calls` came back
 * empty, salvage a fenced ```tool_call block that names a registered tool so
 * the loop does not mistake it for "the model is done".
 */
function salvagePromptedCalls(content, names) {
  if (!names || !names.size || !String(content || '').includes('```')) return { text: content, toolCalls: [] };
  const parsed = parsePromptedToolCalls(content, names);
  const toolCalls = (parsed.toolCalls || []).map((tc) => {
    const { args } = parseArgs(tc.function.arguments);
    return { id: tc.id, name: tc.function.name, args };
  });
  if (!toolCalls.length) return { text: content, toolCalls: [] };
  return { text: String(parsed.cleanedContent || '').trim(), toolCalls };
}

function usageFrom(u, model, generationId) {
  const usage = u && typeof u === 'object' ? u : {};
  const cacheRead = Number(usage.prompt_cache_hit_tokens ?? 0) || 0;
  return {
    tokensIn: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0,
    tokensOut: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: 0,
    cacheHit: cacheRead > 0,
    provider: 'DeepSeek',
    model,
    generationId: generationId || null,
  };
}

function finalize({ content, reasoningText, rawToolCalls, finishReason, names, model, usage, generationId }) {
  let text = String(content || '');
  let toolCalls = normalizeToolCalls(rawToolCalls, names);
  if (toolCalls.length === 0 && names && names.size) {
    const salvaged = salvagePromptedCalls(text, names);
    text = salvaged.text;
    toolCalls = salvaged.toolCalls;
  }
  // `length` with no complete call = the output budget cut a tool call (or a
  // huge narrative) in half. Surface it so the loop nudges a split instead of
  // closing the build with the file never written.
  const truncated = toolCalls.length === 0 && finishReason === 'length';
  return {
    text: text.trim(),
    reasoning: reasoningText ? { label: 'Razonando', text: reasoningText, durationMs: 0 } : null,
    toolCalls,
    truncated,
    usage: usageFrom(usage, model, generationId),
  };
}

function defaultCreateClient({ env = process.env, fetchImpl = null } = {}) {
  // Lazy require keeps config-only callers independent from the SDK.
  // eslint-disable-next-line global-require
  const OpenAI = require('openai');
  const Ctor = OpenAI.default || OpenAI;
  const cfg = getDeepSeekTurnConfig({ env });
  const options = { apiKey: cfg.apiKey, baseURL: cfg.baseURL };
  if (typeof fetchImpl === 'function') options.fetch = fetchImpl;
  return new Ctor(options);
}

/**
 * One DeepSeek step. `tier` picks the model, `effort` the thinking level.
 * Throws on transport/config errors — the caller (llm-turn) decides whether
 * to degrade to another engine.
 */
async function deepseekTurn({
  messages,
  tools = [],
  signal,
  env = process.env,
  tier = null,
  createClient = defaultCreateClient,
  fetchImpl = null,
  temperature = null,
  maxTokens = null,
  onTextDelta = null,
  onReasoningDelta = null,
  model = null,
  effort = null,
} = {}) {
  const cfg = getDeepSeekTurnConfig({ env, tier, modelOverride: model });
  if (!cfg.enabled) throw new Error('codex deepseek-turn: DEEPSEEK_API_KEY no configurada');
  const client = createClient({ env, fetchImpl });
  if (!client?.chat?.completions?.create) throw new Error('codex deepseek-turn: cliente inválido');

  const names = new Set((tools || []).map((t) => t.name));
  const openAITools = toOpenAITools(tools);
  const shouldStream = typeof onTextDelta === 'function' || typeof onReasoningDelta === 'function';
  const request = {
    model: cfg.model,
    messages: toDeepSeekMessages(messages),
    max_tokens: maxTokens || cfg.maxTokens,
    temperature: Number.isFinite(temperature) ? temperature : cfg.temperature,
    ...(openAITools.length ? { tools: openAITools, tool_choice: 'auto' } : {}),
    ...(resolveThinking({ model: cfg.model, effort, env }) || {}),
    ...(shouldStream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };

  const resp = await client.chat.completions.create(request, signal ? { signal } : undefined);

  if (shouldStream && resp && typeof resp[Symbol.asyncIterator] === 'function') {
    let content = '';
    let reasoningText = '';
    let usage = null;
    let generationId = null;
    let finishReason = null;
    const partial = new Map(); // index → { id, function: { name, arguments } }
    let emitted = false;
    try {
      for await (const chunk of resp) {
        generationId = generationId || chunk?.id || null;
        if (chunk?.usage) usage = chunk.usage;
        const choice = chunk?.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
          emitted = true;
          content += delta.content;
          if (typeof onTextDelta === 'function') await onTextDelta(delta.content);
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          emitted = true;
          reasoningText += delta.reasoning_content;
          if (typeof onReasoningDelta === 'function') await onReasoningDelta(delta.reasoning_content);
        }
        for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const index = Number.isInteger(tc?.index) ? tc.index : partial.size;
          const slot = partial.get(index) || { id: null, function: { name: '', arguments: '' } };
          if (tc?.id) slot.id = tc.id;
          if (tc?.function?.name) slot.function.name += tc.function.name;
          if (typeof tc?.function?.arguments === 'string') slot.function.arguments += tc.function.arguments;
          partial.set(index, slot);
        }
      }
    } catch (error) {
      // Once deltas reached the user, a retry on another engine would splice
      // two different answers into one transcript — fail closed instead.
      if (emitted) error.partialResponse = true;
      throw error;
    }
    const rawToolCalls = [...partial.entries()].sort((a, b) => a[0] - b[0]).map(([, slot]) => slot);
    return finalize({ content, reasoningText, rawToolCalls, finishReason, names, model: cfg.model, usage, generationId });
  }

  const choice = resp?.choices?.[0] || {};
  const message = choice.message || {};
  return finalize({
    content: typeof message.content === 'string' ? message.content : '',
    reasoningText: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
    rawToolCalls: message.tool_calls,
    finishReason: choice.finish_reason || null,
    names,
    model: cfg.model,
    usage: resp?.usage,
    generationId: resp?.id || null,
  });
}

module.exports = {
  deepseekTurn,
  getDeepSeekTurnConfig,
  normalizeDeepSeekModel,
  isDeepSeekV4Model,
  resolveThinking,
  toOpenAITools,
  toDeepSeekMessages,
  normalizeToolCalls,
  defaultCreateClient,
  DEFAULT_MODEL_FLASH,
  DEFAULT_MODEL_PRO,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_TOKENS,
};
