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

const { getCerebrasConfig, createCerebrasClient } = require('../ai/cerebras-client');
const { buildPromptedToolsBlock, parsePromptedToolCalls } = require('../agents/prompted-tool-calling');

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
    tokensIn: Number(u.prompt_tokens || u.input_tokens || 0) || 0,
    tokensOut: Number(u.completion_tokens || u.output_tokens || 0) || 0,
    provider: 'Cerebras',
    model,
    generationId: resp?.id || null,
  };
}

/**
 * One model step. `messages` are provider-safe (system/user/assistant only —
 * the loop encodes tool results as user [TOOL_RESULT] messages). `tools` is the
 * registry projection [{ name, description, parameters }].
 */
async function defaultLlmTurn({ messages, tools = [], signal, env = process.env, createClient = createCerebrasClient, temperature = 0.3, maxTokens = 2048 } = {}) {
  const cfg = getCerebrasConfig({ env });
  if (!cfg.enabled) throw new Error('codex llm-turn: no LLM provider configured (CEREBRAS_API_KEY)');
  const client = createClient({ env });
  if (!client?.chat?.completions) throw new Error('codex llm-turn: invalid LLM client');

  const effective = appendToolsToSystem(messages, tools);
  const resp = await client.chat.completions.create(
    { model: cfg.model, messages: effective, temperature, max_tokens: maxTokens },
    signal ? { signal } : undefined,
  );

  const choice = resp?.choices?.[0]?.message || {};
  const content = typeof choice.content === 'string' ? choice.content : '';
  const reasoningText = typeof choice.reasoning === 'string'
    ? choice.reasoning
    : (typeof choice.reasoning_content === 'string' ? choice.reasoning_content : '');

  const names = new Set((tools || []).map((t) => t.name));
  let toolCalls = [];
  let text = content;
  if (tools.length) {
    const parsed = parsePromptedToolCalls(content, names);
    text = parsed.cleanedContent;
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
    usage: extractUsage(resp, cfg.model),
  };
}

module.exports = { defaultLlmTurn, appendToolsToSystem, extractUsage };
