'use strict';

/**
 * Adaptive weights — pure-local exponential-moving-average learner that
 * adjusts feature/theme/hidden-intent weights from response-validator
 * feedback. Inspired by the paper's observation that feature importance
 * changes by context — we let the system *learn* which signals are
 * predictive of high-fidelity responses in real production usage.
 *
 * State is kept in-memory (no DB), partitioned per user. Weights default
 * to 1.0 (neutral) and drift up when the response covers the feature and
 * down when it doesn't.
 *
 * EMA formula:   w_t = (1 - α) · w_{t-1} + α · signal
 *   - signal = 1.0 if the feature was covered, 0.5 if neutral, 0.2 if missed
 *   - α (learning rate) = 0.1 by default
 *
 * Per-user maps prevent one user's drift from polluting another's.
 */

const DEFAULT_ALPHA = 0.1;
const MIN_WEIGHT = 0.2;
const MAX_WEIGHT = 1.4;
const MAX_USERS = 5000;
const MAX_LABELS_PER_USER = 200;
const FEATURE_KEY_PREFIX = 'feat:';
const THEME_KEY_PREFIX = 'theme:';
const HIDDEN_KEY_PREFIX = 'hidden:';

const userWeights = new Map(); // userId → Map<labelKey, weight>
const userLastUpdate = new Map(); // userId → timestamp

function clamp(value) {
  if (!Number.isFinite(value)) return 1.0;
  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, value));
}

function evictOldestUserIfFull() {
  if (userWeights.size < MAX_USERS) return;
  let oldestKey = null;
  let oldestT = Infinity;
  for (const [uid, t] of userLastUpdate) {
    if (t < oldestT) { oldestT = t; oldestKey = uid; }
  }
  if (oldestKey) {
    userWeights.delete(oldestKey);
    userLastUpdate.delete(oldestKey);
  }
}

function getUserMap(userId) {
  if (!userId) return null;
  if (!userWeights.has(userId)) {
    evictOldestUserIfFull();
    userWeights.set(userId, new Map());
  }
  userLastUpdate.set(userId, Date.now());
  return userWeights.get(userId);
}

function trimUserMap(map) {
  if (map.size <= MAX_LABELS_PER_USER) return;
  // Drop entries closest to 1.0 (least informative)
  const sorted = [...map.entries()].sort((a, b) =>
    Math.abs(a[1] - 1) - Math.abs(b[1] - 1));
  const toRemove = sorted.slice(0, map.size - MAX_LABELS_PER_USER);
  for (const [k] of toRemove) map.delete(k);
}

/**
 * Update weights based on a validation outcome.
 *   userId — identifier; null disables learning
 *   intentReport — output of analyzeIntent()
 *   validationResult — output of validate()
 *   alpha — optional learning rate override
 */
