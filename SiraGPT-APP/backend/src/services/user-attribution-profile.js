'use strict';

/**
 * User Attribution Profile
 *
 * Per-user, self-tuning weights for the attribution-graph signals. The
 * context-intelligence-engine emits the same signal types (imperative,
 * named_entity, document_ref, memory_fact, …) for every user, but the
 * IMPORTANCE of each signal depends on the user. A power user who chains
 * code-review requests gets different weights than someone using SiraGPT
 * for occasional document summarisation.
 *
 * Inspired by the attribution-graphs paper's observation that the same
 * feature has different downstream influence in different contexts. We
 * record, per user:
 *
 *   - frequency of each signal type
 *   - frequency of each detected intent
 *   - frequency of each hidden-goal pattern
 *   - whether the turn led to a successful follow-up (positive feedback) or
 *     to a correction / clarification (negative feedback)
 *
 * From this we derive a per-user weight multiplier in [0.5, 1.5] for each
 * signal type and intent kind, which the engine can apply to its default
 * weights to personalise its interpretation.
 *
 * Heuristic-only, in-memory, with optional disk persistence via the
 * provided save/load hook so it can be wired into the existing
 * cowork-disk-persistence layer without coupling.
 */

const DEFAULT_LIMITS = Object.freeze({
  MAX_USERS: Number.parseInt(process.env.SIRAGPT_USER_PROFILE_MAX_USERS || '10000', 10),
  MAX_HISTORY: Number.parseInt(process.env.SIRAGPT_USER_PROFILE_MAX_HISTORY || '200', 10),
  DEFAULT_DECAY: Number.parseFloat(process.env.SIRAGPT_USER_PROFILE_DECAY || '0.97'),
  MIN_OBSERVATIONS: Number.parseInt(process.env.SIRAGPT_USER_PROFILE_MIN_OBS || '5', 10),
  MIN_MULTIPLIER: 0.5,
  MAX_MULTIPLIER: 1.5,
});

const store = new Map();
const lru = [];

