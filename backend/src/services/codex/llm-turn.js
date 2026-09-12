'use strict';

/**
 * codex/llm-turn — the default "one model step" used by the build/plan loop
 * (feature 06). Abstracts native-vs-prompted tool calling behind a single
 * `{ text, reasoning, toolCalls, usage }` return so the loop stays
 * provider-agnostic. The loop ALWAYS injects this in tests (scripted), so the
 * real provider path here is exercised only in live runs / the F15 smoke.
 *
 * Engine order: DeepSeek V4 NATIVE tool calling (deepseek-turn) whenever
 * DEEPSEEK_API_KEY is configured — the product ships only Sira Rápido / Sira
 * Pro, i.e. DeepSeek V4 Flash / Pro — then Claude native for eligible tiers,
 * then the PROMPTED ladder: the tools are described in the system prompt and
 * the model emits fenced ```tool_call blocks, parsed back with the shared
 * prompted-tool-calling helpers. Any model can therefore drive the loop.
 */

const cerebrasClientModule = require('../ai/cerebras-client');
const { getCerebrasConfig } = cerebrasClientModule;
const llmProvider = require('./llm-provider');
const { buildPromptedToolsBlock, parsePromptedToolCalls } = require('../agents/prompted-tool-calling');
const { anthropicTurn, getAnthropicTurnConfig } = require('./anthropic-turn');
const { deepseekTurn, getDeepSeekTurnConfig } = require('./deepseek-turn');

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

