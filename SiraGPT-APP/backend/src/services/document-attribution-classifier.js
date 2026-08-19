'use strict';

/**
 * document-attribution-classifier.js
 *
 * Classifies what a user wants done with a specific document by running
 * the attribution suite on a synthesized "doc-aware" prompt. Returns a
 * structured plan that the document pipeline can route on.
 *
 * Pure orchestration over attribution-suite + concept extractor.
 * No I/O, no LLM.
 */

const conceptExtractor = require('./concept-extractor');
const suite = require('./attribution-suite');
const skillRecommender = require('./attribution-skill-recommender');
const intentPlanner = require('./intent-planner');

const DEFAULT_PROMPT_TEMPLATE = (docName) =>
  `Analiza el documento ${docName}. ¿Resumir, extraer, comparar, analizar, aprobar o generar contenido derivado?`;

const ACTION_TO_PRIMARY = {
  analyze: 'analyze',
  summarize: 'summarize',
  search: 'search',
  explain: 'analyze',
  create: 'generate_derived',
  modify: 'modify',
  document: 'generate_derived',
  test: 'verify',
  plan: 'plan',
  translate: 'translate',
};

function synthesizeDocAwarePrompt({ doc, userPrompt }) {
  const docName = doc?.name || 'el documento';
  const docPrefix = doc?.summary
    ? `(Documento: ${docName} — resumen: ${doc.summary.slice(0, 200)})`
    : `(Documento: ${docName})`;
  const prompt = userPrompt && String(userPrompt).trim()
    ? String(userPrompt).trim()
    : DEFAULT_PROMPT_TEMPLATE(docName);
  return `${docPrefix}\n\n${prompt}`;
}

function classify({ doc = {}, userPrompt = '', history = [], userId = null, chatId = null } = {}) {
  const synth = synthesizeDocAwarePrompt({ doc, userPrompt });
  const bundle = suite.run({
    userId,
    chatId,
    turnIndex: 0,
    prompt: synth,
    history,
    files: doc?.name ? [{ name: doc.name, mimeType: doc.mimeType, summary: doc.summary }] : [],
  });

  // Extract concepts from the USER prompt only (not the synthesized one)
  // so the doc-name prefix doesn't contribute spurious 'analyze' weight.
  const conceptSource = userPrompt && String(userPrompt).trim() ? String(userPrompt).trim() : synth;
  const { concepts } = conceptExtractor.extractConcepts(conceptSource);
  const actions = concepts.filter((c) => c.type === 'action').map((c) => c.normalized);
  const primaryAction = actions.length
    ? (ACTION_TO_PRIMARY[actions[0]] || actions[0])
    : 'analyze';

  const skill = skillRecommender.recommend({ prompt: synth, engineBundle: bundle.engine });
  const plan = intentPlanner.buildPlan({ prompt: synth, files: [doc] });
  const deliverables = (plan.deliverables || []).map((d) => d.kind);
  const constraints = (bundle.engine?.suppression?.rules || []).map((r) => ({ target: r.target, surface: r.surface }));
  const suggestions = [];
  if (!userPrompt || !String(userPrompt).trim()) {
    suggestions.push('No explicit instruction given for the document — defaulting to an analysis request.');
  }
  if (bundle.verdict !== 'allow') {
    suggestions.push(`Safety verdict: ${bundle.verdict}. ${bundle.safety?.recommendation || ''}`);
  }
  if (bundle.engine?.suppression?.hasConflicts) {
    suggestions.push(`Detected ${bundle.engine.suppression.conflicts.length} conflict(s) with prior user rules. Confirm before acting.`);
  }
  if (bundle.engine?.multiHop?.depth > 0) {
    suggestions.push(`Multi-hop depth ${bundle.engine.multiHop.depth} — resolve referents in the prompt before processing.`);
  }

  return {
    docName: doc?.name || null,
    synthPrompt: synth,
    verdict: bundle.verdict,
    primaryAction,
    confidence: bundle.telemetry?.faithfulnessGrade || null,
    recommendedSkill: skill.primary,
    alternatives: skill.alternatives,
    deliverables,
    constraints,
    suggestions,
    metrics: {
      multiHopDepth: bundle.engine?.multiHop?.depth || 0,
      planNodes: plan.nodes?.length || 0,
      conflicts: bundle.engine?.suppression?.conflicts?.length || 0,
      driftClass: bundle.telemetry?.driftClass || 'baseline',
      latencyMs: bundle.telemetry?.latencyMs || 0,
    },
  };
}

function buildClassifierBlock(result) {
  if (!result) return '';
  const lines = ['## DOC ATTRIBUTION CLASSIFICATION'];
  lines.push(`Document: ${result.docName || '(unnamed)'}`);
  lines.push(`Primary action: **${result.primaryAction}** (verdict ${result.verdict})`);
  if (result.recommendedSkill) {
    lines.push(`Suggested route: ${result.recommendedSkill.id} — ${result.recommendedSkill.rationale}`);
  }
  if (result.deliverables.length) lines.push(`Deliverables: ${result.deliverables.join(', ')}`);
  if (result.constraints.length) {
    lines.push('Constraints in scope:');
    for (const c of result.constraints.slice(0, 4)) lines.push(`  - [${c.target}] ${c.surface}`);
  }
  if (result.suggestions.length) {
    lines.push('Suggestions:');
    for (const s of result.suggestions) lines.push(`  - ${s}`);
  }
  return lines.join('\n');
}

module.exports = {
  classify,
  buildClassifierBlock,
  synthesizeDocAwarePrompt,
  ACTION_TO_PRIMARY,
};
