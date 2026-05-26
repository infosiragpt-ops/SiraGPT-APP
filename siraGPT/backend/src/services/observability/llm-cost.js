'use strict';

/**
 * llm-cost — pricing table + per-call cost calculator for LLM
 * generations. Used by the chat / agent / RAG paths to convert
 * raw token counts into a USD cost figure that downstream
 * observability emits to PostHog (`llm.generation.completed`)
 * and Langfuse (per-trace cost annotation).
 *
 * Why this lives in observability/, not in the chat path:
 *   The same pricing table is read by:
 *     - the chat handler (after each generation)
 *     - the admin dashboard (rollup of per-user spend)
 *     - the cost-cap quota enforcer (8t followup)
 *   Centralising it here keeps the pricing assumptions in one
 *   reviewable place. A model-price update is a one-line change.
 *
 * Pricing source:
 *   Public list prices as of late-2026 (USD per 1M tokens).
 *   Inputs cost less than outputs across every provider, so the
 *   table tracks BOTH and the calculator computes them separately.
 *
 * Disabled-by-default safeguard:
 *   Observability stack (PostHog + Langfuse) is opt-in elsewhere.
 *   This module is pure compute — it never makes network calls.
 *   Callers integrate it conditionally; if observability is
 *   disabled the cost is computed but never emitted.
 *
 * Public API:
 *   - resolveCostConfig(env)           env → { fallbackPerMillion }
 *   - calculateCost({ model, provider, inputTokens, outputTokens })
 *                                      → { cost_usd, input_cost_usd,
 *                                          output_cost_usd, currency,
 *                                          source }
 *   - getModelPricing(modelKey)        raw pricing row or null
 *   - listKnownModels()                array of canonical model keys
 *   - PRICING_TABLE                    frozen table (read-only export)
 */

// Prices in USD per 1,000,000 tokens. Both input + output. Source
// is each provider's list price; we round to the documented rate
// and keep `notes` for any per-model caveats so the operator
// reading this doesn't have to grep release notes.
const PRICING_TABLE = Object.freeze({
  // ── OpenAI ─────────────────────────────────────────────────
  'gpt-5':            { input: 2.50, output: 10.00, provider: 'OpenAI' },
  'gpt-5-mini':       { input: 0.20, output: 0.80,  provider: 'OpenAI' },
  'gpt-4o':           { input: 2.50, output: 10.00, provider: 'OpenAI' },
  'gpt-4o-mini':      { input: 0.15, output: 0.60,  provider: 'OpenAI' },
  'gpt-4.1':          { input: 2.00, output: 8.00,  provider: 'OpenAI' },
  'gpt-4-turbo':      { input: 10.00, output: 30.00, provider: 'OpenAI' },
  'gpt-3.5-turbo':    { input: 0.50, output: 1.50,  provider: 'OpenAI' },

  // ── Anthropic ──────────────────────────────────────────────
  'claude-opus-4.7':            { input: 15.00, output: 75.00, provider: 'Anthropic' },
  'claude-sonnet-4.5':          { input: 3.00,  output: 15.00, provider: 'Anthropic' },
  'claude-haiku-4':             { input: 0.80,  output: 4.00,  provider: 'Anthropic' },
  'claude-3-5-sonnet-20241022': { input: 3.00,  output: 15.00, provider: 'Anthropic' },

  // ── Google Gemini ──────────────────────────────────────────
  'gemini-2.5-pro':       { input: 1.25, output: 5.00,  provider: 'Gemini' },
  'gemini-2.5-flash':     { input: 0.075, output: 0.30, provider: 'Gemini' },

  // ── DeepSeek ───────────────────────────────────────────────
  'deepseek-v4-flash':    { input: 0.07, output: 0.28, provider: 'DeepSeek' },
  'deepseek-v4-pro':      { input: 0.27, output: 1.10, provider: 'DeepSeek' },

  // ── OpenRouter (Moonshot Kimi) ─────────────────────────────
  'moonshotai/kimi-k2.6': { input: 0.50, output: 2.00, provider: 'OpenRouter' },

  // ── Groq (open-weight, hosted) ─────────────────────────────
  'llama-3.3-70b':        { input: 0.59, output: 0.79, provider: 'Groq' },
  'mixtral-8x7b':         { input: 0.24, output: 0.24, provider: 'Groq' },
});

