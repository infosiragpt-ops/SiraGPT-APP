'use strict';

/**
 * record-llm-usage — single funnel for "an LLM generation just
 * completed; persist its observability footprint".
 *
 * Three side effects, in this order:
 *
 *   1. Compute USD cost via `llm-cost.calculateCost()`. Pure;
 *      always succeeds (unknown models fall back to estimate).
 *
 *   2. Emit a `llm.generation.completed` event to PostHog
 *      (server-authoritative — a malicious client can't forge
 *      this). Disabled when PostHog isn't configured. Properties
 *      are non-PII: model, provider, token counts, cost in USD,
 *      surface label, latency. NEVER includes prompt or response
 *      text.
 *
 *   3. Emit a per-generation trace to Langfuse via
 *      `traceLLMGeneration()`. Disabled when Langfuse isn't
 *      configured. Includes the cost so the Langfuse dashboard
 *      can rollup spend per-user / per-model without us doing
 *      manual math in the UI.
 *
 * The helper is fire-and-forget: it returns synchronously and any
 * SDK errors are swallowed. Observability MUST never break the
 * request path. Callers don't await it.
 *
 * Disabled-by-default safety:
 *   When neither PostHog nor Langfuse is configured, the function
 *   computes the cost and returns it for the caller's own use
 *   (e.g. for the User.apiUsage increment), but emits nothing.
 *
 * Usage:
 *
 *   const { recordLLMUsage } = require('./observability/record-llm-usage');
 *
 *   const cost = recordLLMUsage({
 *     userId: req.user?.id,
 *     surface: 'chat.text-turn',
 *     model: 'gpt-4o',
 *     provider: 'OpenAI',
 *     inputTokens: usage.prompt_tokens,
 *     outputTokens: usage.completion_tokens,
 *     latencyMs: Date.now() - startedAt,
 *     // Optional context for funnel analysis:
 *     chatId, sessionId,
 *   });
 *   // `cost.cost_usd` is the USD amount; use it to increment
 *   // User.apiUsage if your accounting is in dollars.
 */

const { calculateCost } = require('./llm-cost');
// Access the observability SDK helpers via module references rather
// than destructured locals so test seams (replacing module exports)
// take effect — destructure creates a closure over the original
// function and survives mutation of the module's own property.
const posthogModule = require('./posthog');
const langfuseModule = require('./langfuse');

function recordLLMUsage(params = {}) {
  const {
    userId,
    surface,
    model,
    provider,
    inputTokens,
    outputTokens,
    latencyMs,
    chatId,
    sessionId,
    // Optional pass-through to the underlying observability
    // SDKs. Most callers will leave these undefined.
    metadata,
  } = params;

  // Always compute cost — it's pure + cheap and the caller often
  // wants the value back regardless of whether emission happens.
  const cost = calculateCost({ model, provider, inputTokens, outputTokens });

  // Posthog emit. Properties are non-PII by construction: only
  // ids, model labels, integer token counts, cost. NEVER include
  // prompt / response text — that's what Langfuse is for, with
  // its own access controls.
  if (userId) {
    try {
      posthogModule.capturePostHogEvent({
        distinctId: userId,
        event: 'llm.generation.completed',
        properties: {
          surface: surface || 'unknown',
          model: cost.model,
          provider: cost.provider,
          input_tokens: Math.max(0, Number(inputTokens) || 0),
          output_tokens: Math.max(0, Number(outputTokens) || 0),
          total_tokens: Math.max(0, Number(inputTokens) || 0) + Math.max(0, Number(outputTokens) || 0),
          cost_usd: cost.cost_usd,
          input_cost_usd: cost.input_cost_usd,
          output_cost_usd: cost.output_cost_usd,
          cost_source: cost.source,
          latency_ms: Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null,
          chat_id: chatId || null,
          session_id: sessionId || null,
        },
      });
    } catch (_err) {
      // Observability never breaks the request.
    }
  }

  // Langfuse trace. Includes the same fields plus cost annotation
  // so the dashboard can rollup spend per-trace without re-doing
  // the pricing math.
  try {
    langfuseModule.traceLLMGeneration({
      name: surface || 'llm-generation',
      model: cost.model,
      input: undefined,  // populated by callers that want to log it
      output: undefined,
      usage: {
        promptTokens: Math.max(0, Number(inputTokens) || 0),
        completionTokens: Math.max(0, Number(outputTokens) || 0),
        totalTokens: Math.max(0, Number(inputTokens) || 0) + Math.max(0, Number(outputTokens) || 0),
        // Langfuse cost convention is USD with input/output split.
        input: cost.input_cost_usd,
        output: cost.output_cost_usd,
        total: cost.cost_usd,
      },
      userId,
      sessionId: sessionId || chatId,
      metadata: {
        provider: cost.provider,
        cost_source: cost.source,
        latency_ms: Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null,
        ...(metadata || {}),
      },
    });
  } catch (_err) {
    // Observability never breaks the request.
  }

  return cost;
}

module.exports = {
  recordLLMUsage,
};
