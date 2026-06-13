'use strict';

/**
 * codex/cost-resolver — resolve the USD cost of ONE LLM call with an explicit
 * `costSource` (feature 08, spec §7). Ladder, in order:
 *
 *   1. provider_exact         — the response already carries a direct cost, or
 *                               the provider is a known free tier (Cerebras →
 *                               exactly 0).
 *   2. openrouter_generation  — OpenRouter + a generationId → GET
 *                               /api/v1/generation?id= for the native cost.
 *                               Any failure degrades to the next rung (never
 *                               breaks the run).
 *   3. estimated              — estimateCostUsd(provider, tokens) from the
 *                               agent-harness manifests. Null estimate (unknown
 *                               provider) → 0 estimated.
 *
 * fetchImpl is injectable so the OpenRouter path is testable offline.
 */

const { estimateCostUsd } = require('../agent-harness/event-stream');

// Providers we KNOW are free, so a 0 cost is exact (not an estimate).
const FREE_PROVIDERS = new Set(['cerebras', 'flashgpt', 'free-ia', 'gema4', 'gema']);

function isOpenRouter(provider) {
  return /openrouter/i.test(String(provider || ''));
}

function normProvider(p) {
  return String(p || '').trim().toLowerCase();
}

async function fetchOpenRouterCost({ generationId, env, fetchImpl }) {
  const key = env.OPENROUTER_API_KEY;
  if (!key || !generationId) return null;
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return null;
  try {
    const res = await doFetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res || !res.ok) return null;
    const body = await res.json().catch(() => null);
    const cost = body?.data?.total_cost ?? body?.data?.cost ?? body?.total_cost;
    return Number.isFinite(Number(cost)) ? Number(cost) : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} usage — { tokensIn, tokensOut, provider, model, generationId?, costUsd? }
 * @returns {Promise<{ costUsd:number, costSource:'provider_exact'|'openrouter_generation'|'estimated' }>}
 */
async function resolveCost(usage = {}, { env = process.env, fetchImpl } = {}) {
  const provider = normProvider(usage.provider);
  const tokens = (Number(usage.tokensIn) || 0) + (Number(usage.tokensOut) || 0);

  // 1) Direct cost on the response.
  if (Number.isFinite(Number(usage.costUsd))) {
    return { costUsd: Number(usage.costUsd), costSource: 'provider_exact' };
  }
  // 1b) Known free provider → exactly 0.
  if (FREE_PROVIDERS.has(provider)) {
    return { costUsd: 0, costSource: 'provider_exact' };
  }

  // 2) OpenRouter native generation cost.
  if (isOpenRouter(usage.provider) && usage.generationId) {
    const cost = await fetchOpenRouterCost({ generationId: usage.generationId, env, fetchImpl });
    if (cost != null) return { costUsd: cost, costSource: 'openrouter_generation' };
    // else degrade to estimate
  }

  // 3) Estimate from manifests.
  const est = estimateCostUsd(usage.provider, tokens);
  return { costUsd: Number.isFinite(est) ? est : 0, costSource: 'estimated' };
}

/** Pick the least-precise source across N calls (what the card badge reflects). */
function aggregateSource(sources) {
  if (sources.includes('estimated')) return 'estimated';
  if (sources.includes('openrouter_generation')) return 'openrouter_generation';
  return 'provider_exact';
}

module.exports = { resolveCost, aggregateSource, fetchOpenRouterCost, FREE_PROVIDERS };
