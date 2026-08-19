'use strict';

/**
 * attribution-explainer.js
 *
 * Human-readable "why I understood it this way" explainer on top of
 * `context-attribution-engine`. Given the same inputs the engine sees,
 * it produces a structured trace plus a markdown narrative that maps
 *   surface signals → concepts → intents → plan/hops/conflicts
 *
 * Inspired by Anthropic's circuit-tracing visualisations: their figures
 * walk you from input tokens through features to output logits. We do the
 * same thing at the orchestration layer — each step shows what was
 * detected, why, and which signal drove it. Useful for:
 *   - debugging misinterpretations ("why did you think I wanted X?")
 *   - building a UI panel that explains the assistant's mental model
 *   - prompt engineering audits (which constraints fire? which don't?)
 *
 * No LLM call. Pure transformation of the engine bundle.
 */

const engine = require('./context-attribution-engine');
const conceptExtractor = require('./concept-extractor');

function explain(input = {}) {
  const bundle = engine.analyze(input);

  const steps = [];

  // Step 1: language and modality.
  steps.push({
    step: 1,
    kind: 'language_detection',
    title: 'Detect language and modality',
    details: {
      language: bundle.language,
      modalityConcepts: bundle.concepts.filter((c) => c.type === 'modality').map((c) => ({ kind: c.kind, surface: c.surface })),
    },
    narrative: buildLanguageNarrative(bundle),
  });

  // Step 2: concept extraction.
  const grouped = groupConceptsByType(bundle.concepts);
  steps.push({
    step: 2,
    kind: 'concept_extraction',
    title: 'Extract concepts (features) from the prompt',
    details: { byType: grouped, total: bundle.concepts.length },
    narrative: buildConceptNarrative(grouped, bundle.concepts.length),
  });

  // Step 3: intent attribution.
  steps.push({
    step: 3,
    kind: 'intent_attribution',
    title: 'Attribute primary intent',
    details: {
      primary: bundle.attribution?.summary?.topIntents?.[0] || null,
      runnerUps: (bundle.attribution?.summary?.topIntents || []).slice(1, 3),
    },
    narrative: buildIntentNarrative(bundle.attribution?.summary),
  });

  // Step 4: multi-hop resolution.
  steps.push({
    step: 4,
    kind: 'multi_hop',
    title: 'Detect resolution hops',
    details: {
      depth: bundle.multiHop?.depth || 0,
      hops: bundle.multiHop?.hops || [],
    },
    narrative: buildHopNarrative(bundle.multiHop),
  });

  // Step 5: plan derivation.
  steps.push({
    step: 5,
    kind: 'planning',
    title: 'Decompose into execution plan',
    details: {
      planRequired: !!bundle.plan?.planRequired,
      nodes: bundle.plan?.nodes || [],
      reasoning: bundle.plan?.reasoning,
    },
    narrative: buildPlanNarrative(bundle.plan),
  });

  // Step 6: suppression / conflict detection.
  steps.push({
    step: 6,
    kind: 'suppression',
    title: 'Check for conflicts with prior user rules',
    details: {
      rules: bundle.suppression?.rules || [],
      conflicts: bundle.suppression?.conflicts || [],
    },
    narrative: buildSuppressionNarrative(bundle.suppression),
  });

  // Step 7: faithfulness, if a draft response was given.
  if (bundle.faithfulness) {
    steps.push({
      step: 7,
      kind: 'faithfulness',
      title: 'Score draft response faithfulness',
      details: {
        score: bundle.faithfulness.score,
        grade: bundle.faithfulness.grade,
        advisory: bundle.faithfulness.advisory,
        unsupportedCount: bundle.faithfulness.unsupported?.length || 0,
      },
      narrative: buildFaithfulnessNarrative(bundle.faithfulness),
    });
  }

  const narrative = steps.map((s) => `### ${s.step}. ${s.title}\n${s.narrative}`).join('\n\n');

  return {
    bundle,
    steps,
    narrative,
    summary: {
      language: bundle.language,
      primaryIntent: bundle.attribution?.summary?.topIntents?.[0]?.text || null,
      intentConfidence: bundle.attribution?.summary?.topIntents?.[0]?.weight ?? 0,
      conceptCount: bundle.concepts?.length || 0,
      multiHopDepth: bundle.multiHop?.depth || 0,
      planNodes: bundle.plan?.nodes?.length || 0,
      suppressionConflicts: bundle.suppression?.conflicts?.length || 0,
      faithfulness: bundle.faithfulness ? { score: bundle.faithfulness.score, grade: bundle.faithfulness.grade } : null,
      latencyMs: bundle.latencyMs,
    },
  };
}

// ── Per-step narrative renderers ───────────────────────────────────────────

