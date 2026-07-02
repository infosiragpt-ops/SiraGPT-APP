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
const DEFAULT_MAX_TOKENS = 4096;

function getAnthropicTurnConfig({ env = process.env, tier = null } = {}) {
  const apiKey = String(env.ANTHROPIC_API_KEY || '').trim();
  const disabled = String(env.CODEX_ANTHROPIC_DISABLED || '') === '1';
  const tiers = String(env.CODEX_ANTHROPIC_TIERS || 'standard,power')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const model = tier === 'power'
    ? (env.CODEX_ANTHROPIC_MODEL_POWER || env.CODEX_ANTHROPIC_MODEL || DEFAULT_MODEL_POWER)
    : (env.CODEX_ANTHROPIC_MODEL_STANDARD || env.CODEX_ANTHROPIC_MODEL || DEFAULT_MODEL_STANDARD);
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
  for (const m of Array.isArray(messages) ? messages : []) {
    const content = typeof m?.content === 'string' ? m.content : '';
    if (!content) continue;
    if (m.role === 'system') {
      systemParts.push(content);
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${content}`;
    else turns.push({ role, content });
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

function defaultCreateClient({ env = process.env } = {}) {
  // Lazy require so offline tests (which always inject createClient) never load the SDK.
  const Anthropic = require('@anthropic-ai/sdk');
  const Ctor = Anthropic.default || Anthropic;
  return new Ctor({ apiKey: String(env.ANTHROPIC_API_KEY || '').trim() });
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
  return {
    text: textParts.join('\n').trim(),
    reasoning: reasoningParts.length
      ? { label: 'Razonando', text: reasoningParts.join('\n'), durationMs: 0 }
      : null,
    toolCalls,
    usage: {
      tokensIn: Number(u.input_tokens ?? 0) || 0,
      tokensOut: Number(u.output_tokens ?? 0) || 0,
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
async function anthropicTurn({ messages, tools = [], signal, env = process.env, tier = null, createClient = defaultCreateClient, maxTokens = DEFAULT_MAX_TOKENS } = {}) {
  const cfg = getAnthropicTurnConfig({ env, tier });
  if (!cfg.enabled) throw new Error('codex anthropic-turn: ANTHROPIC_API_KEY no configurada');
  const client = createClient({ env });
  if (!client?.messages?.create) throw new Error('codex anthropic-turn: cliente inválido');

  const { system, turns } = toAnthropicMessages(messages);
  const req = {
    model: cfg.model,
    max_tokens: maxTokens,
    system: system || undefined,
    messages: turns,
  };
  const anthropicTools = toAnthropicTools(tools);
  if (anthropicTools.length) req.tools = anthropicTools;

  const resp = await client.messages.create(req, signal ? { signal } : undefined);
  return parseResponse(resp, cfg.model);
}

module.exports = {
  anthropicTurn,
  getAnthropicTurnConfig,
  toAnthropicMessages,
  toAnthropicTools,
  parseResponse,
  DEFAULT_MODEL_POWER,
  DEFAULT_MODEL_STANDARD,
};
