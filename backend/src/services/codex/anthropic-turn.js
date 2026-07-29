'use strict';

/**
 * codex/anthropic-turn — "one model step" driven by Claude via the official
 * @anthropic-ai/sdk with NATIVE tool use (no prompted fences). Same contract
 * as llm-turn.defaultLlmTurn: takes provider-safe messages (system/user/
 * assistant strings, tool results encoded as `[TOOL_RESULT tool]` user
 * messages) and returns `{ text, reasoning, toolCalls, usage }`.
 *
 * Engine selection lives in llm-turn.resolveTurnEngine: the run tier chosen in
 * the composer's Power selector maps to a Claude model here (standard → Haiku,
 * power → Sonnet), so paid tiers get Claude-quality agentic builds while Eco
 * stays on the free Cerebras path. Fully injectable (`createClient`) so tests
 * never touch the network.
 */

const DEFAULT_MODEL_POWER = 'claude-sonnet-4-6';
const DEFAULT_MODEL_STANDARD = 'claude-haiku-4-5-20251001';
// 4096 truncated large write_file calls (a realistic seed.ts + narrative
// exceeds it → tool_use arrives without `content`, cycle-16 finding). Sonnet
// supports far more output; 16K is the cost/latency sweet spot here.
const DEFAULT_MAX_TOKENS = 16384;
const CACHE_CONTROL_EPHEMERAL = Object.freeze({ type: 'ephemeral' });

function getAnthropicTurnConfig({ env = process.env, tier = null, modelOverride = null } = {}) {
  const apiKey = String(env.ANTHROPIC_API_KEY || '').trim();
  const disabled = String(env.CODEX_ANTHROPIC_DISABLED || '') === '1';
  const tiers = String(env.CODEX_ANTHROPIC_TIERS || 'standard,power')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const configuredModel = tier === 'power'
    ? (env.CODEX_ANTHROPIC_MODEL_POWER || env.CODEX_ANTHROPIC_MODEL || DEFAULT_MODEL_POWER)
    : (env.CODEX_ANTHROPIC_MODEL_STANDARD || env.CODEX_ANTHROPIC_MODEL || DEFAULT_MODEL_STANDARD);
  const requestedModel = String(modelOverride || '').trim();
  const model = /^claude-[a-z0-9._-]+$/i.test(requestedModel) ? requestedModel : configuredModel;
  return {
    enabled: Boolean(apiKey) && !disabled,
    apiKey,
    tiers,
    model,
    tierEligible: tiers.includes(String(tier || '').toLowerCase()),
  };
}

/**
 * Split the loop transcript into Anthropic's shape: system string + strictly
 * alternating user/assistant turns (consecutive same-role messages are merged
 * — the loop emits several `[TOOL_RESULT]` user messages in a row).
 */
function toAnthropicMessages(messages) {
  const systemParts = [];
  const turns = [];
  const toAnthropicBlock = (block) => {
    if (!block || typeof block !== 'object') return null;
    if (block.type === 'text' && typeof block.text === 'string') return { ...block };
    if (block.type === 'image' || block.type === 'document') return { ...block };
    if (block.type !== 'image_url') return null;
    const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
    const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(url || ''));
    if (!match) return null;
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: match[1],
        data: match[2].replace(/\s/g, ''),
      },
    };
  };
  const asBlocks = (content) => {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    if (!Array.isArray(content)) return [];
    return content.map(toAnthropicBlock).filter(Boolean);
  };
  for (const m of Array.isArray(messages) ? messages : []) {
    const content = m?.content;
    if (m.role === 'system') {
      const text = asBlocks(content)
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (text) systemParts.push(text);
      continue;
    }
    const blocks = asBlocks(content);
    if (!blocks.length) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      if (typeof last.content === 'string' && typeof content === 'string') {
        last.content = `${last.content}\n\n${content}`;
      } else {
        const previous = asBlocks(last.content);
        last.content = [...previous, { type: 'text', text: '\n\n' }, ...blocks];
      }
    } else {
      turns.push({
        role,
        content: typeof content === 'string' ? content : blocks,
      });
    }
  }
  if (turns.length === 0 || turns[0].role !== 'user') {
    turns.unshift({ role: 'user', content: 'Continúa con la tarea.' });
  }
  return { system: systemParts.join('\n\n'), turns };
}