function buildLanguageNarrative(bundle) {
  const lang = bundle.language || 'unknown';
  const mods = bundle.concepts.filter((c) => c.type === 'modality').map((c) => c.kind.replace('modality.', ''));
  const modStr = mods.length ? `(${mods.join(', ')})` : '(no modality cue)';
  return `Detected language: **${lang}**. Modality cues ${modStr}.`;
}

function buildConceptNarrative(grouped, total) {
  if (!total) return 'No concepts extracted — the prompt was empty or non-substantive.';
  const lines = [`Found **${total}** concept(s) across ${Object.keys(grouped).length} type(s):`];
  for (const [type, list] of Object.entries(grouped)) {
    const top = list.slice(0, 4).map((c) => `\`${c.surface}\` (w=${c.weight.toFixed(2)})`).join(', ');
    lines.push(`- **${type}**: ${list.length} → ${top}`);
  }
  return lines.join('\n');
}

function buildIntentNarrative(summary) {
  if (!summary || !summary.topIntents?.length) return 'No intent could be attributed — no actions or strong cues were detected.';
  const top = summary.topIntents[0];
  let out = `Primary intent: **${top.text}** with weight ${top.weight.toFixed(2)}.`;
  if (summary.topIntents.length > 1) {
    const runner = summary.topIntents[1];
    out += ` Runner-up: ${runner.text} (w=${runner.weight.toFixed(2)}).`;
  }
  if (summary.topContext?.length) {
    const ctxList = summary.topContext.slice(0, 3).map((c) => `${c.kind}(${c.influence})`).join(', ');
    out += ` Top-influence sources: ${ctxList}.`;
  }
  return out;
}

function buildHopNarrative(mh) {
  if (!mh || !mh.depth) return 'No multi-hop resolution needed — the prompt resolves to a single hop.';
  const lines = [`This prompt requires **${mh.depth}** resolution hop(s) before answering:`];
  for (const h of mh.hops) {
    lines.push(`- ${h.kind} (confidence ${Math.round(h.confidence * 100)}%): ${h.resolutionHint}`);
  }
  return lines.join('\n');
}

function buildPlanNarrative(plan) {
  if (!plan || !plan.planRequired) return 'No explicit plan needed — single deliverable, no sequencing markers.';
  const lines = [`Plan triggered: ${plan.reasoning}. ${plan.nodes.length} node(s):`];
  for (const n of plan.nodes) {
    lines.push(`- ${n.id} (${n.kind}${n.estCost ? `, cost=${n.estCost}` : ''}): ${n.label}`);
  }
  return lines.join('\n');
}

function buildSuppressionNarrative(s) {
  if (!s) return 'No suppression analysis performed.';
  if (!s.conflicts?.length) {
    const rcount = s.rules?.length || 0;
    return rcount
      ? `Found ${rcount} prior rule(s) but the current request is compatible with all of them.`
      : 'No prior user-defined rules detected.';
  }
  const lines = [`Detected **${s.conflicts.length}** conflict(s) with prior user rules:`];
  for (const c of s.conflicts) {
    lines.push(`- [${c.severity}] new request "${c.currentSurface}" vs rule "${c.ruleSurface}". → ${c.recommendation}`);
  }
  return lines.join('\n');
}

function buildFaithfulnessNarrative(f) {
  if (!f) return '';
  let line = `Draft scored **${f.score}** (grade ${f.grade}). ${f.advisory}`;
  if (f.unsupported?.length) {
    const counts = f.unsupported.reduce((acc, u) => { acc[u.kind] = (acc[u.kind] || 0) + 1; return acc; }, {});
    const breakdown = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ');
    line += ` Ungrounded by kind: ${breakdown}.`;
  }
  return line;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function groupConceptsByType(concepts = []) {
  const grouped = {};
  for (const c of [...concepts].sort((a, b) => b.weight - a.weight)) {
    if (!grouped[c.type]) grouped[c.type] = [];
    grouped[c.type].push(c);
  }
  return grouped;
}

/**
 * Convenience: explain a single concept's role in the current bundle.
 */
function explainConcept({ prompt = '', conceptSurface = '' } = {}) {
  const { concepts } = conceptExtractor.extractConcepts(prompt);
  const surfaceLower = conceptSurface.toLowerCase();
  const matches = concepts.filter((c) =>
    c.surface.toLowerCase().includes(surfaceLower) ||
    c.normalized.toLowerCase().includes(surfaceLower));
  if (!matches.length) return { found: false, narrative: `No concept matching "${conceptSurface}" was extracted from the prompt.` };
  const list = matches.map((c) => `[${c.type}/${c.kind}] surface="${c.surface}", normalized="${c.normalized}", weight=${c.weight.toFixed(2)}`);
  return {
    found: true,
    matches,
    narrative: `Found ${matches.length} concept match(es):\n${list.map((l) => `- ${l}`).join('\n')}`,
  };
}

module.exports = {
  explain,
  explainConcept,
};
