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
async function runParaphrasePipeline({ source, rewriteFn, mode = 'standard', maxSimilarity = 0.72 }) {
  if (!source || typeof source !== 'string') {
    return { ok: false, error: 'empty_source' };
  }
  if (typeof rewriteFn !== 'function') {
    return { ok: false, error: 'rewrite_fn_required' };
  }

  const pass1 = await rewriteFn({ text: source, pass: 1, mode });
  const pass2Text = structuralVariation(pass1 || source);
  const pass2 = await rewriteFn({ text: pass2Text, pass: 2, mode });
  const finalText = (pass2 || pass2Text || pass1 || '').trim();

  const similarity = jaccardSimilarity(source, finalText);
  const ok = similarity <= maxSimilarity && finalText.length > 0;

  return {
    ok,
    output: finalText,
    similarity,
    maxSimilarity,
    passes: 3,
    mode,
  };
}

module.exports = {
  jaccardSimilarity,
  structuralVariation,
  runParaphrasePipeline,
};
