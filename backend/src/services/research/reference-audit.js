'use strict';

const { doiStatus, normaliseDoi } = require('./source-integrity');
const { normaliseText } = require('./research-library');

function authors(reference) {
  return (Array.isArray(reference?.authors) ? reference.authors : [])
    .map((author) => typeof author === 'string' ? author : author?.name)
    .filter(Boolean);
}

function surname(value) {
  const parts = normaliseText(value).split(' ').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function citationKeys(reference, index) {
  const first = surname(authors(reference)[0]);
  const year = Number(reference?.year);
  return {
    numeric: String(index + 1),
    authorYear: first && year ? `${first}:${year}` : null,
  };
}

function numericCitationNumbers(text) {
  const values = new Set();
  for (const match of String(text || '').matchAll(/\[([0-9,;\s-]+)\]/g)) {
    for (const token of match[1].split(/[;,\s]+/).filter(Boolean)) {
      const range = token.match(/^(\d+)-(\d+)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), start + 100);
        for (let value = start; value <= end; value += 1) values.add(String(value));
      } else if (/^\d+$/.test(token)) values.add(String(Number(token)));
    }
  }
  return values;
}

function authorYearCitations(text) {
  const values = new Set();
  const clean = normaliseText(text);
  for (const match of clean.matchAll(/\b([a-z][a-z0-9-]{2,})\s+(?:et\s+al\s+)?(?:19|20)\d{2}\b/g)) {
    const year = match[0].match(/(?:19|20)\d{2}/)?.[0];
    if (year) values.add(`${match[1]}:${year}`);
  }
  return values;
}

function auditReferences(text, references) {
  const list = Array.isArray(references) ? references : [];
  const numeric = numericCitationNumbers(text);
  const authorYear = authorYearCitations(text);
  const used = [];
  const unused = [];
  const invalidDois = [];
  const incomplete = [];
  const keyToReference = new Map();

  list.forEach((reference, index) => {
    const keys = citationKeys(reference, index);
    keyToReference.set(keys.numeric, reference);
    if (keys.authorYear) keyToReference.set(keys.authorYear, reference);
    const isUsed = numeric.has(keys.numeric) || (keys.authorYear && authorYear.has(keys.authorYear));
    (isUsed ? used : unused).push(reference.id || keys.numeric);
    if (reference.doi && doiStatus(reference.doi) !== 'format_valid') {
      invalidDois.push({ referenceId: reference.id || keys.numeric, doi: String(reference.doi) });
    }
    const missing = ['title', 'year'].filter((field) => !reference?.[field]);
    if (!authors(reference).length) missing.push('authors');
    if (missing.length) incomplete.push({ referenceId: reference.id || keys.numeric, missing });
  });

  const orphanCitations = [];
  for (const token of numeric) if (!keyToReference.has(token)) orphanCitations.push({ type: 'numeric', token: `[${token}]` });
  for (const token of authorYear) if (!keyToReference.has(token)) orphanCitations.push({ type: 'author_year', token });

  const identities = new Map();
  const duplicates = [];
  for (const reference of list) {
    const identity = normaliseDoi(reference.doi).toLowerCase() || `${normaliseText(reference.title)}|${reference.year || ''}`;
    if (!identity) continue;
    if (identities.has(identity)) duplicates.push([identities.get(identity), reference.id || identity]);
    else identities.set(identity, reference.id || identity);
  }

  return {
    counts: {
      references: list.length,
      used: used.length,
      unused: unused.length,
      orphanCitations: orphanCitations.length,
      invalidDois: invalidDois.length,
      incomplete: incomplete.length,
      duplicates: duplicates.length,
    },
    usedReferenceIds: used,
    unusedReferenceIds: unused,
    orphanCitations,
    invalidDois,
    incomplete,
    duplicates,
    passed: orphanCitations.length === 0 && invalidDois.length === 0 && duplicates.length === 0,
  };
}

module.exports = { auditReferences, authorYearCitations, numericCitationNumbers };
