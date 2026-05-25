'use strict';

function tokenize(text) {
  return String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
}

function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}

function structuralVariation(text) {
  const paragraphs = String(text || '').split(/\n{2,}/).filter(Boolean);
  if (paragraphs.length <= 1) return text;
  return [...paragraphs].reverse().join('\n\n');
}

/**
 * Three-pass paraphrase pipeline: rewrite → structural variation → similarity gate.
 */
// Per-mode similarity ceilings. The humanize/academic modes are
// stealth-sensitive — they must diverge more from the source so AI
// detectors and plagiarism checkers don't pattern-match. The user-
// supplied `maxSimilarity` (when present) still wins.
const MODE_SIMILARITY_CEILINGS = Object.freeze({
  standard: 0.72,
  humanize: 0.55,
  academic: 0.60,
  formal: 0.70,
  simple: 0.72,
  creative: 0.55,
  expand: 0.72,
  shorten: 0.78,
  custom: 0.72,
});

// Aliases — callers sometimes pass the conversational form of the
// mode ("human", "academic-style", "shorter", ...) instead of the
// canonical keys. We resolve common variants so the engine doesn't
// silently fall back to "standard" for typos.
const MODE_ALIASES = Object.freeze({
  human: 'humanize',
  humanized: 'humanize',
  humanise: 'humanize',
  humanised: 'humanize',
  paraphrase: 'standard',
  default: 'standard',
  formalize: 'formal',
  formalise: 'formal',
  'academic-style': 'academic',
  scholarly: 'academic',
  short: 'shorten',
  shorter: 'shorten',
  expanded: 'expand',
  longer: 'expand',
  simplify: 'simple',
  simplified: 'simple',
});

function normaliseMode(mode) {
  const raw = String(mode || '').trim().toLowerCase();
  return MODE_ALIASES[raw] || raw;
}

function resolveMaxSimilarity(mode, explicit) {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0 && explicit <= 1) {
    return explicit;
  }
  const canonical = normaliseMode(mode);
  return MODE_SIMILARITY_CEILINGS[canonical] || MODE_SIMILARITY_CEILINGS.standard;
}

async function runParaphrasePipeline({ source, rewriteFn, mode = 'standard', maxSimilarity }) {
  if (!source || typeof source !== 'string') {
    return { ok: false, error: 'empty_source' };
  }
  if (typeof rewriteFn !== 'function') {
    return { ok: false, error: 'rewrite_fn_required' };
  }
  const effectiveMaxSim = resolveMaxSimilarity(mode, maxSimilarity);

  const pass1 = await rewriteFn({ text: source, pass: 1, mode });
  const pass2Text = structuralVariation(pass1 || source);
  const pass2 = await rewriteFn({ text: pass2Text, pass: 2, mode });
  const finalText = (pass2 || pass2Text || pass1 || '').trim();

  const similarity = jaccardSimilarity(source, finalText);
  const ok = similarity <= effectiveMaxSim && finalText.length > 0;

  return {
    ok,
    output: finalText,
    similarity,
    maxSimilarity: effectiveMaxSim,
    passes: 3,
    mode,
  };
}

module.exports = {
  jaccardSimilarity,
  structuralVariation,
  runParaphrasePipeline,
  resolveMaxSimilarity,
  normaliseMode,
  MODE_SIMILARITY_CEILINGS,
  MODE_ALIASES,
};
