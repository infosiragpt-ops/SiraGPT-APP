'use strict';

/**
 * Counterfactual analyzer — paper's intervention experiments, applied to intent.
 *
 * The attribution-graphs paper validates feature interpretations via
 * *interventions*: suppress a feature, see what changes downstream. If
 * Texas activations were suppressed, Austin predictions dropped — proving
 * the Texas feature was causally upstream.
 *
 * We do the user-intent analogue: for each plausible alternative
 * interpretation of the user's request, recompute what the prerequisites,
 * next-steps and dominant theme would look like, and flag whether the
 * model's response should *materially differ* between interpretations.
 *
 * High divergence ⇒ the assistant should ask a clarifying question or
 * present both options. Low divergence ⇒ the assistant can proceed without
 * worrying about misinterpreting.
 *
 * Pure local, no LLM call, ~5 ms.
 */

const { planAhead } = require('./intent-planner');
const { FEATURE_CATEGORIES } = require('./feature-extractor');

const MAX_ALTERNATIVES = 4;

/**
 * Construct counterfactual extractions by suppressing or boosting specific
 * actions / objects, then re-run the planner to see how the plan diverges.
 */
function generateAlternatives(report) {
  if (!report || report.empty) return [];

  const features = report.features || [];
  const actions = features.filter((f) => f.category === FEATURE_CATEGORIES.ACTION);
  const objects = features.filter((f) => f.category === FEATURE_CATEGORIES.OBJECT);

  // Baseline: top action + top object
  const topAction = actions[0];
  const topObject = objects[0];
  if (!topAction) return [];

  const alternatives = [];

  // Alt 1: suppress top action, see what happens with the second action
  if (actions.length >= 2) {
    alternatives.push({
      id: 'suppress-top-action',
      label: `What if user meant "${actions[1].label}" instead of "${topAction.label}"?`,
      modifiedExtraction: {
        ...report,
        features: features.filter((f) => f.id !== topAction.id),
      },
    });
  }

  // Alt 2: suppress top object, see what happens with second object
  if (objects.length >= 2) {
    alternatives.push({
      id: 'suppress-top-object',
      label: `What if user meant "${objects[1].label}" instead of "${topObject.label}"?`,
      modifiedExtraction: {
        ...report,
        features: features.filter((f) => f.id !== topObject.id),
      },
    });
  }

  // Alt 3: flip implicit features — what if they DIDN'T want tests / pre-flight?
  const implicits = features.filter((f) => f.category === FEATURE_CATEGORIES.IMPLICIT);
  if (implicits.length) {
    alternatives.push({
      id: 'suppress-implicit',
      label: 'What if user wanted ONLY what they explicitly asked, no inferred extras?',
      modifiedExtraction: {
        ...report,
        features: features.filter((f) => f.category !== FEATURE_CATEGORIES.IMPLICIT),
      },
    });
  }

  // Alt 4: opposite scope — if scope-narrow, try scope-full; if scope-full, try scope-narrow
  const modifiers = features.filter((f) => f.category === FEATURE_CATEGORIES.MODIFIER);
  const hasNarrow = modifiers.some((m) => m.label === 'scope-narrow');
  const hasFull = modifiers.some((m) => m.label === 'scope-full');
  if (hasNarrow || hasFull) {
    alternatives.push({
      id: 'flip-scope',
      label: hasNarrow
        ? 'What if user actually wants a comprehensive answer, not a narrow one?'
        : 'What if user actually wants a minimal answer, not the full thing?',
      modifiedExtraction: {
        ...report,
        features: features.filter((m) =>
          m.label !== (hasNarrow ? 'scope-narrow' : 'scope-full')
        ),
      },
    });
  }

  return alternatives.slice(0, MAX_ALTERNATIVES);
}

