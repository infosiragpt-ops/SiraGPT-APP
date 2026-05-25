'use strict';

/**
 * attribution-rollup-aggregator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Aggregates attribution telemetry across a sliding window of turns so
 * dashboards can surface:
 *   • intent distribution
 *   • average faithfulness / coverage
 *   • hallucination rate
 *   • top failing intents
 *   • per-domain breakdown
 *   • latency percentiles
 *   • per-user vs global views
 *
 * Each turn is recorded as a single TurnSample with the fields the
 * downstream dashboard cares about. The aggregator keeps a fixed-size
 * sliding window (default 1024 turns; env-tunable) and recomputes the
 * roll-up on demand. There is no separate per-time-bucket index — the
 * window itself acts as the implicit time bucket so the aggregator
 * stays a single in-memory ring buffer.
 *
 * Public API:
 *   record(sample)              → void
 *   rollup({ scope?, userId?, sinceMs? }) → RollupReport
 *   listRecent(opts?)           → TurnSample[]
 *   clear()                     → void
 *   stats()                     → { samples, perDomain, perVerdict }
 *
 * TurnSample shape (consumer-built):
 *   {
 *     userId?, chatId?, turnId?, timestamp?,
 *     domain?: string,                — from domain-calibration
 *     primaryIntent?: string,
 *     faithfulness?: number,           — overall score 0..1
 *     citationCoverage?: number,       — 0..1
 *     anomalyScore?: number,           — 0..1
 *     adversarialVerdict?: 'safe'|'suspect'|'medium_risk'|'high_risk',
 *     hopsDepth?: number,
 *     latencyMs?: number,
 *     trimmedBlocks?: string[],        — from prompt-budget-allocator
 *     hallucinated?: boolean,          — derived externally; logged here
 *     accepted?: boolean,              — final response accepted?
 *   }
 */

const WINDOW_SIZE = Math.max(64, Number(process.env.SIRAGPT_ROLLUP_WINDOW_SIZE) || 1024);

const buffer = []; // newest pushed at the end; we shift the oldest when full
const inFlight = { lastRollupAt: 0 };

function nowMs() { return Date.now(); }

function record(rawSample) {
  if (!rawSample || typeof rawSample !== 'object') return;
  const sample = {
    userId: rawSample.userId || null,
    chatId: rawSample.chatId || null,
    turnId: rawSample.turnId || null,
    timestamp: Number(rawSample.timestamp) || nowMs(),
    domain: typeof rawSample.domain === 'string' ? rawSample.domain.slice(0, 32) : null,
    primaryIntent: typeof rawSample.primaryIntent === 'string' ? rawSample.primaryIntent.slice(0, 48) : null,
    faithfulness: clamp01(rawSample.faithfulness),
    citationCoverage: clamp01(rawSample.citationCoverage),
    anomalyScore: clamp01(rawSample.anomalyScore),
    adversarialVerdict: typeof rawSample.adversarialVerdict === 'string' ? rawSample.adversarialVerdict.slice(0, 16) : null,
    hopsDepth: Number.isFinite(rawSample.hopsDepth) ? Number(rawSample.hopsDepth) : null,
    latencyMs: Number.isFinite(rawSample.latencyMs) ? Number(rawSample.latencyMs) : null,
    trimmedBlocks: Array.isArray(rawSample.trimmedBlocks) ? rawSample.trimmedBlocks.slice(0, 16) : [],
    hallucinated: rawSample.hallucinated === true,
    accepted: rawSample.accepted !== false,
  };
  buffer.push(sample);
  while (buffer.length > WINDOW_SIZE) buffer.shift();
}