const DEFAULT_FALLBACK_PER_MILLION = 1.00; // both input + output, conservative midrange estimate.

function resolveCostConfig(env = process.env) {
  const raw = Number.parseFloat(env.LLM_COST_FALLBACK_PER_MILLION);
  return {
    fallbackPerMillion: Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_FALLBACK_PER_MILLION,
  };
}

/**
 * normalizeModelKey — strip provider prefixes / case so the lookup
 * is forgiving. The OpenRouter naming convention is
 * `<provider>/<model>` and many call sites pass the raw model
 * string from a frontend dropdown, sometimes capitalized.
 */
function normalizeModelKey(modelKey) {
  if (!modelKey || typeof modelKey !== 'string') return '';
  return modelKey.trim().toLowerCase();
}

function getModelPricing(modelKey) {
  const normalized = normalizeModelKey(modelKey);
  if (!normalized) return null;
  if (PRICING_TABLE[normalized]) return PRICING_TABLE[normalized];
  // Try without an `openai/` / `anthropic/` / `google/` prefix.
  const withoutPrefix = normalized.replace(/^[a-z0-9_-]+\//, '');
  if (withoutPrefix !== normalized && PRICING_TABLE[withoutPrefix]) {
    return PRICING_TABLE[withoutPrefix];
  }
  return null;
}

function listKnownModels() {
  return Object.keys(PRICING_TABLE).slice();
}

/**
 * calculateCost — convert (model, inputTokens, outputTokens) into
 * a structured cost record. Always returns a value — unknown models
 * fall back to a per-million flat estimate so the cost dashboard
 * never has gaps. The `source` field flags which row was used:
 *   - 'pricing-table'  → exact row matched
 *   - 'fallback'       → unknown model, used estimate
 *   - 'invalid'        → bad inputs, returned zero cost
 *
 * Token counts < 0 or NaN are clamped to 0 — Prisma BigInt or
 * provider-returned values can be off; we'd rather under-count
 * than throw.
 */
function calculateCost({ model, provider, inputTokens, outputTokens } = {}, env = process.env) {
  const config = resolveCostConfig(env);
  const safeInput = Math.max(0, Number(inputTokens) || 0);
  const safeOutput = Math.max(0, Number(outputTokens) || 0);
  if (safeInput === 0 && safeOutput === 0) {
    return {
      cost_usd: 0,
      input_cost_usd: 0,
      output_cost_usd: 0,
      currency: 'USD',
      source: 'invalid',
      model: model || null,
      provider: provider || null,
    };
  }
  const pricing = getModelPricing(model);
  if (pricing) {
    const inputCost = (safeInput / 1_000_000) * pricing.input;
    const outputCost = (safeOutput / 1_000_000) * pricing.output;
    return {
      cost_usd: round6(inputCost + outputCost),
      input_cost_usd: round6(inputCost),
      output_cost_usd: round6(outputCost),
      currency: 'USD',
      source: 'pricing-table',
      model: normalizeModelKey(model),
      provider: provider || pricing.provider,
    };
  }
  // Unknown model — fall back to the env-tunable estimate. Use
  // the same per-million rate for input + output (we don't know
  // the model's split, and the conservative midrange estimate is
  // already a rough upper bound for input).
  const inputCost = (safeInput / 1_000_000) * config.fallbackPerMillion;
  const outputCost = (safeOutput / 1_000_000) * config.fallbackPerMillion;
  return {
    cost_usd: round6(inputCost + outputCost),
    input_cost_usd: round6(inputCost),
    output_cost_usd: round6(outputCost),
    currency: 'USD',
    source: 'fallback',
    model: model || null,
    provider: provider || null,
  };
}

function round6(n) {
  if (!Number.isFinite(n)) return 0;
  // Costs in USD with 6-decimal precision so a 100-token reply
  // doesn't round to $0.00. PostHog / Langfuse will further
  // truncate for display.
  return Math.round(n * 1_000_000) / 1_000_000;
}

module.exports = {
  PRICING_TABLE,
  DEFAULT_FALLBACK_PER_MILLION,
  resolveCostConfig,
  calculateCost,
  getModelPricing,
  listKnownModels,
  normalizeModelKey,
};
