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

function outcomeWeight(args = {}) {
  const raw = Number(args.weight);
  if (Number.isFinite(raw) && raw > 0 && raw <= 4) return raw;
  const source = String(args.source || '');
  const confidence = clamp01(args.confidence);
  // Regenerating a high-confidence document answer is a stronger
  // overconfidence signal than a casual thumb-down.
  if (source === 'regenerate' && confidence != null && confidence >= 0.7) return 2;
  return 1;
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
      scoreSource: args.scoreSource || null,
      weight: outcomeWeight(args),
      evidenceQuality: clamp01(args.evidenceQuality),
      supportRate: clamp01(args.supportRate),
      at: Date.now(),
    };
    state.events.push(event);
    if (state.events.length > MAX_EVENTS) {
      state.events.splice(0, state.events.length - MAX_EVENTS);
    }
    return { recorded: true, total: state.events.length, weight: event.weight };
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
  let wsum = 0;
  for (const e of events) {
    const w = Number(e.weight) > 0 ? Number(e.weight) : 1;
    sum += w * (e.confidence - e.y) ** 2;
    wsum += w;
  }
  if (wsum <= 0) return null;
  return Math.round((sum / wsum) * 1000) / 1000;
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
    const w = Number(e.weight) > 0 ? Number(e.weight) : 1;
    b.n += 1;
    b.w = (b.w || 0) + w;
    b.avgConfidence += e.confidence * w;
    b.avgAccuracy += e.y * w;
  }
  let ece = 0;
  const totalW = events.reduce((s, e) => s + (Number(e.weight) > 0 ? Number(e.weight) : 1), 0) || 1;
  for (const b of buckets) {
    if (b.n === 0) continue;
    const w = b.w || b.n;
    b.avgConfidence = Math.round((b.avgConfidence / w) * 1000) / 1000;
    b.avgAccuracy = Math.round((b.avgAccuracy / w) * 1000) / 1000;
    b.gap = Math.round(Math.abs(b.avgConfidence - b.avgAccuracy) * 1000) / 1000;
    ece += (w / totalW) * b.gap;
    delete b.w;
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

function bySourceBreakdown(events) {
  const out = {};
  for (const e of events) {
    const key = e.scoreSource || e.source || 'unknown';
    if (!out[key]) out[key] = { n: 0, correct: 0, brierAcc: 0 };
    out[key].n += 1;
    out[key].correct += e.y;
    out[key].brierAcc += (e.confidence - e.y) ** 2;
  }
  for (const row of Object.values(out)) {
    row.accuracy = row.n ? Math.round((row.correct / row.n) * 1000) / 1000 : null;
    row.brier = row.n ? Math.round((row.brierAcc / row.n) * 1000) / 1000 : null;
    delete row.correct;
    delete row.brierAcc;
  }
  return out;
}

function byBinBreakdown(events) {
  const bins = { high: { n: 0, correct: 0 }, medium: { n: 0, correct: 0 }, low: { n: 0, correct: 0 } };
  for (const e of events) {
    const key = e.bin === 'high' || e.bin === 'low' ? e.bin : 'medium';
    bins[key].n += 1;
    bins[key].correct += e.y;
  }
  for (const row of Object.values(bins)) {
    row.accuracy = row.n ? Math.round((row.correct / row.n) * 1000) / 1000 : null;
    delete row.correct;
  }
  return bins;
}

function overconfidenceRate(events) {
  const high = events.filter((e) => e.bin === 'high' || e.confidence >= 0.7);
  if (!high.length) return null;
  const wrong = high.filter((e) => e.y === 0).length;
  return Math.round((wrong / high.length) * 1000) / 1000;
}

function meanOf(events, key) {
  const vals = events.map((e) => e[key]).filter((v) => v != null && Number.isFinite(Number(v)));
  if (!vals.length) return null;
  const sum = vals.reduce((s, v) => s + Number(v), 0);
  return Math.round((sum / vals.length) * 1000) / 1000;
}

function metrics({ agent } = {}) {
  const events = state.events.filter((e) => !agent || e.agent === agent);
  const ece = eceBuckets(events);
  return {
    n: events.length,
    brier: brierScore(events),
    ece: ece.ece,
    buckets: ece.buckets,
    bySource: bySourceBreakdown(events),
    byBin: byBinBreakdown(events),
    overconfidenceRate: overconfidenceRate(events),
    claimSupportRate: meanOf(events, 'supportRate'),
    evidenceQuality: meanOf(events, 'evidenceQuality'),
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
      scoreSource: rlcd.source,
      evidenceQuality: rlcd.evidence && rlcd.evidence.quality,
      supportRate: rlcd.claims && rlcd.claims.supportRate,
      weight: rlcd.weight,
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