// An UNCLOSED ```tool_call / ```json fence is the signature of an output that
// was cut off mid-call — almost always a large write_file whose JSON overran
// the model's max_tokens (the free Cerebras/eco tier caps at 2048). The closed-
// fence regexes above never match it, so parsePromptedToolCalls yields ZERO
// tool calls and the loop mistakes the truncation for "the model is done",
// closing the build with the file never written AND leaking raw protocol JSON
// into the narrative. Detect that shape so the loop can nudge a retry instead.
const OPEN_FENCE_RE = /```(?:tool_call|json)\b/gi;

function detectTruncatedToolCall(text) {
  const s = String(text == null ? '' : text);
  if (!s.includes('```')) return { truncated: false, cleaned: s };
  // Count fence delimiters after the last tool_call/json opener: a call is
  // complete only if a closing ``` follows the opener. An odd count of ```
  // markers from the last opener onward means the block never closed.
  OPEN_FENCE_RE.lastIndex = 0;
  let lastOpen = -1;
  let m;
  while ((m = OPEN_FENCE_RE.exec(s)) !== null) lastOpen = m.index;
  if (lastOpen < 0) return { truncated: false, cleaned: s };
  const tail = s.slice(lastOpen);
  // The opener itself is a ``` — a closed block has at least one MORE ```.
  const fenceCount = (tail.match(/```/g) || []).length;
  if (fenceCount >= 2) return { truncated: false, cleaned: s };
  // Truncated: strip everything from the dangling opener so the raw protocol
  // JSON never reaches the user-facing narrative.
  const cleaned = s.slice(0, lastOpen).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { truncated: true, cleaned };
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
 * the run row → the loop passes it here.
 *   - `deepseek`  — DEEPSEEK_API_KEY configured and the tier is not carved out
 *                   by CODEX_DEEPSEEK_TIERS (default: every tier). Native tool
 *                   use; power → V4 Pro, otherwise → V4 Flash.
 *   - `anthropic` — otherwise, paid tiers (standard/power by default, env
 *                   CODEX_ANTHROPIC_TIERS) with ANTHROPIC_API_KEY.
 *   - `cerebras`  — everything else: the free prompted path.
 */
function resolveTurnEngine({ tier = null, env = process.env } = {}) {
  const ds = getDeepSeekTurnConfig({ env, tier });
  if (ds.enabled && ds.tierEligible) return 'deepseek';
  const cfg = getAnthropicTurnConfig({ env, tier });
  return cfg.enabled && cfg.tierEligible ? 'anthropic' : 'cerebras';
}

function anthropicEligible({ tier = null, env = process.env } = {}) {
  const cfg = getAnthropicTurnConfig({ env, tier });
  return cfg.enabled && cfg.tierEligible;
}

/**
 * One model step. `messages` are provider-safe (system/user/assistant only —
 * the loop encodes tool results as user [TOOL_RESULT] messages). `tools` is the
 * registry projection [{ name, description, parameters }].
 */
let _warnedEcoLadderFallback = false;

async function defaultLlmTurn({
  messages,
  tools = [],
  signal,
  env = process.env,
  tier = null,
  createClient,
  createAnthropicClient,
  createDeepSeekClient,
  temperature = 0.3,
  maxTokens,
  onTextDelta = null,
  onReasoningDelta = null,
  model = null,
  effort = null,
} = {}) {
  // Native engines first (DeepSeek V4 for every tier when configured, then
  // Claude for eligible tiers): best tool-calling fidelity. On failure they
  // degrade to the prompted ladder below instead of failing the run.
  //
  // `nativeDegraded` disambiguates WHY we reach the prompted path below:
  //   - true  → a native engine (deepseekTurn / anthropicTurn) threw; the
  //             provider ladder (with failover) is the correct, legitimate
  //             degradation. The engine that just failed is excluded from the
  //             ladder so it is not re-hit in prompted mode a second later.
  //   - false → a GENUINE eco run (resolveTurnEngine returned 'cerebras' because
  //             no native engine serves the tier). Eco MUST be free, so it goes
  //             to Cerebras DIRECT — NOT the ladder, which prioritizes paid
  //             providers ("first configured wins") and would silently bill
  //             them for the free tier.
  let nativeDegraded = false;
  const excludeFromLadder = [];
  const engine = resolveTurnEngine({ tier, env });
  if (engine === 'deepseek') {
    try {
      const opts = {
        messages,
        tools,
        signal,
        env,
        tier,
        onTextDelta,
        onReasoningDelta,
        model,
        effort,
      };
      if (createDeepSeekClient) opts.createClient = createDeepSeekClient;
      return await deepseekTurn(opts);
    } catch (err) {
      // An aborted run must stay aborted — don't burn another call on it.
      if (signal?.aborted) throw err;
      // Deltas already reached the user: another engine would splice two
      // different answers into one transcript. Fail closed.
      if (err?.partialResponse) throw err;
      nativeDegraded = true;
      excludeFromLadder.push('deepseek');
      if (env?.NODE_ENV !== 'test') console.warn('[codex llm-turn] deepseek nativo falló, degradando:', err?.message || err);
    }
  }
  if (engine === 'anthropic' || (nativeDegraded && anthropicEligible({ tier, env }))) {
    try {
      const opts = {
        messages,
        tools,
        signal,
        env,
        tier,
        onTextDelta,
        onReasoningDelta,
        model,
        effort,
      };
      if (createAnthropicClient) opts.createClient = createAnthropicClient;
      return await anthropicTurn(opts);
    } catch (err) {
      // An aborted run must stay aborted — don't burn another call on it.
      if (signal?.aborted) throw err;
      nativeDegraded = true;
      if (env?.NODE_ENV !== 'test') console.warn('[codex llm-turn] claude nativo falló, degradando al ladder prompted:', err?.message || err);
    }
  }

  const effective = appendToolsToSystem(messages, tools);

  let content = '';
  let reasoningText = '';
  let usage = null;

  // Genuine eco (not a native degradation) goes to Cerebras DIRECT when
  // configured, never the paid-first ladder. An injected `createClient` always
  // wins (tests + explicit Cerebras callers) and behaves identically.
  const ecoDirectCerebras = !nativeDegraded && getCerebrasConfig({ env }).enabled;

  // Provider ladder: DeepSeek → Anthropic (Claude) → OpenRouter → Cerebras,
  // with quarantine-based failover. Reached when (a) a native engine degraded,
  // (b) an eco run but Cerebras isn't configured, or (c) the direct Cerebras
  // call failed (402 payment_required, invalid key, …) — in which case
  // "something over nothing" wins, warned once so ops can see the eco tier is
  // not actually running free.
  const runLadder = async () => {
    if (!nativeDegraded && !_warnedEcoLadderFallback && env?.NODE_ENV !== 'test') {
      _warnedEcoLadderFallback = true;
      console.warn('[codex llm-turn] tier eco sin Cerebras utilizable — usando el ladder (puede cobrar un proveedor de pago)');
    }
    const out = await llmProvider.chatComplete({
      messages: effective,
      temperature,
      maxTokens,
      signal,
      env,
      onTextDelta,
      onReasoningDelta,
      model,
      effort,
      exclude: excludeFromLadder,
    });
    content = out.content;
    reasoningText = out.reasoning || '';
    usage = out.usage;
  };

  if (createClient || ecoDirectCerebras) {
    // Direct Cerebras (free tier) path: OpenAI-style client, max_tokens 2048.
    const cfg = getCerebrasConfig({ env });
    if (!cfg.enabled) throw new Error('codex llm-turn: no LLM provider configured (CEREBRAS_API_KEY)');
    const client = createClient ? createClient({ env }) : cerebrasClientModule.createCerebrasClient({ env });
    if (!client?.chat?.completions) throw new Error('codex llm-turn: invalid LLM client');
    try {
      const out = await llmProvider.callOpenAICompatible({
        messages: effective,
        temperature,
        maxTokens: maxTokens || 2048,
        signal,
        model: llmProvider.modelFor('cerebras', env, model) || cfg.model,
        client,
        providerLabel: 'Cerebras',
        onTextDelta,
        onReasoningDelta,
        effort,
      });
      content = out.content;
      reasoningText = out.reasoning || '';
      usage = out.usage;
    } catch (err) {
      // An aborted run must stay aborted — don't burn another call on it.
      if (signal?.aborted) throw err;
      // An injected createClient (tests / explicit Cerebras callers) is a hard
      // requirement — never silently replace the caller's chosen provider.
      if (createClient) throw err;
      if (env?.NODE_ENV !== 'test') {
        console.warn(`[codex llm-turn] tier eco degradando al ladder — Cerebras falló (${String(err?.message || err).slice(0, 200)}); revisa CEREBRAS_API_KEY/billing (402 payment_required sin recargar revienta todos los runs eco)`);
      }
      await runLadder();
    }
  } else {
    await runLadder();
  }

  const names = new Set((tools || []).map((t) => t.name));
  let toolCalls = [];
  let text = content;
  let truncated = false;
  if (tools.length) {
    const parsed = parsePromptedToolCalls(content, names);
    text = stripResidualFences(parsed.cleanedContent);
    toolCalls = (parsed.toolCalls || []).map((tc) => {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
      return { id: tc.id, name: tc.function.name, args };
    });
    // Only meaningful when NO complete call was parsed: a dangling opener next
    // to a parsed call is just the model's next (partial) thought and the loop
    // will get the completed call on the following turn. When zero calls came
    // back but a fence was left open, the step was cut off mid-tool-call.
    if (toolCalls.length === 0) {
      const trunc = detectTruncatedToolCall(text);
      if (trunc.truncated) {
        truncated = true;
        text = trunc.cleaned;
      }
    }
  }

  return {
    text,
    reasoning: reasoningText ? { label: 'Razonando', text: reasoningText, durationMs: 0 } : null,
    toolCalls,
    truncated,
    usage,
  };
}

module.exports = { defaultLlmTurn, resolveTurnEngine, appendToolsToSystem, extractUsage, stripResidualFences, detectTruncatedToolCall };
