'use strict';

/**
 * prompt-shape — cheap, deterministic reads of what a prompt asks for, shared
 * by the web-search trigger, the grounded-answer check and the quality guard
 * so they agree on the same turn.
 */

// Dates (27/09/2026, 2026-09-27) are not arithmetic.
const DATE_LIKE_RE = /(?<!\d)\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?!\d)/gu;
const ARITHMETIC_RE = /[\d)]\s*[a-z]?\s*(?:[+*×÷^=]|\/|\s-\s)\s*\(?\s*-?\s*[\d(a-z]/iu;
const MATH_VERB_RE = /(?<![\p{L}\p{N}])(?:resuelv\p{L}*|resolv\p{L}*|calcul\p{L}*|simplific\p{L}*|factoriz\p{L}*|despej\p{L}*|deriv\p{L}*|ecuaci[oó]n(?:es)?|inecuaci[oó]n(?:es)?|integral(?:es)?|solve|calculate|equations?)(?![\p{L}\p{N}])/iu;

/** A self-contained calculation: arithmetic, or a math verb with numbers. */
function looksLikeCalculation(prompt = '') {
  const text = String(prompt || '').replace(DATE_LIKE_RE, ' ');
  return ARITHMETIC_RE.test(text) || (MATH_VERB_RE.test(text) && /\d/.test(text));
}

module.exports = { looksLikeCalculation };