function recordOutcome(userId, intentReport, validationResult, alpha = DEFAULT_ALPHA) {
  if (!userId || !intentReport || !validationResult) return null;
  const map = getUserMap(userId);
  if (!map) return null;

  const features = intentReport.features || [];
  const hitsById = new Set((validationResult.featureHits || []).map((h) => h.id));

  // Per-feature update (by label, not id, so it generalizes across prompts).
  // Signals are shifted around the neutral weight of 1.0:
  //   covered → 1.2 (drift up)   missed → 0.3 (drift down).
  // This way features at the default neutral 1.0 actually move with usage.
  for (const f of features) {
    if (f.category !== 'action' && f.category !== 'object') continue;
    const key = `${FEATURE_KEY_PREFIX}${f.label}`;
    const prev = map.get(key) ?? 1.0;
    const signal = hitsById.has(f.id) ? 1.2 : 0.3;
    const next = clamp((1 - alpha) * prev + alpha * signal);
    map.set(key, next);
  }

  // Per-theme update — same shifted signal range.
  const hitThemeIds = new Set();
  for (const sn of (intentReport.supernodes || [])) {
    const memberHit = sn.members.some((mid) => hitsById.has(mid));
    if (memberHit) hitThemeIds.add(sn.themeId);
  }
  for (const sn of (intentReport.supernodes || [])) {
    const key = `${THEME_KEY_PREFIX}${sn.themeId}`;
    const prev = map.get(key) ?? 1.0;
    const signal = hitThemeIds.has(sn.themeId) ? 1.2 : 0.5;
    const next = clamp((1 - alpha) * prev + alpha * signal);
    map.set(key, next);
  }

  // Per-hidden-intent update
  const hiddenHits = new Set(validationResult.hiddenIntentHits || []);
  for (const hi of (intentReport.hiddenIntents || [])) {
    const key = `${HIDDEN_KEY_PREFIX}${hi.id}`;
    const prev = map.get(key) ?? 1.0;
    const signal = hiddenHits.has(hi.id) ? 1.2 : 0.4;
    const next = clamp((1 - alpha) * prev + alpha * signal);
    map.set(key, next);
  }

  trimUserMap(map);
  return {
    ok: true,
    userId,
    updatedCount: features.length + (intentReport.supernodes?.length || 0) + (intentReport.hiddenIntents?.length || 0),
    snapshot: Object.fromEntries(map),
  };
}

/**
 * Apply learned weights to an IntentReport, biasing feature.weight and
 * supernode.aggregateWeight toward the per-user historical importance.
 *
 * Pure — returns a new report without mutating the input.
 */
function applyWeights(userId, intentReport) {
  if (!userId || !intentReport || intentReport.empty) return intentReport;
  const map = userWeights.get(userId);
  if (!map || !map.size) return intentReport;

  const adjusted = JSON.parse(JSON.stringify(intentReport));
  for (const f of adjusted.features || []) {
    if (f.category !== 'action' && f.category !== 'object') continue;
    const w = map.get(`${FEATURE_KEY_PREFIX}${f.label}`);
    if (typeof w === 'number') f.weight = +(f.weight * w).toFixed(3);
  }
  for (const sn of adjusted.supernodes || []) {
    const w = map.get(`${THEME_KEY_PREFIX}${sn.themeId}`);
    if (typeof w === 'number') sn.aggregateWeight = +(sn.aggregateWeight * w).toFixed(3);
  }
  for (const hi of adjusted.hiddenIntents || []) {
    const w = map.get(`${HIDDEN_KEY_PREFIX}${hi.id}`);
    if (typeof w === 'number') hi.weight = +(hi.weight * w).toFixed(3);
  }
  // Re-sort by adjusted aggregate weight × confidence
  if (adjusted.supernodes?.length) {
    adjusted.supernodes.sort((a, b) =>
      (b.aggregateWeight * b.aggregateConfidence) - (a.aggregateWeight * a.aggregateConfidence));
  }
  if (adjusted.hiddenIntents?.length) {
    adjusted.hiddenIntents.sort((a, b) => b.weight - a.weight);
  }
  adjusted._adaptiveApplied = true;
  return adjusted;
}

function getSnapshot(userId) {
  const map = userWeights.get(userId);
  if (!map) return {};
  return Object.fromEntries(map);
}

function getStats() {
  let totalLabels = 0;
  for (const m of userWeights.values()) totalLabels += m.size;
  return {
    userCount: userWeights.size,
    totalLabels,
    avgLabelsPerUser: userWeights.size ? +(totalLabels / userWeights.size).toFixed(1) : 0,
  };
}

function resetUser(userId) {
  userWeights.delete(userId);
  userLastUpdate.delete(userId);
}

function resetAll() {
  userWeights.clear();
  userLastUpdate.clear();
}

module.exports = {
  recordOutcome,
  applyWeights,
  getSnapshot,
  getStats,
  resetUser,
  resetAll,
  // Constants exported for tests/diagnostics
  MIN_WEIGHT,
  MAX_WEIGHT,
  DEFAULT_ALPHA,
};
