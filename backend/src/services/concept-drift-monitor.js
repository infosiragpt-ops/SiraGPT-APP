'use strict';

/**
 * concept-drift-monitor.js
 *
 * Tracks how the dominant set of user concepts evolves across a chat
 * thread and surfaces a signal when a turn introduces a major topic
 * shift — the equivalent of a "task switch" in conversation.
 *
 * Inspired by the multilingual / cross-context circuit-tracing finding
 * that concepts are language-agnostic features that persist across many
 * tokens. We measure persistence at the orchestration layer: between two
 * consecutive turns, how much overlap is there in the active concept
 * set? Low overlap means the user switched topics; the orchestrator can
 * react (e.g., reset short-term context, refresh the plan, ask whether
 * the prior thread is closed).
 *
 * No persistence: a small ring buffer of recent concept snapshots is
 * kept per (userId, chatId). Memory-bounded by `MAX_SNAPSHOTS_PER_CHAT`.
 *
 * Public API:
 *   observe({userId, chatId, turnIndex, prompt}) → { drift, classification, snapshot }
 *   summarize({userId, chatId})                  → series summary
 *   buildDriftBlock(observation)                 → inert prompt block
 *   reset({userId, chatId})                      → wipes the chat trail
 */

const conceptExtractor = require('./concept-extractor');

const MAX_SNAPSHOTS_PER_CHAT = Number.parseInt(process.env.SIRAGPT_DRIFT_MAX_SNAPSHOTS || '32', 10);
const HARD_SHIFT_THRESHOLD = Number.parseFloat(process.env.SIRAGPT_DRIFT_HARD_SHIFT || '0.75');
const SOFT_SHIFT_THRESHOLD = Number.parseFloat(process.env.SIRAGPT_DRIFT_SOFT_SHIFT || '0.5');

const TRAIL = new Map(); // key -> Array<snapshot>

function key(userId, chatId) {
  return `${String(userId || 'anon')}:${String(chatId || 'default')}`;
}

function getTrail(userId, chatId, { createIfMissing = false } = {}) {
  const k = key(userId, chatId);
  let trail = TRAIL.get(k);
  if (!trail && createIfMissing) {
    trail = [];
    TRAIL.set(k, trail);
  }
  return trail;
}

// Volatile concept kinds: their normalized surface changes every turn
// even when the user is still on the same topic ("ai.js" vs "PDFs" vs
// "Login.tsx"), so we exclude them from the drift snapshot.
const VOLATILE_KINDS = new Set(['entity.named', 'entity.path']);

function snapshotFromConcepts(concepts = []) {
  // Pick the top concepts (by weight) and project them into a hashable set
  // keyed by `${type}/${normalized}`. Volatile entity surfaces are
  // excluded — they make the drift signal noisy without adding topic info.
  const stable = (concepts || []).filter((c) => !VOLATILE_KINDS.has(c.kind));
  const sorted = [...stable].sort((a, b) => b.weight - a.weight).slice(0, 25);
  return new Set(sorted.map((c) => `${c.type}/${c.normalized}`));
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersect = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) intersect += 1;
  if (!intersect) return 0;
  return intersect / (a.size + b.size - intersect);
}

function classifyDrift(distance) {
  if (distance >= HARD_SHIFT_THRESHOLD) return 'hard_shift';
  if (distance >= SOFT_SHIFT_THRESHOLD) return 'soft_shift';
  return 'continuation';
}

const ROLLING_WINDOW = Number.parseInt(process.env.SIRAGPT_DRIFT_WINDOW || '3', 10);

function unionOfRecentSnapshots(trail, k) {
  const recent = trail.slice(-Math.max(1, k));
  const out = new Set();
  for (const t of recent) for (const x of t.snapshot) out.add(x);
  return out;
}

