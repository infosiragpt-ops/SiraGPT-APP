'use strict';

/**
 * In-process calibration metrics for document-agent answers.
 *
 * Outcomes come from thumbs (correct/incorrect) and regenerates
 * (prior answer treated as incorrect). Brier + ECE over 5 equal bins.
 * Fail-open. No GPU. Process-local; hydratable from preference
 * judgeScore.rlcd snapshots.
 */

const MAX_EVENTS = 400;
const BIN_COUNT = 5;

function freshState() {
  return {
    startedAt: Date.now(),
    events: [],
    documentTurns: 0,
    deferred: 0,
    scored: 0,
    skipped: 0,
  };
}

let state = freshState();

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function outcomeValue(outcome) {
  if (outcome === 'correct') return 1;
  if (outcome === 'incorrect') return 0;
  return null;
}

function recordOutcome(args = {}) {
  try {
    const confidence = clamp01(args.confidence);
    const y = outcomeValue(args.outcome);
    if (confidence == null || y == null) return { recorded: false, reason: 'incomplete' };
    const event = {
      confidence,
      outcome: args.outcome,
      y,
      bin: args.bin || (confidence >= 0.7 ? 'high' : confidence >= 0.45 ? 'medium' : 'low'),
      agent: args.agent || 'document',
      source: args.source || 'explicit',
      at: Date.now(),
    };
    state.events.push(event);
    if (state.events.length > MAX_EVENTS) {
      state.events.splice(0, state.events.length - MAX_EVENTS);
    }
    return { recorded: true, total: state.events.length };
  } catch {
    return { recorded: false, reason: 'fail_open' };
  }
}

function recordTurn({ deferred, scored } = {}) {
  try {
    state.documentTurns += 1;
    if (deferred) state.deferred += 1;
    if (scored) state.scored += 1;
  } catch { /* counters are optional */ }
}

function recordSkip() {
  try { state.skipped += 1; } catch { /* optional */ }
}

function brierScore(events) {
  if (!events.length) return null;
  let sum = 0;
  for (const e of events) sum += (e.confidence - e.y) ** 2;
  return Math.round((sum / events.length) * 1000) / 1000;
}

function eceBuckets(events, bins = BIN_COUNT) {
  const buckets = [];
  for (let i = 0; i < bins; i += 1) {
    const lo = i / bins;
    const hi = (i + 1) / bins;
    buckets.push({
      lo: Math.round(lo * 100) / 100,
      hi: Math.round(hi * 100) / 100,
      n: 0,
      avgConfidence: 0,
      avgAccuracy: 0,
      gap: 0,
    });
  }
  for (const e of events) {
    let idx = Math.min(bins - 1, Math.floor(e.confidence * bins));
    if (e.confidence >= 1) idx = bins - 1;
    const b = buckets[idx];
    b.n += 1;
    b.avgConfidence += e.confidence;
    b.avgAccuracy += e.y;
  }
  let ece = 0;
  const total = events.length || 1;
  for (const b of buckets) {
    if (b.n === 0) continue;
    b.avgConfidence = Math.round((b.avgConfidence / b.n) * 1000) / 1000;
    b.avgAccuracy = Math.round((b.avgAccuracy / b.n) * 1000) / 1000;
    b.gap = Math.round(Math.abs(b.avgConfidence - b.avgAccuracy) * 1000) / 1000;
    ece += (b.n / total) * b.gap;
  }
  return {
    ece: events.length ? Math.round(ece * 1000) / 1000 : null,
    buckets,
  };
}

function recentDeferRate() {
  if (state.documentTurns <= 0) return 0;
  return Math.round((state.deferred / state.documentTurns) * 1000) / 1000;
}

function metrics({ agent } = {}) {
  const events = state.events.filter((e) => !agent || e.agent === agent);
  const ece = eceBuckets(events);
  return {
    n: events.length,
    brier: brierScore(events),
    ece: ece.ece,
    buckets: ece.buckets,
    documentTurns: state.documentTurns,
    deferred: state.deferred,
    scored: state.scored,
    skipped: state.skipped,
    deferRate: recentDeferRate(),
    startedAt: state.startedAt,
  };
}

function hydrateFromPreferenceEvents(rows) {
  if (!Array.isArray(rows)) return 0;
  let n = 0;
  for (const row of rows) {
    const rlcd = row && row.judgeScore && row.judgeScore.rlcd;
    if (!rlcd) continue;
    const out = recordOutcome({
      confidence: rlcd.confidence,
      outcome: rlcd.outcome,
      bin: rlcd.bin,
      agent: row.agent || 'document',
      source: row.source || 'hydrate',
    });
    if (out.recorded) n += 1;
  }
  return n;
}

function snapshot() {
  return metrics({ agent: 'document' });
}

function reset() {
  state = freshState();
}

module.exports = {
  recordOutcome,
  recordTurn,
  recordSkip,
  recentDeferRate,
  metrics,
  hydrateFromPreferenceEvents,
  snapshot,
  reset,
  _reset: reset,
  MAX_EVENTS,
  BIN_COUNT,
};
