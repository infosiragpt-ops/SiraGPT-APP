'use strict';

/**
 * Intent planner — forward planning of likely next steps.
 *
 * Inspired by the paper's "rabbit poetry" finding: the model precomputes
 * candidate end-of-line words and works backward to compose the line. We
 * do the analogous thing for user intent — given the current request,
 * predict what the user is *likely to want next* and what *prerequisites*
 * we should satisfy before answering, so the assistant can plan ahead
 * instead of producing a reactive one-shot answer.
 *
 * Two products:
 *   - prerequisites: things that must happen *before* the surface action
 *     can be satisfied (e.g. "fetch the URL first", "ask which framework")
 *   - nextSteps: things the user will probably ask for *after* the current
 *     turn (e.g. "they'll want tests", "they'll want a PR")
 */

const { FEATURE_CATEGORIES } = require('./feature-extractor');

const PREREQ_RULES = [
  {
    id: 'fetch-url-first',
    when: (ctx) => ctx.text && /https?:\/\//i.test(ctx.text),
    requirement: 'Fetch and parse the URL content before answering',
    rationale: 'Prompt contains a URL — the user expects you to read it, not guess at it.',
    weight: 0.9,
  },
  {
    id: 'ingest-attachments-first',
    when: (ctx) => ctx.attachments && ctx.attachments.length > 0,
    requirement: `Ingest and analyze the ${ctx => ctx.attachments.length} attached file(s) before responding`,
    rationale: 'Attached files should be read and summarized before reasoning over them.',
    weight: 0.95,
  },
  {
    id: 'disambiguate-target',
    when: (ctx) => ctx.actionLabels.has('modify') && !ctx.objectLabels.size,
    requirement: 'Clarify which file / module / component the modification targets',
    rationale: 'A modify-action with no object is ambiguous; ask before guessing.',
    weight: 0.7,
  },
  {
    id: 'check-test-baseline',
    when: (ctx) => ctx.actionLabels.has('execute') || ctx.actionLabels.has('modify'),
    requirement: 'Verify the existing test suite passes before making changes',
    rationale: 'Establishes a known-good baseline before introducing changes.',
    weight: 0.55,
  },
  {
    id: 'review-prior-context',
    when: (ctx) => ctx.actionLabels.has('continue') || ctx.references.some((r) => /backref/.test(r.label)),
    requirement: 'Re-read the relevant prior turns / context before continuing',
    rationale: 'Continue / back-reference requires prior context to be loaded.',
    weight: 0.85,
  },
  {
    id: 'security-scan-first',
    when: (ctx) => ctx.objectLabels.has('security') && (ctx.actionLabels.has('create') || ctx.actionLabels.has('modify')),
    requirement: 'Audit existing security posture before changing it',
    rationale: 'Security-touching changes need a baseline scan to avoid regressions.',
    weight: 0.8,
  },
  {
    id: 'check-db-schema',
    when: (ctx) => ctx.objectLabels.has('database') && (ctx.actionLabels.has('create') || ctx.actionLabels.has('modify')),
    requirement: 'Inspect current Prisma schema and pending migrations',
    rationale: 'Database changes risk breaking migrations if schema state is unknown.',
    weight: 0.75,
  },
  {
    id: 'language-aware-output',
    when: (ctx) => ctx.language === 'es' || ctx.langLabels.size > 0,
    requirement: 'Respond in Spanish to match user language',
    rationale: 'Maintain language coherence with the user — paper highlights language-independent reasoning but language-locked output.',
    weight: 0.6,
  },
];

