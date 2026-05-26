'use strict';

/**
 * Cross-turn intent tracker — detect conversation-level intent drift.
 *
 * The paper observes that features can persist or evolve across model
 * layers, with reasoning circuits chaining intermediate concepts. We
 * apply the same idea at the *conversation* level: intent features
 * detected in turn N either persist, evolve or get superseded in
 * turn N+1. Detecting drift (pivot to a different theme), repetition
 * (same intent over and over → user is frustrated something isn't
 * working), or accumulation (new constraints piling on) is useful to
 * help the assistant respond differently than turn-by-turn.
 *
 * Pure-local; takes the per-turn IntentReports and produces a
 * trajectory summary.
 */

const MAX_TURNS = 24;

const PIVOT_HINTS = [
  /\b(en realidad|actually|por cierto|btw|by the way|hablando de|speaking of|cambia(?:r|mos) de tema|change topic|otra cosa|something else|olv[ií]dalo|forget it|olvida lo anterior|forget previous)\b/i,
  /\b(empezar de cero|start over|reset|ahora ago|now do|en lugar de eso|instead of that)\b/i,
];

const REPETITION_HINTS = [
  /\b(otra vez|de nuevo|again|once more|todav[ií]a no|still not|yet again|sigue (?:igual|sin))\b/i,
];

function detectPivotInLatestPrompt(latestPrompt) {
  if (!latestPrompt) return false;
  return PIVOT_HINTS.some((p) => p.test(latestPrompt));
}

function detectRepetitionInLatestPrompt(latestPrompt) {
  if (!latestPrompt) return false;
  return REPETITION_HINTS.some((p) => p.test(latestPrompt));
}

function themeOverlap(prev, cur) {
  const a = new Set((prev.supernodes || []).map((s) => s.themeId));
  const b = new Set((cur.supernodes || []).map((s) => s.themeId));
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function classifyTransition(prev, cur, latestPrompt) {
  if (!prev) return { type: 'first-turn', confidence: 1 };
  if (detectPivotInLatestPrompt(latestPrompt)) {
    return { type: 'explicit-pivot', confidence: 0.95 };
  }
  if (detectRepetitionInLatestPrompt(latestPrompt)) {
    return { type: 'repetition', confidence: 0.9 };
  }
  const overlap = themeOverlap(prev, cur);
  if (overlap >= 0.75) return { type: 'continuation', confidence: 0.85 };
  if (overlap >= 0.4) return { type: 'evolution', confidence: 0.7 };
  if (overlap > 0) return { type: 'drift', confidence: 0.7 };
  return { type: 'topic-change', confidence: 0.6 };
}

function detectAccumulatedConstraints(history) {
  const seenConstraints = new Set();
  const accumulated = [];
  for (const report of history) {
    const cs = (report.features || [])
      .filter((f) => f.category === 'constraint')
      .map((f) => f.label);
    for (const c of cs) {
      if (!seenConstraints.has(c)) {
        seenConstraints.add(c);
        accumulated.push(c);
      }
    }
  }
  return accumulated;
}

function detectFrustrationStreak(history) {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const hi = history[i].hiddenIntents || [];
    if (hi.some((h) => h.id === 'frustration-from-prior-failure' || h.id === 'time-pressure')) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

function trackConversation(history, latestReport, latestPrompt) {
  const turns = Array.isArray(history) ? history.slice(-MAX_TURNS) : [];
  const prev = turns.length ? turns[turns.length - 1] : null;
  const transition = classifyTransition(prev, latestReport, latestPrompt);

  const fullHistory = [...turns, latestReport];
  const accumulatedConstraints = detectAccumulatedConstraints(fullHistory);
  const frustrationStreak = detectFrustrationStreak(fullHistory);

  // Theme persistence: themes appearing in N+ consecutive turns
  const themeCounts = new Map();
  for (const t of fullHistory.slice(-5)) {
    for (const sn of (t.supernodes || [])) {
      themeCounts.set(sn.themeId, (themeCounts.get(sn.themeId) || 0) + 1);
    }
  }
  const persistentThemes = [...themeCounts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([id]) => id);

  // Recommended response posture
  let posture;
  if (transition.type === 'explicit-pivot') {
    posture = 'reset-context-acknowledge-pivot';
  } else if (transition.type === 'repetition' && frustrationStreak >= 2) {
    posture = 'structural-rethink-different-approach';
  } else if (transition.type === 'continuation' && persistentThemes.length) {
    posture = 'maintain-context-build-on-prior';
  } else if (transition.type === 'evolution') {
    posture = 'connect-old-and-new-intent';
  } else if (transition.type === 'drift') {
    posture = 'note-shift-but-proceed';
  } else if (transition.type === 'topic-change') {
    posture = 'fresh-context-on-new-topic';
  } else {
    posture = 'standard-response';
  }

  return {
    ok: true,
    turnIndex: fullHistory.length,
    transition,
    accumulatedConstraints,
    persistentThemes,
    frustrationStreak,
    posture,
    recommendation: getPostureRecommendation(posture),
  };
}

function getPostureRecommendation(posture) {
  switch (posture) {
    case 'reset-context-acknowledge-pivot':
      return 'User has explicitly pivoted topics. Briefly acknowledge the switch, then proceed cleanly with the new request — don\'t carry over baggage from the prior thread.';
    case 'structural-rethink-different-approach':
      return 'User is repeating the same intent because prior responses didn\'t solve it. STOP iterating the same way. Propose a structurally different approach with the root-cause hypothesis stated up-front.';
    case 'maintain-context-build-on-prior':
      return 'User is continuing the same task. Build on prior context, reference earlier turn artifacts, don\'t re-explain established facts.';
    case 'connect-old-and-new-intent':
      return 'User has evolved the intent. Connect the new ask to the previous one explicitly so they see the continuity.';
    case 'note-shift-but-proceed':
      return 'Subtle topic shift. Briefly note the change in scope, then handle the new ask.';
    case 'fresh-context-on-new-topic':
      return 'Completely new topic. Treat as fresh context; don\'t bring in prior unrelated state.';
    default:
      return 'No special posture needed; respond normally.';
  }
}

function formatTrackerBlock(t) {
  if (!t || !t.ok) return '';
  const lines = [];
  lines.push('### Conversation trajectory');
  lines.push(`Turn #${t.turnIndex} · Transition: **${t.transition.type}** (${Math.round(t.transition.confidence * 100)}%)`);
  if (t.frustrationStreak >= 2) {
    lines.push(`⚠️ Frustration streak: ${t.frustrationStreak} consecutive turns of frustration/time-pressure signals.`);
  }
  if (t.persistentThemes.length) {
    lines.push(`Persistent themes (≥3 of last 5 turns): ${t.persistentThemes.join(', ')}`);
  }
  if (t.accumulatedConstraints.length) {
    lines.push(`Accumulated constraints across the conversation: ${t.accumulatedConstraints.slice(0, 6).join(', ')}`);
  }
  lines.push(`Recommended posture: **${t.posture}** — ${t.recommendation}`);
  return lines.join('\n');
}

module.exports = {
  trackConversation,
  formatTrackerBlock,
  classifyTransition,
  themeOverlap,
};
