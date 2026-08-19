'use strict';

/**
 * attribution-conversation-summary.js
 *
 * Generates a structured summary of an entire chat using the outputs of
 * the attribution stack (engine + entity tracker + drift monitor + belief
 * tracker + concept similarity). The summary is the "what does the
 * system understand about this conversation?" view — useful as:
 *
 *   - a sidebar in the chat UI ("Conversation insights")
 *   - the seed for an automated chat title / TL;DR
 *   - a digest for stakeholder updates ("daily chat synopsis")
 *   - input for cross-chat retrieval (similar chats by intent profile)
 *
 * No LLM call. Pure aggregation of existing in-memory state plus an
 * optional one-pass scan over the chat history for turn-points where
 * intent / topic / belief shifts happened.
 */

const conceptExtractor = require('./concept-extractor');
const conceptSim = require('./concept-similarity');
const entityTracker = require('./cross-turn-entity-tracker');
const entityUnifier = require('./cross-language-entity-unifier');
const driftMonitor = require('./concept-drift-monitor');
const beliefTracker = require('./belief-state-tracker');

const MAX_TURNS = 60;
const MAX_TURN_POINTS = 8;

function safeText(v) { return String(v == null ? '' : v).slice(0, 4000); }

function buildSummary({
  userId = null,
  chatId = null,
  history = [],
} = {}) {
  const turns = Array.isArray(history) ? history.slice(-MAX_TURNS) : [];
  const userTurns = turns.filter((t) => (t?.role || 'user') !== 'assistant');

  // 1. Per-turn quick concept scan to surface dominant intents + supernodes.
  const allConcepts = [];
  for (const t of userTurns) {
    const { concepts } = conceptExtractor.extractConcepts(safeText(t?.content || t?.text || ''), { source: 'turn' });
    for (const c of concepts) allConcepts.push(c);
  }
  const clusters = conceptSim.cluster(allConcepts).slice(0, 8);
  const intents = allConcepts.filter((c) => c.type === 'action').slice(0, 5);
  const goals = allConcepts.filter((c) => c.type === 'goal').slice(0, 5);

  // 2. Entity sample + cross-language clusters (from registry).
  const entities = userId && chatId ? entityTracker.listEntities({ userId, chatId, limit: 12 }) : [];
  const entityClusters = userId && chatId ? entityUnifier.unify({ userId, chatId, limit: 6 }) : [];

  // 3. Drift summary.
  const drift = userId && chatId ? driftMonitor.summarize({ userId, chatId }) : { observations: 0 };

  // 4. Belief snapshot.
  const beliefs = userId && chatId ? beliefTracker.list({ userId, chatId, limit: 10 }) : [];
  const activeBeliefs = beliefs.filter((b) => !b.contradictedAt);
  const contradictedBeliefs = beliefs.filter((b) => b.contradictedAt);

  // 5. Turn points — single pass diffing concepts between consecutive
  // user turns to detect where intent or topic flips.
  const turnPoints = [];
  let prevConcepts = new Set();
  let prevAction = null;
  userTurns.forEach((t, idx) => {
    const text = safeText(t?.content || t?.text || '');
    if (!text.trim()) return;
    const { concepts } = conceptExtractor.extractConcepts(text);
    const curConcepts = new Set(concepts.map((c) => `${c.type}/${c.normalized}`));
    const action = concepts.find((c) => c.type === 'action');
    if (idx > 0 && prevConcepts.size && curConcepts.size) {
      let inter = 0;
      for (const x of prevConcepts) if (curConcepts.has(x)) inter += 1;
      const union = new Set([...prevConcepts, ...curConcepts]).size;
      const jaccard = inter / Math.max(1, union);
      const drifted = jaccard < 0.4;
      const intentChange = action && prevAction && action.normalized !== prevAction.normalized;
      if (drifted || intentChange) {
        turnPoints.push({
          turn: idx + 1,
          surface: text.slice(0, 140),
          jaccard: Number(jaccard.toFixed(2)),
          intentChange: intentChange ? `${prevAction.normalized} → ${action.normalized}` : null,
        });
      }
    }
    prevConcepts = curConcepts;
    prevAction = action || prevAction;
    if (turnPoints.length >= MAX_TURN_POINTS) return;
  });

  return {
    chatId,
    userId,
    turnsAnalyzed: userTurns.length,
    dominantSupernodes: clusters.map((c) => ({
      canonical: c.canonical,
      weight: Number(c.weight.toFixed(2)),
      mentions: c.members.length,
    })),
    primaryIntents: intents.map((i) => ({ surface: i.surface, normalized: i.normalized, weight: i.weight })),
    statedGoals: goals.map((g) => ({ surface: g.surface, weight: g.weight })),
    entities: entities.map((e) => ({
      canonical: e.canonicalSurface,
      kind: e.kind,
      mentions: e.mentions,
      firstSeenTurn: e.firstSeenTurn,
    })),
    crossLanguageClusters: entityClusters.map((c) => ({
      canonical: c.canonical,
      kind: c.kind,
      surfaces: c.surfaces,
      mentions: c.mentions,
    })),
    drift,
    activeBeliefs: activeBeliefs.map((b) => ({ subject: b.subject, status: b.status, strength: b.currentStrength })),
    contradictedBeliefs: contradictedBeliefs.map((b) => ({ subject: b.subject, status: b.status })),
    turnPoints,
  };
}