function planDiff(basePlan, altPlan) {
  const baseIds = new Set(basePlan.prerequisites.map((p) => p.id));
  const baseNextIds = new Set(basePlan.nextSteps.map((n) => n.id));
  const altIds = new Set(altPlan.prerequisites.map((p) => p.id));
  const altNextIds = new Set(altPlan.nextSteps.map((n) => n.id));

  const addedPrereqs = altPlan.prerequisites.filter((p) => !baseIds.has(p.id));
  const removedPrereqs = basePlan.prerequisites.filter((p) => !altIds.has(p.id));
  const addedNext = altPlan.nextSteps.filter((n) => !baseNextIds.has(n.id));
  const removedNext = basePlan.nextSteps.filter((n) => !altNextIds.has(n.id));

  const totalDiff = addedPrereqs.length + removedPrereqs.length + addedNext.length + removedNext.length;
  return {
    addedPrereqs: addedPrereqs.map((p) => p.id),
    removedPrereqs: removedPrereqs.map((p) => p.id),
    addedNextSteps: addedNext.map((n) => n.id),
    removedNextSteps: removedNext.map((n) => n.id),
    divergence: totalDiff,
  };
}

function analyzeCounterfactuals(report) {
  if (!report || report.empty) {
    return { ok: true, alternatives: [], maxDivergence: 0, recommendation: 'no-input' };
  }

  const basePlan = report.plan || { prerequisites: [], nextSteps: [] };
  const alternatives = generateAlternatives(report);

  const analyzed = alternatives.map((alt) => {
    const altPlan = planAhead({
      features: alt.modifiedExtraction.features,
      text: report.prompt || '',
      language: report.language,
    }, null);
    const diff = planDiff(basePlan, altPlan);
    return {
      id: alt.id,
      label: alt.label,
      diff,
      altPlan: {
        prerequisites: altPlan.prerequisites.map((p) => p.id),
        nextSteps: altPlan.nextSteps.map((n) => n.id),
      },
    };
  });

  const maxDivergence = analyzed.length ? Math.max(...analyzed.map((a) => a.diff.divergence)) : 0;
  const totalDivergence = analyzed.reduce((acc, a) => acc + a.diff.divergence, 0);
  const avgDivergence = analyzed.length ? totalDivergence / analyzed.length : 0;

  // Recommendation logic
  let recommendation;
  if (maxDivergence === 0) {
    recommendation = 'safe-to-proceed';
  } else if (maxDivergence <= 2) {
    recommendation = 'minor-divergence-state-assumption';
  } else if (maxDivergence <= 5) {
    recommendation = 'moderate-divergence-flag-assumption';
  } else {
    recommendation = 'high-divergence-ask-clarification';
  }

  return {
    ok: true,
    alternatives: analyzed,
    maxDivergence,
    avgDivergence: +avgDivergence.toFixed(2),
    recommendation,
  };
}

/**
 * Compact textual rendering of counterfactual results suitable for
 * including in a system prompt block.
 */
function formatCounterfactualBlock(cf) {
  if (!cf || !cf.alternatives?.length) return '';
  const lines = [];
  lines.push('### Counterfactual interpretations');
  lines.push(`_Max divergence: ${cf.maxDivergence} · Avg: ${cf.avgDivergence} · Recommendation: **${cf.recommendation}**_`);
  for (const alt of cf.alternatives.slice(0, 3)) {
    if (alt.diff.divergence === 0) continue;
    lines.push(`- ${alt.label}`);
    if (alt.diff.addedPrereqs.length) lines.push(`  - **+prereqs**: ${alt.diff.addedPrereqs.join(', ')}`);
    if (alt.diff.removedPrereqs.length) lines.push(`  - **-prereqs**: ${alt.diff.removedPrereqs.join(', ')}`);
    if (alt.diff.addedNextSteps.length) lines.push(`  - **+next**: ${alt.diff.addedNextSteps.join(', ')}`);
    if (alt.diff.removedNextSteps.length) lines.push(`  - **-next**: ${alt.diff.removedNextSteps.join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = {
  analyzeCounterfactuals,
  formatCounterfactualBlock,
  generateAlternatives,
  planDiff,
};
