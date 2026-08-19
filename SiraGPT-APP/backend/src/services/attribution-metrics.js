'use strict';

/**
 * attribution-metrics.js
 *
 * In-memory aggregator for per-turn telemetry emitted by the
 * context-attribution-engine. Lets ops query a /api/attribution/metrics
 * endpoint to see how the system is actually understanding traffic in
 * real time without needing a separate observability stack.
 *
 * What we record per turn:
 *   - latencyMs
 *   - primaryIntent + intentConfidence
 *   - multiHopDepth
 *   - planNodes
 *   - suppressionConflicts
 *   - faithfulnessGrade (if measured)
 *   - language
 *
 * What we expose:
 *   - rolling counts + percentiles over a sliding window
 *   - top-N intents by frequency
 *   - intent transition matrix (prev → current)
 *   - per-language distribution
 *
 * The aggregator is purely in-memory and bounded by `MAX_RECORDS`. It is
 * lossy by design (last N turns); persisting to Prisma or OTel is left
 * to a downstream sink.
 */

const MAX_RECORDS = Number.parseInt(process.env.SIRAGPT_ATTR_METRICS_MAX || '2000', 10);

const RECORDS = []; // bounded array, oldest at index 0
const TRANSITION_MATRIX = new Map(); // 'prev|curr' -> count
const PER_USER_LAST_INTENT = new Map(); // userId -> last intent label

function safeNumber(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function record(turnRecord = {}) {
  const r = {
    timestamp: Number(turnRecord.timestamp) || Date.now(),
    userId: turnRecord.userId ? String(turnRecord.userId).slice(0, 64) : null,
    chatId: turnRecord.chatId ? String(turnRecord.chatId).slice(0, 64) : null,
    latencyMs: safeNumber(turnRecord.latencyMs),
    primaryIntent: turnRecord.primaryIntent ? String(turnRecord.primaryIntent).slice(0, 80) : null,
    intentConfidence: safeNumber(turnRecord.intentConfidence),
    multiHopDepth: safeNumber(turnRecord.multiHopDepth),
    planNodes: safeNumber(turnRecord.planNodes),
    suppressionConflicts: safeNumber(turnRecord.suppressionConflicts),
    faithfulnessGrade: turnRecord.faithfulnessGrade ? String(turnRecord.faithfulnessGrade).slice(0, 4) : null,
    faithfulnessScore: turnRecord.faithfulnessScore != null ? safeNumber(turnRecord.faithfulnessScore) : null,
    language: turnRecord.language ? String(turnRecord.language).slice(0, 8) : 'unknown',
  };

  RECORDS.push(r);
  if (RECORDS.length > MAX_RECORDS) RECORDS.splice(0, RECORDS.length - MAX_RECORDS);

  if (r.userId && r.primaryIntent) {
    const prev = PER_USER_LAST_INTENT.get(r.userId);
    if (prev && prev !== r.primaryIntent) {
      const key = `${prev}|${r.primaryIntent}`;
      TRANSITION_MATRIX.set(key, (TRANSITION_MATRIX.get(key) || 0) + 1);
    }
    PER_USER_LAST_INTENT.set(r.userId, r.primaryIntent);
  }

  return r;
}

function percentile(sortedNumbers, p) {
  if (!sortedNumbers.length) return 0;
  const rank = Math.min(sortedNumbers.length - 1, Math.max(0, Math.floor((p / 100) * sortedNumbers.length)));
  return sortedNumbers[rank];
}

function snapshot({ windowMs = null } = {}) {
  const cutoff = windowMs ? Date.now() - windowMs : 0;
  const slice = cutoff ? RECORDS.filter((r) => r.timestamp >= cutoff) : RECORDS;
  if (!slice.length) {
    return {
      count: 0,
      latency: { p50: 0, p90: 0, p99: 0, avg: 0 },
      intents: [],
      multiHopAvg: 0,
      planAvg: 0,
      conflictsTotal: 0,
      faithfulness: { avg: null, grades: {} },
      languages: {},
      topTransitions: [],
    };
  }

  const latencies = slice.map((r) => r.latencyMs).filter((x) => x > 0).sort((a, b) => a - b);
  const intents = {};
  const languages = {};
  const grades = {};
  let multiHopSum = 0;
  let planSum = 0;
  let conflictsTotal = 0;
  let faithfulnessSum = 0;
  let faithfulnessCount = 0;

  for (const r of slice) {
    if (r.primaryIntent) intents[r.primaryIntent] = (intents[r.primaryIntent] || 0) + 1;
    if (r.language) languages[r.language] = (languages[r.language] || 0) + 1;
    if (r.faithfulnessGrade) grades[r.faithfulnessGrade] = (grades[r.faithfulnessGrade] || 0) + 1;
    multiHopSum += r.multiHopDepth;
    planSum += r.planNodes;
    conflictsTotal += r.suppressionConflicts;
    if (r.faithfulnessScore != null) {
      faithfulnessSum += r.faithfulnessScore;
      faithfulnessCount += 1;
    }
  }

  const topIntents = Object.entries(intents)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const topTransitions = [...TRANSITION_MATRIX.entries()]
    .map(([k, count]) => {
      const [from, to] = k.split('|');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    count: slice.length,
    windowMs,
    latency: {
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p99: percentile(latencies, 99),
      avg: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    },
    intents: topIntents,
    multiHopAvg: Number((multiHopSum / slice.length).toFixed(2)),
    planAvg: Number((planSum / slice.length).toFixed(2)),
    conflictsTotal,
    faithfulness: {
      avg: faithfulnessCount ? Number((faithfulnessSum / faithfulnessCount).toFixed(2)) : null,
      grades,
      measured: faithfulnessCount,
    },
    languages,
    topTransitions,
  };
}

function reset() {
  RECORDS.length = 0;
  TRANSITION_MATRIX.clear();
  PER_USER_LAST_INTENT.clear();
}

function size() { return RECORDS.length; }

module.exports = {
  record,
  snapshot,
  reset,
  size,
  MAX_RECORDS,
};