/** Registry projection [{name, description, parameters}] → Anthropic tools. */
function toAnthropicTools(tools) {
  return (Array.isArray(tools) ? tools : []).map((t) => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.parameters || { type: 'object', properties: {} },
  }));
}

function addCacheBreakpoint(content) {
  if (typeof content === 'string' && content) {
    return [{
      type: 'text',
      text: content,
      cache_control: { ...CACHE_CONTROL_EPHEMERAL },
    }];
  }
  if (!Array.isArray(content)) return content;

  const blocks = content.map((block) => (
    block && typeof block === 'object' ? { ...block } : block
  ));
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
      blocks[i] = { ...block, cache_control: { ...CACHE_CONTROL_EPHEMERAL } };
      return blocks;
    }
  }
  return blocks;
}

/**
 * Cache every completed turn while leaving the current tail outside the
 * breakpoint. On the next model step that tail becomes part of the stable
 * prefix, so cache hits grow with the transcript without freezing new input.
 */
function cacheStableTranscriptPrefix(turns) {
  const cached = (Array.isArray(turns) ? turns : []).map((turn) => ({
    ...turn,
    content: Array.isArray(turn?.content)
      ? turn.content.map((block) => (
        block && typeof block === 'object' ? { ...block } : block
      ))
      : turn?.content,
  }));
  if (cached.length < 2) return cached;

  const stableTail = cached.length - 2;
  cached[stableTail] = {
    ...cached[stableTail],
    content: addCacheBreakpoint(cached[stableTail].content),
  };
  return cached;
}

/** Prompt caching on/off. Default ON — cache_control is GA in @anthropic-ai/sdk
 * >=0.20 (no beta header needed). Two env kill-switches degrade to the plain
 * (uncached) request shape: CODEX_PROMPT_CACHE=0 (engine-wide flag, also
 * honoured by llm-provider's Anthropic rung) or the original
 * CODEX_ANTHROPIC_CACHE=0 (kept for back-compat with existing deploys). */
function cacheEnabled(env = process.env) {
  if (String(env.CODEX_PROMPT_CACHE ?? '1') === '0') return false;
  return String(env.CODEX_ANTHROPIC_CACHE ?? '1') !== '0';
}

function defaultCreateClient({ env = process.env, fetchImpl = null } = {}) {
  // Lazy require keeps config-only callers independent from the SDK.
  const Anthropic = require('@anthropic-ai/sdk');
  const Ctor = Anthropic.default || Anthropic;
  const options = {
    apiKey: String(env.ANTHROPIC_API_KEY || '').trim(),
  };
  const baseURL = String(env.ANTHROPIC_BASE_URL || '').trim();
  if (baseURL) options.baseURL = baseURL;
  if (typeof fetchImpl === 'function') options.fetch = fetchImpl;
  // The SDK supplies x-api-key, content-type and anthropic-version. Prompt
  // caching is GA, so adding the retired prompt-caching beta header here would
  // make the request less portable instead of more correct.
  return new Ctor(options);
}

function parseResponse(resp, model) {
  const blocks = Array.isArray(resp?.content) ? resp.content : [];
  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') textParts.push(b.text);
    else if (b.type === 'thinking' && typeof b.thinking === 'string') reasoningParts.push(b.thinking);
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id || null, name: b.name, args: b.input && typeof b.input === 'object' ? b.input : {} });
  }
  const u = resp?.usage || {};
  const cacheCreation = u.cache_creation && typeof u.cache_creation === 'object'
    ? u.cache_creation
    : {};
  const cacheReadTokens = Number(u.cache_read_input_tokens ?? 0) || 0;
  const cacheCreationTokens = Number(u.cache_creation_input_tokens ?? 0) || 0;
  return {
    text: textParts.join('\n').trim(),
    reasoning: reasoningParts.length
      ? { label: 'Razonando', text: reasoningParts.join('\n'), durationMs: 0 }
      : null,
    toolCalls,
    usage: {
      tokensIn: Number(u.input_tokens ?? 0) || 0,
      tokensOut: Number(u.output_tokens ?? 0) || 0,
      cacheReadTokens,
      cacheCreationTokens,
      cacheCreation5mTokens: Number(cacheCreation.ephemeral_5m_input_tokens ?? 0) || 0,
      cacheCreation1hTokens: Number(cacheCreation.ephemeral_1h_input_tokens ?? 0) || 0,
      cacheHit: cacheReadTokens > 0,
      provider: 'Anthropic',
      model,
      generationId: resp?.id || null,
    },
  };
}

