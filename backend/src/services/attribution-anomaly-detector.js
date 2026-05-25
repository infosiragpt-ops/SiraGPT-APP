'use strict';

/**
 * attribution-anomaly-detector.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects when a current turn's attribution profile is significantly
 * different from the user's rolling baseline. Inspired by the
 * "anomalous activations" diagnostic in Anthropic's circuit-tracing
 * tooling: most turns sit close to a typical profile; the unusual ones
 * deserve extra scrutiny (out-of-domain question, sudden topic pivot,
 * possible context confusion, attempted social engineering).
 *
 * The detector keeps a per-user rolling buffer of recent turn profiles
 * (centroid type-vector + dominant intent kind + feature-kind histogram)
 * and scores each new turn against the buffer's mean. A turn whose
 * centroid distance exceeds the configurable z-score threshold OR
 * introduces an intent kind not seen in the last N turns OR doubles the
 * feature-count variance is flagged as anomalous.
 *
 * Public API:
 *   observe({ userId, profile })          → void   (record into rolling buffer)
 *   score({ userId, profile })            → AnomalyScore
 *   buildAnomalyBlock(score, opts?)       → string (inert prompt block)
 *   getBaseline(userId)                   → Baseline | null
 *   clear({ userId? })                    → void
 *   stats()                               → { users, totalProfiles }
 *
 * Profile shape (consumer-built — typically from attribution-graph
 * summarize() or context-attribution-engine.analyze() output):
 *   {
 *     centroid: { input, context, feature, intent, action, other }   (proportions, sum ~ 1)
 *     dominantIntentKind: string | null,
 *     featureCount: number,
 *     featureKinds: { [kind]: count }
 *   }
 *
 * Tunables (env):
 *   SIRAGPT_ANOMALY_BUFFER_SIZE       (default 12)
 *   SIRAGPT_ANOMALY_Z_THRESHOLD       (default 2.0)
 *   SIRAGPT_ANOMALY_MIN_SAMPLES       (default 3)
 */

const BUFFER_SIZE = Math.max(3, Number(process.env.SIRAGPT_ANOMALY_BUFFER_SIZE) || 12);
const Z_THRESHOLD = Number(process.env.SIRAGPT_ANOMALY_Z_THRESHOLD) || 2.0;
const MIN_SAMPLES = Math.max(2, Number(process.env.SIRAGPT_ANOMALY_MIN_SAMPLES) || 3);

const buffers = new Map(); // userId → ProfileBuffer

function getOrCreateBuffer(userId) {
  let buf = buffers.get(userId || 'anon');
  if (!buf) {
    buf = { profiles: [], intentKinds: new Set() };
    buffers.set(userId || 'anon', buf);
  }
  return buf;
}

function normalizeProfile(raw) {
  const centroid = raw?.centroid || {};
  return {
    centroid: {
      input: Number(centroid.input) || 0,
      context: Number(centroid.context) || 0,
      feature: Number(centroid.feature) || 0,
      intent: Number(centroid.intent) || 0,
      action: Number(centroid.action) || 0,
      other: Number(centroid.other) || 0,
    },
    dominantIntentKind: raw?.dominantIntentKind || null,
    featureCount: Number(raw?.featureCount) || 0,
    featureKinds: raw?.featureKinds || {},
  };
}

function l1Distance(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let sum = 0;
  for (const k of keys) sum += Math.abs((a[k] || 0) - (b[k] || 0));
  return sum;
}

function meanCentroid(profiles) {
  if (profiles.length === 0) return null;
  const out = { input: 0, context: 0, feature: 0, intent: 0, action: 0, other: 0 };
  for (const p of profiles) {
    for (const k of Object.keys(out)) out[k] += (p.centroid[k] || 0);
  }
  for (const k of Object.keys(out)) out[k] /= profiles.length;
  return out;
}

function stdDevCentroidDistance(profiles, mean) {
  if (profiles.length < 2) return 0;
  const dists = profiles.map((p) => l1Distance(p.centroid, mean));
  const m = dists.reduce((a, b) => a + b, 0) / dists.length;
  const variance = dists.reduce((a, b) => a + (b - m) ** 2, 0) / dists.length;
  return Math.sqrt(variance);
}

function meanFeatureCount(profiles) {
  if (profiles.length === 0) return 0;
  return profiles.reduce((acc, p) => acc + p.featureCount, 0) / profiles.length;
}

function observe({ userId, profile } = {}) {
  if (!profile) return;
  const buf = getOrCreateBuffer(userId);
  const norm = normalizeProfile(profile);
  buf.profiles.push(norm);
  if (norm.dominantIntentKind) buf.intentKinds.add(norm.dominantIntentKind);
  if (buf.profiles.length > BUFFER_SIZE) {
    const dropped = buf.profiles.shift();
    // Note: intentKinds is intentionally cumulative — we don't unlearn
    // because a returning intent is not "anomalous"; only first-time
    // appearances should count toward novelty.
    void dropped;
  }
}

