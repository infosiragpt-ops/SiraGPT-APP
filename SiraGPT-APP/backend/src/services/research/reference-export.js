'use strict';

const { normaliseDoi } = require('./source-integrity');

function clean(value) {
  return String(value || '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

function authorNames(reference) {
  return (Array.isArray(reference.authors) ? reference.authors : [])
    .map((author) => clean(typeof author === 'string' ? author : author?.name))
    .filter(Boolean);
}

function exportKey(reference, index) {
  const first = authorNames(reference)[0]?.split(/\s+/).slice(-1)[0] || 'source';
  return `${first}${reference.year || 'nd'}${index + 1}`.replace(/[^a-z0-9]/gi, '');
}

function toBibTeX(references) {
  return (references || []).map((reference, index) => {
    const fields = [
      ['title', reference.title],
      ['author', authorNames(reference).join(' and ')],
      ['year', reference.year],
      ['journal', reference.venue],
      ['doi', normaliseDoi(reference.doi)],
      ['url', reference.url],
      ['abstract', reference.abstract],
      ['keywords', (reference.tags || []).join(', ')],
    ].filter(([, value]) => value !== null && value !== undefined && String(value).trim());
    return `@article{${exportKey(reference, index)},\n${fields.map(([name, value]) => `  ${name} = {${clean(value)}}`).join(',\n')}\n}`;
  }).join('\n\n');
}

function toRIS(references) {
  return (references || []).map((reference) => {
    const lines = ['TY  - JOUR', `TI  - ${clean(reference.title)}`];
    for (const author of authorNames(reference)) lines.push(`AU  - ${author}`);
    if (reference.year) lines.push(`PY  - ${reference.year}`);
    if (reference.venue) lines.push(`JO  - ${clean(reference.venue)}`);
    if (reference.doi) lines.push(`DO  - ${clean(normaliseDoi(reference.doi))}`);
    if (reference.url) lines.push(`UR  - ${clean(reference.url)}`);
    if (reference.abstract) lines.push(`AB  - ${clean(reference.abstract)}`);
    for (const tag of reference.tags || []) lines.push(`KW  - ${clean(tag)}`);
    lines.push('ER  -');
    return lines.join('\r\n');
  }).join('\r\n\r\n');
}

function exportReferences(references, format) {
  const normalized = String(format || '').toLowerCase();
  if (normalized === 'bibtex' || normalized === 'bib') {
    return { content: toBibTeX(references), contentType: 'application/x-bibtex; charset=utf-8', extension: 'bib' };
  }
  if (normalized === 'ris') {
    return { content: toRIS(references), contentType: 'application/x-research-info-systems; charset=utf-8', extension: 'ris' };
  }
  const error = new Error('unsupported_export_format');
  error.code = 'unsupported_export_format';
  throw error;
}

module.exports = { exportReferences, toBibTeX, toRIS };