function observe({ userId, chatId, turnIndex = 0, prompt = '' } = {}) {
  const trail = getTrail(userId, chatId, { createIfMissing: true });
  const { concepts, language } = conceptExtractor.extractConcepts(prompt, { source: 'turn' });
  const snapshot = snapshotFromConcepts(concepts);

  let drift = 0;
  let classification = 'baseline';
  if (trail.length) {
    // Compare against the rolling union of the last K snapshots so that
    // sparse single-turn concept sets don't trigger spurious shifts.
    const rolling = unionOfRecentSnapshots(trail, ROLLING_WINDOW);
    const similarity = jaccard(rolling, snapshot);
    drift = 1 - similarity;
    // Dampening: very small snapshots (<4 items each side) inflate Jaccard
    // distance. Pull the drift toward 0.5 proportionally to the sparsity
    // so we don't classify tiny turns as hard_shift on accident.
    const sparsity = Math.min(rolling.size, snapshot.size);
    if (sparsity > 0 && sparsity < 4) {
      const pull = (4 - sparsity) / 4; // 0.25..0.75
      drift = drift * (1 - pull * 0.6); // up to ~45% pull toward 0
    }
    classification = classifyDrift(drift);
  }

  const entry = {
    turnIndex,
    timestamp: Date.now(),
    snapshot,
    snapshotKeys: [...snapshot].slice(0, 20),
    language,
    drift,
    classification,
    rawConceptCount: concepts.length,
  };

  trail.push(entry);
  if (trail.length > MAX_SNAPSHOTS_PER_CHAT) trail.splice(0, trail.length - MAX_SNAPSHOTS_PER_CHAT);
  persistSoon(userId, chatId);

  const newConcepts = diffNewConcepts(trail);
  const lostConcepts = diffLostConcepts(trail);

  return {
    drift: Number(drift.toFixed(3)),
    classification,
    snapshot: entry.snapshotKeys,
    snapshotSize: entry.snapshot.size,
    newConcepts,
    lostConcepts,
    history: trail.length,
    language,
  };
}

function diffNewConcepts(trail) {
  if (trail.length < 2) return [];
  const cur = trail[trail.length - 1].snapshot;
  const prev = trail[trail.length - 2].snapshot;
  return [...cur].filter((c) => !prev.has(c)).slice(0, 10);
}

function diffLostConcepts(trail) {
  if (trail.length < 2) return [];
  const cur = trail[trail.length - 1].snapshot;
  const prev = trail[trail.length - 2].snapshot;
  return [...prev].filter((c) => !cur.has(c)).slice(0, 10);
}

function summarize({ userId, chatId } = {}) {
  const trail = getTrail(userId, chatId) || [];
  if (!trail.length) return { observations: 0, avgDrift: 0, peakDrift: 0, shifts: 0 };
  const drifts = trail.map((s) => s.drift).filter((d) => d > 0);
  const avg = drifts.length ? drifts.reduce((a, b) => a + b, 0) / drifts.length : 0;
  const peak = drifts.length ? Math.max(...drifts) : 0;
  const shifts = trail.filter((s) => s.classification === 'hard_shift').length;
  const softShifts = trail.filter((s) => s.classification === 'soft_shift').length;
  return {
    observations: trail.length,
    avgDrift: Number(avg.toFixed(3)),
    peakDrift: Number(peak.toFixed(3)),
    hardShifts: shifts,
    softShifts,
    languageDistribution: trail.reduce((acc, s) => {
      acc[s.language] = (acc[s.language] || 0) + 1;
      return acc;
    }, {}),
  };
}

function buildDriftBlock(observation) {
  if (!observation) return '';
  if (observation.classification === 'baseline') return '';
  if (observation.classification === 'continuation') return '';
  const lines = [];
  lines.push('## TOPIC DRIFT DETECTED');
  lines.push(`Classification: **${observation.classification}** (drift=${observation.drift}). The current turn introduces ${observation.newConcepts.length} new concept(s) and drops ${observation.lostConcepts.length} from the prior turn.`);
  if (observation.newConcepts.length) {
    lines.push(`- New concepts: ${observation.newConcepts.join(', ')}`);
  }
  if (observation.lostConcepts.length) {
    lines.push(`- Dropped concepts: ${observation.lostConcepts.join(', ')}`);
  }
  if (observation.classification === 'hard_shift') {
    lines.push('- Action: confirm whether the prior task is closed before continuing; consider starting a fresh sub-plan.');
  } else {
    lines.push('- Action: keep prior context but weight the new concepts higher in the next response.');
  }
  return lines.join('\n');
}

// HYDRATED + persistence are optional — present when the persistence
// wiring is loaded, undefined otherwise. We reference them defensively so
// _reset / reset never throw when the wiring isn't active.
const _HYDRATED = typeof HYDRATED !== 'undefined' ? HYDRATED : new Set();
const _persistence = typeof persistence !== 'undefined' ? persistence : null;

function reset({ userId, chatId } = {}) {
  const k = key(userId, chatId);
  const trail = TRAIL.get(k);
  if (!trail) return { cleared: 0 };
  const n = trail.length;
  TRAIL.delete(k);
  if (_HYDRATED) _HYDRATED.delete(k);
  if (_persistence) _persistence.remove('drift', k);
  return { cleared: n };
}

function _reset() { TRAIL.clear(); if (_HYDRATED) _HYDRATED.clear(); }

module.exports = {
  observe,
  summarize,
  buildDriftBlock,
  reset,
  _reset,
  HARD_SHIFT_THRESHOLD,
  SOFT_SHIFT_THRESHOLD,
  MAX_SNAPSHOTS_PER_CHAT,
};
