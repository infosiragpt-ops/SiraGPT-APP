'use strict';

/**
 * codex/llm-turn — the default "one model step" used by the build/plan loop
 * (feature 06). Abstracts native-vs-prompted tool calling behind a single
 * `{ text, reasoning, toolCalls, usage }` return so the loop stays
 * provider-agnostic. The loop ALWAYS injects this in tests (scripted), so the
 * real provider path here is exercised only in live runs / the F15 smoke.
 *
 * Default provider: FlashGPT/Cerebras (free tier) in PROMPTED mode — the tools
 * are described in the system prompt and the model emits fenced ```tool_call
 * blocks, parsed back with the shared prompted-tool-calling helpers. Any model
 * can therefore drive the loop.
 */

const { getCerebrasConfig } = require('../ai/cerebras-client');
const llmProvider = require('./llm-provider');
const { buildPromptedToolsBlock, parsePromptedToolCalls } = require('../agents/prompted-tool-calling');
const { anthropicTurn, getAnthropicTurnConfig } = require('./anthropic-turn');

// Protocol scaffolding the prompted block tells the model to emit (e.g. a
// `finalize` block — codex has no such tool, so parsePromptedToolCalls rejects
// it and leaves the fence in cleanedContent). Strip any residual tool_call/json
// fence so raw protocol JSON never leaks into the user-facing narrative.
const RESIDUAL_FENCE_RE = /```(?:tool_call|json)\s*[\s\S]*?```/gi;

function stripResidualFences(text) {
  const s = String(text == null ? '' : text);
  if (!s.includes('```')) return s;
  return s.replace(RESIDUAL_FENCE_RE, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function appendToolsToSystem(messages, tools) {
  if (!tools || tools.length === 0) return messages.slice();
  const block = buildPromptedToolsBlock(tools);
  const out = messages.slice();
  const sysIdx = out.findIndex((m) => m.role === 'system');
  if (sysIdx >= 0) out[sysIdx] = { ...out[sysIdx], content: `${out[sysIdx].content}\n\n${block}` };
  else out.unshift({ role: 'system', content: block });
  return out;
}

function extractUsage(resp, model) {
  const u = resp?.usage || {};
  return {
    // Prefer the canonical field even when it is a legitimate 0 (e.g. cached
    // responses report prompt_tokens=0); `||` skipped a 0 and fell through to
    // the alternate field, inflating the count.
    tokensIn: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0,
    tokensOut: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0,
    provider: 'Cerebras',
    model,
    generationId: resp?.id || null,
  };
}

/**
 * Which engine drives this step. The composer's Power selector tier travels on
 * the run row → the loop passes it here. Paid tiers (standard/power by default,
 * env CODEX_ANTHROPIC_TIERS) go to Claude with native tool use when the key is
 * configured; Eco — and any run when Anthropic is unavailable — stays on the
 * free Cerebras prompted path.
 */
function resolveTurnEngine({ tier = null, env = process.env } = {}) {
  const cfg = getAnthropicTurnConfig({ env, tier });
  return cfg.enabled && cfg.tierEligible ? 'anthropic' : 'cerebras';
}

/**
 * One model step. `messages` are provider-safe (system/user/assistant only —
 * the loop encodes tool results as user [TOOL_RESULT] messages). `tools` is the
 * registry projection [{ name, description, parameters }].
 */
async function defaultLlmTurn({ messages, tools = [], signal, env = process.env, tier = null, createClient, createAnthropicClient, temperature = 0.3, maxTokens } = {}) {
  // Native Claude engine for eligible tiers (composer Power selector): best
  // tool-calling fidelity. On failure it degrades to the prompted ladder
  // below (which itself may reach Anthropic in prompted mode, or OpenRouter/
  // Cerebras) instead of failing the run.
  if (resolveTurnEngine({ tier, env }) === 'anthropic') {
    try {
      const opts = { messages, tools, signal, env, tier };
      if (createAnthropicClient) opts.createClient = createAnthropicClient;
      return await anthropicTurn(opts);
    } catch (err) {
      // An aborted run must stay aborted — don't burn another call on it.
      if (signal?.aborted) throw err;
      if (env?.NODE_ENV !== 'test') console.warn('[codex llm-turn] claude nativo falló, degradando al ladder prompted:', err?.message || err);
    }
  }

  const effective = appendToolsToSystem(messages, tools);

  let content = '';
  let reasoningText = '';
  let usage = null;

  if (createClient) {
    // Legacy injectable path (tests + explicit Cerebras): OpenAI-style client.
    const cfg = getCerebrasConfig({ env });
    if (!cfg.enabled) throw new Error('codex llm-turn: no LLM provider configured (CEREBRAS_API_KEY)');
    const client = createClient({ env });
    if (!client?.chat?.completions) throw new Error('codex llm-turn: invalid LLM client');
    const resp = await client.chat.completions.create(
      { model: cfg.model, messages: effective, temperature, max_tokens: maxTokens || 2048 },
      signal ? { signal } : undefined,
    );
    const choice = resp?.choices?.[0]?.message || {};
    content = typeof choice.content === 'string' ? choice.content : '';
    reasoningText = typeof choice.reasoning === 'string'
      ? choice.reasoning
      : (typeof choice.reasoning_content === 'string' ? choice.reasoning_content : '');
    usage = extractUsage(resp, cfg.model);
  } else {
    // Provider ladder: Anthropic (Claude) → OpenRouter → Cerebras, with
    // quarantine-based failover. The prompted tool protocol is model-agnostic,
    // so upgrading the model here upgrades the whole agent.
    const out = await llmProvider.chatComplete({ messages: effective, temperature, maxTokens, signal, env });
    content = out.content;
    reasoningText = out.reasoning || '';
    usage = out.usage;
  }

  const names = new Set((tools || []).map((t) => t.name));
  let toolCalls = [];
  let text = content;
  if (tools.length) {
    const parsed = parsePromptedToolCalls(content, names);
    text = stripResidualFences(parsed.cleanedContent);
    toolCalls = (parsed.toolCalls || []).map((tc) => {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
      return { id: tc.id, name: tc.function.name, args };
    });
  }

  return {
    text,
    reasoning: reasoningText ? { label: 'Razonando', text: reasoningText, durationMs: 0 } : null,
    toolCalls,
    usage,
  };
}

module.exports = { defaultLlmTurn, resolveTurnEngine, appendToolsToSystem, extractUsage, stripResidualFences };
