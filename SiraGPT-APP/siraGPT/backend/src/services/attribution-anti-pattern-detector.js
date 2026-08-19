'use strict';

/**
 * attribution-anti-pattern-detector.js
 *
 * Detects conversational anti-patterns the user might be stuck in:
 *
 *   - repetition_loop        — same intent + similar surface 3+ turns in a row
 *   - rephrase_oscillation   — user keeps rephrasing without progress
 *   - belief_thrashing       — same belief flipped (done ↔ regressed) 2+ times
 *   - escalating_urgency     — urgency markers ("ya", "ahora", "urgente") rising
 *   - context_drop_loop      — same anaphora ("eso", "this") with no resolution
 *
 * Surfaces a warning the AI route can use to break the loop: ask a
 * clarifying question, hand off to a human, or summarize what's been
 * tried so far.
 *
 * No LLM, no I/O. Pure pattern matching over the last N user turns.
 */

const conceptExtractor = require('./concept-extractor');

const MAX_LOOKBACK = 12;
const REPETITION_THRESHOLD = 3;
const OSCILLATION_THRESHOLD = 4;
const URGENCY_MARKERS = /\b(ya|ahora\s+mismo|urgente|por\s+favor|please|asap|now|right\s+now|hurry|de\s+una\s+vez|de\s+inmediato)\b/i;

function safeText(v) { return String(v == null ? '' : v).slice(0, 4000); }

function jaccard(setA, setB) {
  if (!setA.size && !setB.size) return 1;
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  if (!inter) return 0;
  return inter / (setA.size + setB.size - inter);
}

function detect({ history = [] } = {}) {
  const userTurns = (Array.isArray(history) ? history : [])
    .filter((t) => (t?.role || 'user') !== 'assistant')
    .slice(-MAX_LOOKBACK);
  if (userTurns.length < 2) return { hasAntipattern: false, patterns: [] };

  const conceptSnapshots = userTurns.map((t) => {
    const text = safeText(t?.content || t?.text || '');
    const { concepts } = conceptExtractor.extractConcepts(text);
    const action = concepts.find((c) => c.type === 'action')?.normalized || null;
    const surfaces = new Set(concepts.map((c) => `${c.type}/${c.normalized}`));
    return { text, action, surfaces, urgent: URGENCY_MARKERS.test(text) };
  });

  const patterns = [];

  // 1. Repetition loop — same action + jaccard >= 0.6 across last K turns.
  let repeatStreak = 1;
  for (let i = 1; i < conceptSnapshots.length; i++) {
    const cur = conceptSnapshots[i];
    const prev = conceptSnapshots[i - 1];
    const sim = jaccard(cur.surfaces, prev.surfaces);
    if (cur.action && cur.action === prev.action && sim >= 0.6) {
      repeatStreak += 1;
    } else {
      repeatStreak = 1;
    }
  }
  if (repeatStreak >= REPETITION_THRESHOLD) {
    patterns.push({
      kind: 'repetition_loop',
      severity: 'medium',
      detail: `Same intent repeated for the last ${repeatStreak} user turns without progress.`,
      recommendation: 'Reflect the loop back: confirm what has and hasn\'t been tried, ask what specifically is blocking the user.',
    });
  }

  // 2. Rephrase oscillation — repeated action across non-consecutive turns
  // with low jaccard overall.
  if (conceptSnapshots.length >= OSCILLATION_THRESHOLD) {
    const actions = conceptSnapshots.map((s) => s.action).filter(Boolean);
    const sameAction = actions.length >= OSCILLATION_THRESHOLD && actions.every((a) => a === actions[0]);
    if (sameAction) {
      // Compare pairwise jaccards.
      let lowSimPairs = 0;
      for (let i = 1; i < conceptSnapshots.length; i++) {
        const sim = jaccard(conceptSnapshots[i].surfaces, conceptSnapshots[i - 1].surfaces);
        if (sim < 0.5) lowSimPairs++;
      }
      if (lowSimPairs >= 2) {
        patterns.push({
          kind: 'rephrase_oscillation',
          severity: 'medium',
          detail: 'User keeps rephrasing the same goal with shifting surface details — suggests the model didn\'t catch the real intent.',
          recommendation: 'Echo the inferred intent back literally and ask the user to confirm or correct before producing another draft.',
        });
      }
    }
  }

  // 3. Escalating urgency.
  const urgencyByTurn = conceptSnapshots.map((s) => s.urgent ? 1 : 0);
  const recentUrgentCount = urgencyByTurn.slice(-3).reduce((a, b) => a + b, 0);
  if (recentUrgentCount >= 2 && urgencyByTurn.length >= 4 && urgencyByTurn.slice(0, -3).reduce((a, b) => a + b, 0) === 0) {
    patterns.push({
      kind: 'escalating_urgency',
      severity: 'high',
      detail: 'Urgency markers ("ya", "urgente", "now") appeared in the last 2-3 turns after being absent earlier.',
      recommendation: 'Acknowledge the urgency, give a concrete ETA or partial deliverable, and ask whether to skip nice-to-haves.',
    });
  }

  // 4. Context-drop loop — repeated unresolved anaphora.
  let anaphoraCount = 0;
  for (const s of conceptSnapshots) {
    if (/\b(?:eso|esto|aquello|that|this|lo\s+anterior|the\s+previous)\b/i.test(s.text)) anaphoraCount++;
  }
  if (anaphoraCount >= 3 && conceptSnapshots.length >= 4) {
    patterns.push({
      kind: 'context_drop_loop',
      severity: 'low',
      detail: `Anaphoric references ("eso", "this") appeared in ${anaphoraCount} of the last ${conceptSnapshots.length} turns — references may not be resolving.`,
      recommendation: 'Restate what "eso" refers to explicitly before answering, and ask the user to confirm.',
    });
  }

  return {
    hasAntipattern: patterns.length > 0,
    patterns,
    metrics: {
      turnsAnalyzed: userTurns.length,
      maxRepeatStreak: repeatStreak,
      urgentTurns: urgencyByTurn.reduce((a, b) => a + b, 0),
      anaphoraTurns: anaphoraCount,
    },
  };
}

function buildAntipatternBlock(result) {
  if (!result || !result.hasAntipattern) return '';
  const lines = ['## CONVERSATION ANTI-PATTERN ALERT'];
  for (const p of result.patterns) {
    lines.push(`- [${p.kind} · ${p.severity}] ${p.detail}`);
    lines.push(`  • Recommendation: ${p.recommendation}`);
  }
  return lines.join('\n');
}

module.exports = {
  detect,
  buildAntipatternBlock,
  MAX_LOOKBACK,
  REPETITION_THRESHOLD,
  OSCILLATION_THRESHOLD,
};