const NEXT_STEP_RULES = [
  {
    id: 'next-test',
    when: (ctx) => (ctx.actionLabels.has('create') || ctx.actionLabels.has('modify')) && ctx.objectLabels.has('code-artifact'),
    prediction: 'Add tests covering the new/changed behavior',
    likelihood: 0.85,
  },
  {
    id: 'next-deploy',
    when: (ctx) => ctx.actionLabels.has('create') && (ctx.objectLabels.has('feature') || ctx.objectLabels.has('api-surface')),
    prediction: 'Deploy / release the new feature once tests pass',
    likelihood: 0.65,
  },
  {
    id: 'next-pr',
    when: (ctx) => ctx.actionLabels.has('modify') || ctx.actionLabels.has('create'),
    prediction: 'Open a pull request with the change set',
    likelihood: 0.55,
  },
  {
    id: 'next-document',
    when: (ctx) => ctx.actionLabels.has('create') && ctx.objectLabels.has('feature'),
    prediction: 'Document the new feature (README / CLAUDE.md / API docs)',
    likelihood: 0.6,
  },
  {
    id: 'next-followup-analysis',
    when: (ctx) => ctx.actionLabels.has('analyze'),
    prediction: 'Request a deeper drill-down on the most important finding',
    likelihood: 0.7,
  },
  {
    id: 'next-regenerate-with-variant',
    when: (ctx) => ctx.actionLabels.has('create') && ctx.objectLabels.has('visualization'),
    prediction: 'Ask for an alternative style / palette / layout',
    likelihood: 0.6,
  },
  {
    id: 'next-rollback-plan',
    when: (ctx) => ctx.actionLabels.has('execute') && (ctx.objectLabels.has('deployment') || ctx.objectLabels.has('database')),
    prediction: 'Confirm a rollback plan and a monitoring window',
    likelihood: 0.7,
  },
  {
    id: 'next-deepen-research',
    when: (ctx) => ctx.actionLabels.has('search') || ctx.actionLabels.has('explain'),
    prediction: 'Drill into a specific aspect of the explanation',
    likelihood: 0.65,
  },
  {
    id: 'next-translate-locale',
    when: (ctx) => ctx.actionLabels.has('translate'),
    prediction: 'Translate to another locale or run a back-translation review',
    likelihood: 0.55,
  },
  {
    id: 'next-cleanup-leftovers',
    when: (ctx) => ctx.actionLabels.has('remove') && ctx.objectLabels.has('code-artifact'),
    prediction: 'Clean up leftover imports, dead references and stale tests',
    likelihood: 0.7,
  },
];

function planContext(extraction, graph) {
  const features = extraction?.features || [];
  const ctx = {
    text: extraction?.text || '',
    language: extraction?.language || 'unknown',
    attachments: features.filter((f) => f.label === 'attached-file'),
    actionLabels: new Set(features.filter((f) => f.category === FEATURE_CATEGORIES.ACTION).map((f) => f.label)),
    objectLabels: new Set(features.filter((f) => f.category === FEATURE_CATEGORIES.OBJECT).map((f) => f.label)),
    modifierLabels: new Set(features.filter((f) => f.category === FEATURE_CATEGORIES.MODIFIER).map((f) => f.label)),
    constraintLabels: new Set(features.filter((f) => f.category === FEATURE_CATEGORIES.CONSTRAINT).map((f) => f.label)),
    references: features.filter((f) => f.category === FEATURE_CATEGORIES.REFERENCE),
    langLabels: new Set(features.filter((f) => f.category === FEATURE_CATEGORIES.LANGUAGE).map((f) => f.label)),
    graph,
  };
  return ctx;
}

function planAhead(extraction, graph) {
  const ctx = planContext(extraction, graph);
  const prerequisites = [];
  const nextSteps = [];

  for (const rule of PREREQ_RULES) {
    try {
      if (!rule.when(ctx)) continue;
      const requirement = typeof rule.requirement === 'function' ? rule.requirement(ctx) : rule.requirement;
      prerequisites.push({
        id: rule.id,
        requirement,
        rationale: rule.rationale,
        weight: rule.weight,
      });
    } catch { /* skip rule failure */ }
  }

  for (const rule of NEXT_STEP_RULES) {
    try {
      if (!rule.when(ctx)) continue;
      nextSteps.push({
        id: rule.id,
        prediction: rule.prediction,
        likelihood: rule.likelihood,
      });
    } catch { /* skip rule failure */ }
  }

  prerequisites.sort((a, b) => b.weight - a.weight);
  nextSteps.sort((a, b) => b.likelihood - a.likelihood);

  return {
    prerequisites: prerequisites.slice(0, 8),
    nextSteps: nextSteps.slice(0, 6),
  };
}

module.exports = { planAhead, PREREQ_RULES, NEXT_STEP_RULES };