/**
 * One Claude step. Same signature family as defaultLlmTurn; `tier` picks the
 * model. Throws on transport/config errors — the caller (llm-turn) decides
 * whether to fall back to the Cerebras path.
 */
async function anthropicTurn({
  messages,
  tools = [],
  signal,
  env = process.env,
  tier = null,
  createClient = defaultCreateClient,
  fetchImpl = null,
  maxTokens = null,
  onTextDelta = null,
  onReasoningDelta = null,
  model = null,
  effort = null,
} = {}) {
  const envMax = Number(env.CODEX_ANTHROPIC_MAX_TOKENS);
  const effectiveMaxTokens = maxTokens || (Number.isFinite(envMax) && envMax > 0 ? Math.floor(envMax) : DEFAULT_MAX_TOKENS);
  const cfg = getAnthropicTurnConfig({ env, tier, modelOverride: model });
  if (!cfg.enabled) throw new Error('codex anthropic-turn: ANTHROPIC_API_KEY no configurada');
  const client = createClient({ env, fetchImpl });
  if (!client?.messages?.create) throw new Error('codex anthropic-turn: cliente inválido');

  const { system, turns } = toAnthropicMessages(messages);
  const useCache = cacheEnabled(env);
  const req = {
    model: cfg.model,
    max_tokens: effectiveMaxTokens,
    messages: useCache ? cacheStableTranscriptPrefix(turns) : turns,
  };
  if (['low', 'medium', 'high'].includes(String(effort || '').toLowerCase())) {
    req.output_config = { effort: String(effort).toLowerCase() };
  }
  // Prompt caching: mark system, tools and the completed transcript prefix.
  // With up to 24 steps per run that stable context would otherwise be
  // re-processed as full input on every step.
  if (system) {
    req.system = useCache
      ? [{ type: 'text', text: system, cache_control: { ...CACHE_CONTROL_EPHEMERAL } }]
      : system;
  }
  const anthropicTools = toAnthropicTools(tools);
  if (anthropicTools.length) {
    if (useCache) {
      // Mark the LAST tool: a cache breakpoint caches everything up to and
      // including it — the whole (large, stable) tool definition block.
      const last = anthropicTools.length - 1;
      anthropicTools[last] = { ...anthropicTools[last], cache_control: { ...CACHE_CONTROL_EPHEMERAL } };
    }
    req.tools = anthropicTools;
  }

  let resp;
  const shouldStream = typeof onTextDelta === 'function' || typeof onReasoningDelta === 'function';
  if (shouldStream && typeof client.messages.stream === 'function') {
    const stream = client.messages.stream(req, signal ? { signal } : undefined);
    let pending = Promise.resolve();
    const enqueue = (callback, value) => {
      if (typeof callback !== 'function' || !value) return;
      pending = pending.then(() => Promise.resolve(callback(value))).catch(() => {});
    };
    stream.on('text', (delta) => enqueue(onTextDelta, delta));
    stream.on('thinking', (delta) => enqueue(onReasoningDelta, delta));
    resp = await stream.finalMessage();
    await pending;
  } else {
    resp = await client.messages.create(req, signal ? { signal } : undefined);
  }
  return parseResponse(resp, cfg.model);
}

module.exports = {
  anthropicTurn,
  getAnthropicTurnConfig,
  toAnthropicMessages,
  toAnthropicTools,
  cacheStableTranscriptPrefix,
  cacheEnabled,
  defaultCreateClient,
  parseResponse,
  DEFAULT_MODEL_POWER,
  DEFAULT_MODEL_STANDARD,
};