function score({ userId, profile } = {}) {
  if (!profile) return { anomalous: false, reason: 'no profile', score: 0 };
  const buf = buffers.get(userId || 'anon');
  if (!buf || buf.profiles.length < MIN_SAMPLES) {
    return { anomalous: false, reason: 'insufficient baseline', score: 0, samples: buf?.profiles.length || 0 };
  }
  const norm = normalizeProfile(profile);
  const mean = meanCentroid(buf.profiles);
  const sd = stdDevCentroidDistance(buf.profiles, mean);
  const dist = l1Distance(norm.centroid, mean);
  // When the baseline has zero variance (all observed profiles are
  // identical), any non-trivial new distance is by definition
  // out-of-distribution. Treat sd-of-zero as "infinitely confident
  // baseline" — collapse to a large z-score scaled by distance so the
  // existing threshold still triggers.
  let zScore;
  if (sd === 0) {
    zScore = dist > 0.05 ? Math.min(10, dist * 10) : 0;
  } else {
    zScore = dist / sd;
  }

  const meanFeatures = meanFeatureCount(buf.profiles);
  const featureSpike = meanFeatures > 0 && norm.featureCount > meanFeatures * 2;

  const novelIntent = norm.dominantIntentKind && !buf.intentKinds.has(norm.dominantIntentKind);

  const reasons = [];
  if (zScore >= Z_THRESHOLD) reasons.push(`centroid z-score ${zScore.toFixed(2)} ≥ ${Z_THRESHOLD}`);
  if (featureSpike) reasons.push(`feature count ${norm.featureCount} > 2× baseline ${meanFeatures.toFixed(1)}`);
  if (novelIntent) reasons.push(`novel dominant intent "${norm.dominantIntentKind}"`);

  return {
    anomalous: reasons.length > 0,
    score: Number(Math.min(1, zScore / Z_THRESHOLD).toFixed(3)),
    zScore: Number(zScore.toFixed(3)),
    l1Distance: Number(dist.toFixed(3)),
    samples: buf.profiles.length,
    reasons,
    meanCentroid: mean,
    centroid: norm.centroid,
    dominantIntentKind: norm.dominantIntentKind,
    featureCount: norm.featureCount,
    meanFeatureCount: Number(meanFeatures.toFixed(2)),
    novelIntent: !!novelIntent,
    featureSpike: !!featureSpike,
  };
}

function buildAnomalyBlock(scoreReport, opts = {}) {
  if (!scoreReport || !scoreReport.anomalous) return '';
  const lines = ['\n\n<attribution_anomaly>'];
  lines.push(`Este turno se desvía del patrón habitual del usuario (score ${scoreReport.score}).`);
  if (Array.isArray(scoreReport.reasons) && scoreReport.reasons.length > 0) {
    lines.push('Señales detectadas:');
    for (const r of scoreReport.reasons) lines.push(`  • ${r}`);
  }
  if (scoreReport.novelIntent) {
    lines.push('Nueva intención dominante respecto a la conversación previa — confirma con el usuario');
    lines.push('si está cambiando de tema o si la pregunta nueva pertenece al hilo actual.');
  } else if (scoreReport.featureSpike) {
    lines.push('Spike de señales sobre el promedio — el mensaje toca muchos temas a la vez.');
  } else {
    lines.push('Patrón de atribución inusual — considera pedir contexto antes de profundizar.');
  }
  lines.push('</attribution_anomaly>');
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 900;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function getBaseline(userId) {
  const buf = buffers.get(userId || 'anon');
  if (!buf || buf.profiles.length === 0) return null;
  const mean = meanCentroid(buf.profiles);
  return {
    samples: buf.profiles.length,
    meanCentroid: mean,
    meanFeatureCount: Number(meanFeatureCount(buf.profiles).toFixed(2)),
    intentKinds: [...buf.intentKinds],
  };
}

function clear({ userId } = {}) {
  if (userId) {
    buffers.delete(userId);
    return;
  }
  buffers.clear();
}

function stats() {
  let totalProfiles = 0;
  for (const buf of buffers.values()) totalProfiles += buf.profiles.length;
  return { users: buffers.size, totalProfiles };
}

const __resetForTests = () => buffers.clear();

module.exports = {
  observe,
  score,
  buildAnomalyBlock,
  getBaseline,
  clear,
  stats,
  __resetForTests,
  BUFFER_SIZE,
  Z_THRESHOLD,
  MIN_SAMPLES,
};
