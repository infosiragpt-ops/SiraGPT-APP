'use strict';

/**
 * attribution-prompt-quality-scorer.js
 *
 * Scores how well-specified a prompt is (0–1) and returns concrete
 * suggestions to improve it. Useful for UI nudges before send, for
 * prompt-engineering audits, and as a heuristic gate that asks for
 * clarification on very low-quality prompts before invoking the full
 * pipeline.
 *
 * Signals scored:
 *   - has a clear action verb (create/fix/analyze/...)
 *   - has a target entity (file, code, document, business object)
 *   - acceptable length (not too short, not too long)
 *   - acceptable specificity (named entities, paths, quantities)
 *   - no unresolved anaphora ("eso", "this") without context
 *   - no overload (multiple distinct intents in one prompt)
 *   - language identified (not 'unknown')
 *
 * Output:
 *   {
 *     score, grade,
 *     dimensions: { actionClarity, targetClarity, length, specificity,
 *                   anaphora, overload, language },
 *     suggestions: [string, ...]
 *   }
 *
 * No LLM, no I/O.
 */

const conceptExtractor = require('./concept-extractor');

const MIN_LENGTH = 8;
const MAX_LENGTH = 1200;
const TOO_SHORT = 16;
const TOO_LONG = 800;

function safeText(v) { return String(v == null ? '' : v).slice(0, 4000); }

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function gradeFromScore(s) {
  if (s >= 0.85) return 'A';
  if (s >= 0.7) return 'B';
  if (s >= 0.55) return 'C';
  if (s >= 0.35) return 'D';
  return 'F';
}

function score({ prompt = '' } = {}) {
  const text = safeText(prompt);
  if (!text.trim()) {
    return {
      score: 0,
      grade: 'F',
      dimensions: { actionClarity: 0, targetClarity: 0, length: 0, specificity: 0, anaphora: 1, overload: 1, language: 0 },
      suggestions: ['Prompt is empty — write at least one full sentence describing what you want.'],
    };
  }

  const { concepts, language } = conceptExtractor.extractConcepts(text);
  const actions = concepts.filter((c) => c.type === 'action');
  const entities = concepts.filter((c) => c.type === 'entity');
  const refs = concepts.filter((c) => c.type === 'reference');
  const namedEntities = concepts.filter((c) => c.kind === 'entity.named');
  const paths = concepts.filter((c) => c.kind === 'entity.path');

  // Dimension scoring.
  const actionClarity = actions.length === 0 ? 0
    : actions.length === 1 ? 1
    : actions.length === 2 ? 0.7
    : 0.4; // many actions = overloaded
  const targetClarity = entities.length === 0 ? 0
    : entities.length >= 1 && entities.length <= 4 ? 1
    : 0.6;
  const length = text.length < MIN_LENGTH ? 0
    : text.length < TOO_SHORT ? 0.5
    : text.length <= TOO_LONG ? 1
    : text.length <= MAX_LENGTH ? 0.7
    : 0.3;
  const specificity = (() => {
    const hasNumeric = /\b\d{2,}\b/.test(text);
    const hasNamedOrPath = namedEntities.length + paths.length;
    let s = 0;
    if (hasNamedOrPath >= 1) s += 0.5;
    if (hasNamedOrPath >= 3) s += 0.2;
    if (hasNumeric) s += 0.3;
    return clamp01(s);
  })();
  // Anaphora hurts unless prior history would resolve it; without history
  // context we assume bare prompts.
  const anaphora = refs.length === 0 ? 1
    : refs.length === 1 ? 0.5
    : 0.2;
  const overload = actions.length <= 1 ? 1
    : actions.length === 2 ? 0.7
    : 0.3;
  const languageScore = language === 'unknown' ? 0.5 : 1;

  const dimensions = { actionClarity, targetClarity, length, specificity, anaphora, overload, language: languageScore };

  // Weighted aggregate.
  const total =
    0.25 * actionClarity +
    0.20 * targetClarity +
    0.10 * length +
    0.15 * specificity +
    0.15 * anaphora +
    0.10 * overload +
    0.05 * languageScore;

  const finalScore = Number(clamp01(total).toFixed(3));
  const grade = gradeFromScore(finalScore);

  const suggestions = [];
  if (actionClarity === 0) suggestions.push('Add a clear action verb (create, fix, analyze, deploy, etc.) at the start of the prompt.');
  if (actionClarity < 0.5) suggestions.push(`You have ${actions.length} action verbs — split the request into separate prompts or pick the primary one.`);
  if (targetClarity === 0) suggestions.push('Name the target (the file, the document, the customer) instead of leaving it implicit.');
  if (length === 0) suggestions.push('Prompt is too short to convey intent — add at least one full sentence.');
  if (length < 0.7) suggestions.push('Add a bit more detail about the expected outcome / constraints.');
  if (specificity < 0.5) suggestions.push('Add at least one specific marker: a filename, a number, a named entity, or a precise quantity.');
  if (anaphora < 1) suggestions.push('Anaphoric reference ("eso", "this") without context will force the model to guess — name the referent explicitly.');
  if (overload < 1) suggestions.push(`The prompt mixes ${actions.length} distinct actions — break them into separate turns so each gets full attention.`);
  if (languageScore < 1) suggestions.push('The language of the prompt is ambiguous — pick one (Spanish or English) for clearer results.');

  return {
    score: finalScore,
    grade,
    dimensions,
    suggestions,
    metrics: {
      length: text.length,
      actions: actions.length,
      entities: entities.length,
      namedEntities: namedEntities.length,
      paths: paths.length,
      references: refs.length,
      language,
    },
  };
}

function buildQualityBlock(result) {
  if (!result) return '';
  const lines = ['## PROMPT QUALITY SCORE', `Score: **${result.score}** (grade ${result.grade}).`];
  if (result.suggestions && result.suggestions.length) {
    lines.push('Suggestions to improve:');
    for (const s of result.suggestions) lines.push(`- ${s}`);
  }
  return lines.join('\n');
}

module.exports = {
  score,
  buildQualityBlock,
  gradeFromScore,
};
