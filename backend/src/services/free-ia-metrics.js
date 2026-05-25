'use strict';

/**
 * free-ia-metrics — tiny in-memory counter for Free IA (Cerebras)
 * fallback events.
 *
 * Why a bespoke counter instead of prom-client?
 *   The repo already exposes Prometheus via the metrics route, but
 *   pulling prom-client into the chargeCredits middleware would add a
 *   hot-path import on every paid call. This module is a flat object
 *   with O(1) inc/snapshot, no allocations per call. The metrics route
 *   can expose it as a Prometheus gauge / counter at scrape time.
 *
 * Public API:
 *   recordFallback({ feature, amount }) — increment counters
 *   snapshot()                          — { totalFallbacks, perFeature, lastEventAt }
 *   reset()                             — testing helper
 */

const state = {
  totalFallbacks: 0,
  totalCostBlocked: 0n,
  perFeature: Object.create(null),
  lastEventAt: null,
  // Health: track Free IA upstream outcomes so ops can see whether
  // Cerebras itself is healthy when we route to it.
  upstreamSuccess: 0,
  upstreamErrors: 0,
  lastUpstreamErrorAt: null,
  lastUpstreamErrorCode: null,
  // Bookkeeping: when the process started + the last time someone hit
  // the admin reset endpoint. Helps ops distinguish "counter is 0
  // because no events" from "counter is 0 because we just reset".
  startedAt: new Date().toISOString(),
  lastResetAt: null,
};

function toAmount(value) {
  if (value == null) return 0n;
  if (typeof value === 'bigint') return value;
  try {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? BigInt(Math.floor(n)) : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Record a single Free IA fallback event. Called from the chargeCredits
 * middleware when an INSUFFICIENT balance is silently re-routed.
 */
function recordFallback({ feature, amount } = {}) {
  state.totalFallbacks += 1;
  const cost = toAmount(amount);
  state.totalCostBlocked += cost;
  state.lastEventAt = new Date().toISOString();
  const key = typeof feature === 'string' && feature ? feature : 'unknown';
  const slot = state.perFeature[key] || { count: 0, costBlocked: 0n };
  slot.count += 1;
  slot.costBlocked += cost;
  state.perFeature[key] = slot;
  return state.totalFallbacks;
}

/**
 * Record the OUTCOME of a Free IA upstream call (Cerebras).
 *   recordUpstreamSuccess() — bump success counter
 *   recordUpstreamError({ code }) — bump error counter + stash code
 *
 * The two together let ops compute a Free IA success rate from
 * `upstreamSuccess / (upstreamSuccess + upstreamErrors)`.
 */
function recordUpstreamSuccess() {
  state.upstreamSuccess += 1;
  return state.upstreamSuccess;
}

function recordUpstreamError({ code } = {}) {
  state.upstreamErrors += 1;
  state.lastUpstreamErrorAt = new Date().toISOString();
  state.lastUpstreamErrorCode = typeof code === 'string' ? code : (code != null ? String(code) : null);
  return state.upstreamErrors;
}

/**
 * Return a JSON-safe snapshot of the current counters. BigInts are
 * serialised to strings so callers can JSON.stringify without crashing.
 */
function snapshot() {
  const perFeature = {};
  for (const [k, v] of Object.entries(state.perFeature)) {
    perFeature[k] = {
      count: v.count,
      costBlocked: v.costBlocked.toString(),
    };
  }
  const totalUpstream = state.upstreamSuccess + state.upstreamErrors;
  const successRate = totalUpstream === 0
    ? null
    : Math.round((state.upstreamSuccess / totalUpstream) * 10000) / 10000;
  return {
    totalFallbacks: state.totalFallbacks,
    totalCostBlocked: state.totalCostBlocked.toString(),
    perFeature,
    lastEventAt: state.lastEventAt,
    upstream: {
      success: state.upstreamSuccess,
      errors: state.upstreamErrors,
      successRate,
      lastErrorAt: state.lastUpstreamErrorAt,
      lastErrorCode: state.lastUpstreamErrorCode,
    },
    startedAt: state.startedAt,
    lastResetAt: state.lastResetAt,
  };
}

/**
 * Render the snapshot as a Prometheus-style text-exposition payload so
 * the metrics route can append it to its scrape output.
 *   sira_free_ia_fallback_total
 *   sira_free_ia_fallback_cost_blocked_total
 *   sira_free_ia_fallback_total{feature="..."}
 */
function toPrometheusText() {
  const lines = [];
  lines.push('# HELP sira_free_ia_fallback_total Number of credit-exhausted requests silently re-routed to Free IA.');
  lines.push('# TYPE sira_free_ia_fallback_total counter');
  lines.push(`sira_free_ia_fallback_total ${state.totalFallbacks}`);
  lines.push('# HELP sira_free_ia_fallback_cost_blocked_total Sum of credit cost that would have been charged had Free IA not been available.');
  lines.push('# TYPE sira_free_ia_fallback_cost_blocked_total counter');
  lines.push(`sira_free_ia_fallback_cost_blocked_total ${state.totalCostBlocked.toString()}`);
  for (const [k, v] of Object.entries(state.perFeature)) {
    const escaped = String(k).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`sira_free_ia_fallback_total{feature="${escaped}"} ${v.count}`);
    lines.push(`sira_free_ia_fallback_cost_blocked_total{feature="${escaped}"} ${v.costBlocked.toString()}`);
  }
  lines.push('# HELP sira_free_ia_upstream_success_total Successful Cerebras Llama 3.1 8B calls.');
  lines.push('# TYPE sira_free_ia_upstream_success_total counter');
  lines.push(`sira_free_ia_upstream_success_total ${state.upstreamSuccess}`);
  lines.push('# HELP sira_free_ia_upstream_errors_total Failed Cerebras Llama 3.1 8B calls.');
  lines.push('# TYPE sira_free_ia_upstream_errors_total counter');
  lines.push(`sira_free_ia_upstream_errors_total ${state.upstreamErrors}`);
  return lines.join('\n') + '\n';
}

function reset() {
  state.totalFallbacks = 0;
  state.totalCostBlocked = 0n;
  state.perFeature = Object.create(null);
  state.lastEventAt = null;
  state.upstreamSuccess = 0;
  state.upstreamErrors = 0;
  state.lastUpstreamErrorAt = null;
  state.lastUpstreamErrorCode = null;
  state.lastResetAt = new Date().toISOString();
}

module.exports = {
  recordFallback,
  recordUpstreamSuccess,
  recordUpstreamError,
  snapshot,
  toPrometheusText,
  reset,
};