function renderMarkdown(summary) {
  if (!summary) return '';
  const lines = ['# Conversation insights', `Turns analyzed: ${summary.turnsAnalyzed}`];
  if (summary.dominantSupernodes.length) {
    lines.push('', '## Dominant concepts');
    for (const s of summary.dominantSupernodes) lines.push(`- **${s.canonical}** (weight ${s.weight}, ${s.mentions} member(s))`);
  }
  if (summary.primaryIntents.length) {
    lines.push('', '## Primary intents');
    for (const i of summary.primaryIntents) lines.push(`- ${i.surface} → ${i.normalized}`);
  }
  if (summary.statedGoals.length) {
    lines.push('', '## Stated goals');
    for (const g of summary.statedGoals) lines.push(`- ${g.surface}`);
  }
  if (summary.entities.length) {
    lines.push('', '## Top entities');
    for (const e of summary.entities.slice(0, 6)) lines.push(`- **${e.canonical}** [${e.kind}] — ${e.mentions} mention(s), first at turn ${e.firstSeenTurn + 1}`);
  }
  if (summary.activeBeliefs.length) {
    lines.push('', '## Active beliefs');
    for (const b of summary.activeBeliefs) lines.push(`- ${b.subject} → **${b.status}** (strength ${b.strength})`);
  }
  if (summary.contradictedBeliefs.length) {
    lines.push('', '## Contradicted beliefs');
    for (const b of summary.contradictedBeliefs) lines.push(`- ${b.subject} → ${b.status} (no longer true)`);
  }
  if (summary.turnPoints.length) {
    lines.push('', '## Turn points');
    for (const tp of summary.turnPoints) {
      const change = tp.intentChange ? ` [intent ${tp.intentChange}]` : '';
      lines.push(`- Turn ${tp.turn} (jaccard=${tp.jaccard})${change}: ${tp.surface}`);
    }
  }
  if (summary.drift && summary.drift.observations) {
    lines.push('', `## Drift profile`);
    lines.push(`- Observations: ${summary.drift.observations}`);
    lines.push(`- Avg drift: ${summary.drift.avgDrift}, peak ${summary.drift.peakDrift}`);
    if (summary.drift.hardShifts) lines.push(`- Hard shifts: ${summary.drift.hardShifts}`);
    if (summary.drift.softShifts) lines.push(`- Soft shifts: ${summary.drift.softShifts}`);
  }
  return lines.join('\n');
}

module.exports = {
  buildSummary,
  renderMarkdown,
};