function clamp(value, min, max) {
  if (value == null || Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function makeBlankProfile(userId) {
  return {
    userId,
    totalTurns: 0,
    positiveTurns: 0,
    negativeTurns: 0,
    signalFrequency: {},
    intentFrequency: {},
    hiddenGoalFrequency: {},
    outcomeBySignal: {},
    outcomeByIntent: {},
    outcomeByHiddenGoal: {},
    recentTurns: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function touchLRU(userId) {
  const idx = lru.indexOf(userId);
  if (idx >= 0) lru.splice(idx, 1);
  lru.push(userId);
  while (lru.length > DEFAULT_LIMITS.MAX_USERS) {
    const evict = lru.shift();
    if (evict) store.delete(evict);
  }
}

function getProfile(userId) {
  if (!userId) return null;
  let profile = store.get(userId);
  if (!profile) {
    profile = makeBlankProfile(userId);
    store.set(userId, profile);
  }
  touchLRU(userId);
  return profile;
}

function bumpFrequency(map, key, weight = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + weight;
}

function bumpOutcome(outcomeMap, key, outcome) {
  if (!key || !outcome) return;
  const stats = outcomeMap[key] || { positive: 0, negative: 0, neutral: 0 };
  if (outcome === 'positive') stats.positive += 1;
  else if (outcome === 'negative') stats.negative += 1;
  else stats.neutral += 1;
  outcomeMap[key] = stats;
}

function decayValues(map, factor) {
  for (const key of Object.keys(map)) {
    const value = map[key];
    if (typeof value === 'number') {
      map[key] = value * factor;
      if (map[key] < 0.05) delete map[key];
    } else if (value && typeof value === 'object') {
      value.positive = (value.positive || 0) * factor;
      value.negative = (value.negative || 0) * factor;
      value.neutral = (value.neutral || 0) * factor;
      if (value.positive + value.negative + value.neutral < 0.05) {
        delete map[key];
      }
    }
  }
}

function applyDecay(profile, factor = DEFAULT_LIMITS.DEFAULT_DECAY) {
  decayValues(profile.signalFrequency, factor);
  decayValues(profile.intentFrequency, factor);
  decayValues(profile.hiddenGoalFrequency, factor);
  decayValues(profile.outcomeBySignal, factor);
  decayValues(profile.outcomeByIntent, factor);
  decayValues(profile.outcomeByHiddenGoal, factor);
}

function recordTurn(userId, snapshot, outcome = 'neutral') {
  if (!userId || !snapshot) return null;
  const profile = getProfile(userId);
  applyDecay(profile);

  profile.totalTurns += 1;
  if (outcome === 'positive') profile.positiveTurns += 1;
  else if (outcome === 'negative') profile.negativeTurns += 1;

  if (Array.isArray(snapshot.signals)) {
    for (const sig of snapshot.signals) {
      const type = sig?.type || sig;
      const weight = typeof sig === 'object' && typeof sig.weight === 'number' ? sig.weight : 1;
      bumpFrequency(profile.signalFrequency, type, weight);
      bumpOutcome(profile.outcomeBySignal, type, outcome);
    }
  }
  if (snapshot.primaryIntent) {
    const kind = typeof snapshot.primaryIntent === 'string'
      ? snapshot.primaryIntent
      : snapshot.primaryIntent.kind || snapshot.primaryIntent.name;
    if (kind) {
      bumpFrequency(profile.intentFrequency, kind, 1);
      bumpOutcome(profile.outcomeByIntent, kind, outcome);
    }
  }
  if (snapshot.hiddenGoal) {
    const goalName = typeof snapshot.hiddenGoal === 'string'
      ? snapshot.hiddenGoal
      : snapshot.hiddenGoal.name || snapshot.hiddenGoal.topCandidate?.name;
    if (goalName) {
      bumpFrequency(profile.hiddenGoalFrequency, goalName, 1);
      bumpOutcome(profile.outcomeByHiddenGoal, goalName, outcome);
    }
  }

  const turn = {
    ts: Date.now(),
    outcome,
    intent: typeof snapshot.primaryIntent === 'object'
      ? snapshot.primaryIntent.kind || null
      : snapshot.primaryIntent || null,
    hiddenGoal: typeof snapshot.hiddenGoal === 'object'
      ? snapshot.hiddenGoal.name || snapshot.hiddenGoal.topCandidate?.name || null
      : snapshot.hiddenGoal || null,
    signalTypes: Array.isArray(snapshot.signals)
      ? snapshot.signals.map((s) => s?.type || s)
      : [],
  };
  profile.recentTurns.push(turn);
  if (profile.recentTurns.length > DEFAULT_LIMITS.MAX_HISTORY) {
    profile.recentTurns.shift();
  }
  profile.updatedAt = Date.now();
  return turn;
}

function computeMultiplier(stats, defaultMultiplier = 1.0) {
  if (!stats) return defaultMultiplier;
  const total = (stats.positive || 0) + (stats.negative || 0) + (stats.neutral || 0);
  if (total < DEFAULT_LIMITS.MIN_OBSERVATIONS) return defaultMultiplier;
  const positiveRate = stats.positive / total;
  const negativeRate = stats.negative / total;
  const raw = 1 + (positiveRate - negativeRate) * 0.6;
  return Number(clamp(raw, DEFAULT_LIMITS.MIN_MULTIPLIER, DEFAULT_LIMITS.MAX_MULTIPLIER).toFixed(3));
}

function getSignalWeights(userId) {
  if (!userId) return {};
  const profile = store.get(userId);
  if (!profile) return {};
  const weights = {};
  for (const type of Object.keys(profile.outcomeBySignal)) {
    const mult = computeMultiplier(profile.outcomeBySignal[type]);
    if (mult !== 1.0) weights[type] = mult;
  }
  return weights;
}

function getIntentWeights(userId) {
  if (!userId) return {};
  const profile = store.get(userId);
  if (!profile) return {};
  const weights = {};
  for (const kind of Object.keys(profile.outcomeByIntent)) {
    const mult = computeMultiplier(profile.outcomeByIntent[kind]);
    if (mult !== 1.0) weights[kind] = mult;
  }
  return weights;
}

function getHiddenGoalWeights(userId) {
  if (!userId) return {};
  const profile = store.get(userId);
  if (!profile) return {};
  const weights = {};
  for (const goalName of Object.keys(profile.outcomeByHiddenGoal)) {
    const mult = computeMultiplier(profile.outcomeByHiddenGoal[goalName]);
    if (mult !== 1.0) weights[goalName] = mult;
  }
  return weights;
}

function getProfileSummary(userId) {
  if (!userId) return null;
  const profile = store.get(userId);
  if (!profile) return null;

  const topSignals = Object.entries(profile.signalFrequency)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([type, count]) => ({ type, count: Number(count.toFixed(3)) }));

  const topIntents = Object.entries(profile.intentFrequency)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([kind, count]) => ({ kind, count: Number(count.toFixed(3)) }));

  const topHiddenGoals = Object.entries(profile.hiddenGoalFrequency)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name, count]) => ({ name, count: Number(count.toFixed(3)) }));

  return {
    userId,
    totalTurns: profile.totalTurns,
    positiveTurns: profile.positiveTurns,
    negativeTurns: profile.negativeTurns,
    successRate: profile.totalTurns > 0
      ? Number((profile.positiveTurns / profile.totalTurns).toFixed(3))
      : 0,
    topSignals,
    topIntents,
    topHiddenGoals,
    signalWeights: getSignalWeights(userId),
    intentWeights: getIntentWeights(userId),
    hiddenGoalWeights: getHiddenGoalWeights(userId),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function applyPersonalisedWeights(report, userId) {
  if (!report || !userId) return report;
  const signalWeights = getSignalWeights(userId);
  const intentWeights = getIntentWeights(userId);

  if (report.attributionGraph?.signals && Object.keys(signalWeights).length > 0) {
    report.attributionGraph.signals = report.attributionGraph.signals.map((s) => {
      const mult = signalWeights[s.type];
      if (!mult || mult === 1.0) return s;
      return { ...s, weight: clamp(s.weight * mult, 0, 1) };
    });
  }

  if (report.attributionGraph?.intents && Object.keys(intentWeights).length > 0) {
    report.attributionGraph.intents = report.attributionGraph.intents.map((i) => {
      const mult = intentWeights[i.kind];
      if (!mult || mult === 1.0) return i;
      return { ...i, weight: clamp(i.weight * mult, 0, 1) };
    });
    report.attributionGraph.intents.sort((a, b) => b.weight - a.weight);
    const top = report.attributionGraph.intents[0];
    if (top) {
      report.attributionGraph.primaryIntent = { id: top.id, kind: top.kind, weight: top.weight };
      report.attributionGraph.confidence = top.weight;
    }
  }

  return report;
}

function reset() {
  store.clear();
  lru.length = 0;
}

function getAllUserIds() {
  return [...store.keys()];
}

function serialiseProfile(userId) {
  const profile = store.get(userId);
  if (!profile) return null;
  return JSON.parse(JSON.stringify(profile));
}

function hydrateProfile(serialised) {
  if (!serialised || !serialised.userId) return null;
  store.set(serialised.userId, serialised);
  touchLRU(serialised.userId);
  return serialised;
}

function buildProfilePrompt(userId, opts = {}) {
  const summary = getProfileSummary(userId);
  if (!summary || summary.totalTurns < DEFAULT_LIMITS.MIN_OBSERVATIONS) return '';
  const lines = ['### Personalised Attribution Profile'];
  lines.push(`Based on ${summary.totalTurns} prior turns (success rate ${Math.round(summary.successRate * 100)}%):`);
  if (summary.topIntents.length > 0) {
    lines.push(`- Frequent intents: ${summary.topIntents.map((i) => i.kind).join(', ')}`);
  }
  if (summary.topHiddenGoals.length > 0) {
    lines.push(`- Frequent underlying goals: ${summary.topHiddenGoals.map((g) => g.name.replace(/_/g, ' ')).join(', ')}`);
  }
  const boosted = Object.entries(summary.intentWeights).filter(([, w]) => w > 1.1);
  const dampened = Object.entries(summary.intentWeights).filter(([, w]) => w < 0.9);
  if (boosted.length > 0) {
    lines.push(`- Boosted interpretations: ${boosted.map(([k, w]) => `${k}×${w}`).join(', ')}`);
  }
  if (dampened.length > 0) {
    lines.push(`- Dampened interpretations: ${dampened.map(([k, w]) => `${k}×${w}`).join(', ')}`);
  }
  if (opts.includeRecommendation !== false) {
    lines.push('Tune your response toward the recurring goals; flag a polite check if the current intent is a strong outlier.');
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_LIMITS,
  recordTurn,
  getProfile,
  getProfileSummary,
  getSignalWeights,
  getIntentWeights,
  getHiddenGoalWeights,
  applyPersonalisedWeights,
  applyDecay,
  computeMultiplier,
  serialiseProfile,
  hydrateProfile,
  buildProfilePrompt,
  getAllUserIds,
  reset,
};
