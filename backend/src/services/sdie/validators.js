'use strict';

/**
 * Deterministic output validators. An answer is only shown to the user
 * after it passes every active constraint on the RequestSpec.
 */

const { containsEditorialContamination } = require('./editorial');

const HEADING_LINE_RE = /^(#{1,6}\s+\S|.{0,80}\n[-=]{3,}\s*$)/m;
const MD_HEADING_RE = /^#{1,6}\s+\S/m;
const BULLET_LINE_RE = /^\s*(?:[-*+]|•|\d+[.)])\s+\S/m;

function splitParagraphs(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function hasHeading(text) {
  const src = String(text || '');
  return MD_HEADING_RE.test(src) || HEADING_LINE_RE.test(src);
}

function hasBullets(text) {
  return BULLET_LINE_RE.test(String(text || ''));
}

function validateAnswer(answer, spec, extras = {}) {
  const text = String(answer || '').trim();
  const violations = [];
  if (!text) {
    violations.push({ code: 'empty', message: 'answer is empty' });
    return { ok: false, violations, paragraphs: [] };
  }

  const paragraphs = splitParagraphs(text);
  const wanted = spec?.output?.paragraphs;
  if (Number.isFinite(wanted) && wanted > 0 && paragraphs.length !== wanted) {
    violations.push({
      code: 'paragraph_count',
      message: `expected ${wanted} paragraph(s), got ${paragraphs.length}`,
      expected: wanted,
      actual: paragraphs.length,
    });
  }

  if (spec?.output?.headings === false && hasHeading(text)) {
    violations.push({ code: 'headings_forbidden', message: 'headings are forbidden' });
  }
  if (spec?.output?.bullets === false && hasBullets(text)) {
    violations.push({ code: 'bullets_forbidden', message: 'bullets are forbidden' });
  }

  const editorial = extras.editorial || [];
  if (spec?.scope?.excludeEditorial !== false && containsEditorialContamination(text, editorial)) {
    violations.push({
      code: 'editorial_contamination',
      message: 'answer repeats untrusted editorial/template instructions',
    });
  }

  if (text.length < 40) {
    violations.push({ code: 'too_short', message: 'answer is too short to be a synthesis' });
  }

  return {
    ok: violations.length === 0,
    violations,
    paragraphs,
  };
}

module.exports = {
  splitParagraphs,
  hasHeading,
  hasBullets,
  validateAnswer,
};