function clamp01(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function filterSamples({ scope, userId, sinceMs }) {
  const cutoff = sinceMs ? nowMs() - Number(sinceMs) : 0;
  return buffer.filter((s) => {
    if (cutoff && s.timestamp < cutoff) return false;
    if (scope === 'user' && userId && s.userId !== userId) return false;
    return true;
  });
}

function groupBy(arr, key) {
  const out = new Map();
  for (const s of arr) {
    const k = s[key] || 'unknown';
    const list = out.get(k) || [];
    list.push(s);
    out.set(k, list);
  }
  return out;
}

function rollup({ scope = 'all', userId = null, sinceMs = null } = {}) {
  const samples = filterSamples({ scope, userId, sinceMs });
  if (samples.length === 0) {
    return { samples: 0, scope, userId, sinceMs, empty: true };
  }
  const faith = samples.map((s) => s.faithfulness).filter((v) => v !== null);
  const cov = samples.map((s) => s.citationCoverage).filter((v) => v !== null);
  const anom = samples.map((s) => s.anomalyScore).filter((v) => v !== null);
  const lat = samples.map((s) => s.latencyMs).filter((v) => v !== null);
  const hops = samples.map((s) => s.hopsDepth).filter((v) => v !== null);

  const hallucinated = samples.filter((s) => s.hallucinated).length;
  const accepted = samples.filter((s) => s.accepted).length;

  const byDomain = [...groupBy(samples, 'domain').entries()]
    .map(([domain, list]) => ({
      domain,
      count: list.length,
      meanFaithfulness: Number(mean(list.map((s) => s.faithfulness).filter((v) => v !== null)).toFixed(3)),
      acceptanceRate: Number((list.filter((s) => s.accepted).length / list.length).toFixed(3)),
    }))
    .sort((a, b) => b.count - a.count);

  const byVerdict = [...groupBy(samples, 'adversarialVerdict').entries()]
    .map(([v, list]) => ({ verdict: v, count: list.length }))
    .sort((a, b) => b.count - a.count);

  const topIntents = [...groupBy(samples, 'primaryIntent').entries()]
    .map(([intent, list]) => ({
      intent,
      count: list.length,
      meanFaithfulness: Number(mean(list.map((s) => s.faithfulness).filter((v) => v !== null)).toFixed(3)),
      failureRate: Number((list.filter((s) => s.faithfulness !== null && s.faithfulness < 0.5).length / list.length).toFixed(3)),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const trimmedKindCounts = new Map();
  for (const s of samples) {
    for (const kind of s.trimmedBlocks) {
      trimmedKindCounts.set(kind, (trimmedKindCounts.get(kind) || 0) + 1);
    }
  }
  const topTrimmed = [...trimmedKindCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([kind, count]) => ({ kind, count }));

  inFlight.lastRollupAt = nowMs();

  return {
    samples: samples.length,
    scope,
    userId,
    sinceMs,
    meanFaithfulness: Number(mean(faith).toFixed(3)),
    p50Faithfulness: Number(percentile(faith, 0.5).toFixed(3)),
    p25Faithfulness: Number(percentile(faith, 0.25).toFixed(3)),
    meanCitationCoverage: Number(mean(cov).toFixed(3)),
    meanAnomalyScore: Number(mean(anom).toFixed(3)),
    hallucinationRate: Number((hallucinated / samples.length).toFixed(3)),
    acceptanceRate: Number((accepted / samples.length).toFixed(3)),
    latencyP50Ms: percentile(lat, 0.5),
    latencyP95Ms: percentile(lat, 0.95),
    meanHopsDepth: Number(mean(hops).toFixed(2)),
    byDomain,
    byVerdict,
    topIntents,
    topTrimmedBlocks: topTrimmed,
    windowStart: samples[0]?.timestamp || null,
    windowEnd: samples[samples.length - 1]?.timestamp || null,
  };
}

function listRecent({ limit = 32 } = {}) {
  return buffer.slice(-Math.max(1, Math.min(buffer.length, limit)));
}

function clear() { buffer.length = 0; }

function stats() {
  const perDomain = {};
  const perVerdict = {};
  for (const s of buffer) {
    const d = s.domain || 'unknown';
    perDomain[d] = (perDomain[d] || 0) + 1;
    if (s.adversarialVerdict) {
      perVerdict[s.adversarialVerdict] = (perVerdict[s.adversarialVerdict] || 0) + 1;
    }
  }
  return { samples: buffer.length, perDomain, perVerdict, windowSize: WINDOW_SIZE };
}

const __resetForTests = () => clear();

module.exports = {
  record, rollup, listRecent, clear, stats,
  __resetForTests, WINDOW_SIZE,
};
