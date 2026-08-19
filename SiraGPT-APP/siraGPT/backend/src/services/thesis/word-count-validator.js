'use strict';

function countWords(text) {
  if (!text || typeof text !== 'string') return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function validateWordCount(text, { min = 0, max = Infinity, label = 'section' } = {}) {
  const words = countWords(text);
  const ok = words >= min && words <= max;
  return {
    ok,
    words,
    min,
    max,
    label,
    delta: ok ? 0 : (words < min ? min - words : words - max),
  };
}

function validateChapterPlan(chapters = []) {
  return chapters.map((ch) => ({
    id: ch.id,
    title: ch.title,
    ...validateWordCount(ch.content || '', {
      min: ch.minWords || 0,
      max: ch.maxWords || Infinity,
      label: ch.title || ch.id,
    }),
  }));
}

/**
 * Validate against an EXACT word count with a configurable tolerance.
 * The prompt master spec asks for "75 palabras exactas", "100 palabras
 * exactas" etc. — but counting differs by 1–2 words depending on
 * how compound APA citations like "(Hernández y Mendoza, 2018)" are
 * tokenised, so we accept a small symmetric tolerance (default ±3).
 *
 * Returns the same shape as validateWordCount plus `target` and
 * `tolerance` for diagnostics.
 */
function validateExactWordCount(text, { target, tolerance = 3, label = 'section' } = {}) {
  if (typeof target !== 'number' || target <= 0) {
    throw new Error('validateExactWordCount: target (positive number) is required');
  }
  const words = countWords(text);
  const min = Math.max(0, target - tolerance);
  const max = target + tolerance;
  const ok = words >= min && words <= max;
  return {
    ok,
    words,
    target,
    tolerance,
    min,
    max,
    label,
    delta: ok ? 0 : (words < min ? min - words : words - max),
  };
}

/**
 * Validate a section against a section-specs.js spec. Picks the right
 * strategy (exact vs range) and returns a normalised report.
 */
function validateAgainstSpec(text, spec) {
  if (!spec) {
    return { ok: false, words: countWords(text), label: 'unknown', error: 'no_spec' };
  }
  if (spec.exactWords != null) {
    return validateExactWordCount(text, {
      target: spec.exactWords,
      tolerance: spec.tolerance ?? 3,
      label: spec.title || spec.id,
    });
  }
  return validateWordCount(text, {
    min: spec.minWords || 0,
    max: spec.maxWords || Infinity,
    label: spec.title || spec.id,
  });
}

module.exports = {
  countWords,
  validateWordCount,
  validateExactWordCount,
  validateAgainstSpec,
  validateChapterPlan,
};
