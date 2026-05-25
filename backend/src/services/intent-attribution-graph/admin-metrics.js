'use strict';

/**
 * Admin metrics — rolling-window aggregation of IAG telemetry for
 * monitoring dashboards and SLO probes.
 *
 * Inspired by the paper's emphasis on *measuring* the impact of
 * attribution-graph findings (intervention experiments, suppression
 * rates, downstream activation changes). Here we measure the system
 * itself: per-language detection rate, per-theme frequency, average
 * confidence, hidden-intent prevalence, ambiguity detection rate.
 *
 * Pure in-memory. Bounded ring buffer (default 1000 entries). Useful
 * for /api/admin/iag-metrics dashboards.
 */

const MAX_BUFFER = Number.parseInt(process.env.SIRAGPT_IAG_METRICS_BUFFER || '1000', 10);

const buffer = [];
const ringIndex = { next: 0 };

function record(report) {
  if (!report || report.empty) return;
  const entry = {
    t: Date.now(),
    lang: report.language || 'unknown',
    featureCount: report.stats?.featureCount || 0,
    supernodeCount: report.stats?.supernodeCount || 0,
    circuitCount: report.stats?.circuitCount || 0,
    hiddenIntentCount: report.stats?.hiddenIntentCount || 0,
    confidence: report.confidence?.score || 0,
    confidenceBand: report.confidence?.band || 'unknown',
    shouldClarify: report.confidence?.shouldAskClarification || false,
    durationMs: report.durationMs || 0,
    topThemes: (report.supernodes || []).slice(0, 2).map((s) => s.themeId),
    topHiddenIntents: (report.hiddenIntents || []).slice(0, 2).map((h) => h.id),
  };

  if (buffer.length < MAX_BUFFER) {
    buffer.push(entry);
  } else {
    buffer[ringIndex.next] = entry;
    ringIndex.next = (ringIndex.next + 1) % MAX_BUFFER;
  }
}

function avg(values) {
  if (!values.length) return 0;
  return +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3);
}

function histogram(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] || 0) + 1;
  return out;
}

function topN(map, n = 5) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => ({ key: k, count: v }));
}

function getMetrics(opts = {}) {
  const now = Date.now();
  const windowMs = opts.windowMs || Infinity;
  const sliced = buffer.filter((e) => now - e.t <= windowMs);
  if (!sliced.length) {
    return {
      ok: true,
      windowMs,
      bufferSize: buffer.length,
      sampleCount: 0,
      summary: 'no data in window',
    };
  }

  const themes = sliced.flatMap((e) => e.topThemes);
  const hidden = sliced.flatMap((e) => e.topHiddenIntents);
  const langs = sliced.map((e) => e.lang);
  const bands = sliced.map((e) => e.confidenceBand);
  const confidences = sliced.map((e) => e.confidence);
  const durations = sliced.map((e) => e.durationMs);
  const featureCounts = sliced.map((e) => e.featureCount);
  const clarifyCount = sliced.filter((e) => e.shouldClarify).length;

  return {
    ok: true,
    windowMs,
    bufferSize: buffer.length,
    sampleCount: sliced.length,
    avgConfidence: avg(confidences),
    avgFeatureCount: avg(featureCounts),
    avgDurationMs: avg(durations),
    p95DurationMs: percentile(durations, 95),
    confidenceBandHistogram: histogram(bands),
    languageHistogram: histogram(langs),
    topThemes: topN(histogram(themes), 8),
    topHiddenIntents: topN(histogram(hidden), 8),
    clarificationRate: +(clarifyCount / sliced.length).toFixed(3),
    timestamp: now,
  };
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * pct / 100));
  return sorted[idx];
}

function reset() {
  buffer.length = 0;
  ringIndex.next = 0;
}

function getBufferSize() {
  return buffer.length;
}

module.exports = {
  record,
  getMetrics,
  reset,
  getBufferSize,
  MAX_BUFFER,
};
