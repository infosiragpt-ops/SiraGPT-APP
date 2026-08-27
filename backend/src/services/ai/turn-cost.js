'use strict';

/**
 * turn-cost — single funnel for per-turn chat cost accounting.
 *
 * Computes the real USD cost of one LLM turn via the canonical pricing
 * table (observability/llm-cost.calculateCost) and feeds it into the
 * in-memory cost-tracker so admin dashboards, runaway-cost alarms and
 * the daily CostUsageDaily flush see chat traffic (previously only the
 * paraphrase and Excel paths were tracked).
 *
 * Contract:
 *   - never throws (all failures degrade to a warn-free null),
 *   - returns the full calculateCost envelope (or null),
 *   - skips silently when there is no userId/model to account for.
 */

const { calculateCost } = require('../observability/llm-cost');

/**
 * Compute + record one turn's cost.
 *
 * @param {object} opts
 * @param {string|null} opts.userId        null/undefined → no-op (anonymous)
 * @param {string}      opts.model         logical model name as priced
 * @param {string|null} [opts.provider]    provider label ('OpenAI', 'Cerebras', …)
 * @param {number}      opts.inputTokens   tiktoken/provider prompt tokens
 * @param {number}      opts.outputTokens  completion tokens
 * @returns {{cost_usd:number, source:string, model:string|null, provider:string|null}|null}
 */
function trackTurnCost(opts = {}) {
  try {
    const { userId, model, provider, inputTokens, outputTokens } = opts;
    if (!userId || !model) return null;
    const info = calculateCost({
      model,
      provider: provider || null,
      inputTokens: Math.max(0, Number(inputTokens) || 0),
      outputTokens: Math.max(0, Number(outputTokens) || 0),
    });
    try {
      // Lazy require keeps this module loadable without the tracker and
      // avoids any circular-dependency surprises at boot time.
      const costTracker = require('./cost-tracker');
      costTracker.track({
        userId,
        model,
        provider: provider || null,
        inputTokens: Math.max(0, Number(inputTokens) || 0),
        outputTokens: Math.max(0, Number(outputTokens) || 0),
        // Feed the canonical price so the tracker never re-prices with
        // its mirrored pricing.json (single source of truth: llm-cost).
        costUSD: info.cost_usd,
      });
    } catch (_) { /* tracker failure must never break the caller */ }
    return info;
  } catch (_) {
    return null;
  }
}

module.exports = {
  trackTurnCost,
};
