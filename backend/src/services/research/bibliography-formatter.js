'use strict';

/**
 * bibliography-formatter — turn canonical Paper objects (from scientific-search)
 * into ready-to-paste references in APA 7th, IEEE and MLA 9th styles, plus a
 * compact in-text citation token. Deterministic, dependency-free.
 *
 * Paper shape consumed: { title, authors:[{name}], year, venue, doi, htmlUrl }
 */

function cleanName(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

// Split a free-form author name into { family, given:[words] }. Handles
// "First Last", "First Middle Last", "Last, First" and single tokens.
function parseName(raw) {
  const name = cleanName(raw);
  if (!name) return null;
  if (name.includes(',')) {
    const [family, rest] = name.split(',');
    return { family: cleanName(family), given: cleanName(rest).split(/\s+/).filter(Boolean) };
  }
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { family: parts[0], given: [] };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1) };
}

function initials(given) {
  return given.map((g) => `${g[0].toUpperCase()}.`);
}

function paperAuthors(paper) {
  return (paper.authors || [])
    .map((a) => parseName(a && a.name))
    .filter(Boolean);
}

// ── APA 7 ──────────────────────────────────────────────────────────────
function apaAuthor(p) {
  const ini = initials(p.given);
  return ini.length ? `${p.family}, ${ini.join(' ')}` : p.family;
}
function apaAuthorList(authors) {
  if (!authors.length) return '';
  const formatted = authors.map(apaAuthor);
  if (formatted.length === 1) return formatted[0];
  if (formatted.length <= 20) {
    return `${formatted.slice(0, -1).join(', ')}, & ${formatted[formatted.length - 1]}`;
  }
  return `${formatted.slice(0, 19).join(', ')}, ... ${formatted[formatted.length - 1]}`;
}
function formatAPA(paper) {
  const authors = apaAuthorList(paperAuthors(paper));
  const year = paper.year ? `(${paper.year}).` : '(s.f.).';
  const title = cleanName(paper.title) ? `${cleanName(paper.title)}.` : '';
  const venue = cleanName(paper.venue) ? `*${cleanName(paper.venue)}*.` : '';
  const link = paper.doi ? `https://doi.org/${String(paper.doi).replace(/^https?:\/\/doi\.org\//i, '')}` : (paper.htmlUrl || '');
  return [authors ? `${authors}` : null, year, title, venue, link]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// ── IEEE ───────────────────────────────────────────────────────────────
function ieeeAuthor(p) {
  const ini = initials(p.given);
  return ini.length ? `${ini.join(' ')} ${p.family}` : p.family;
}
function ieeeAuthorList(authors) {
  if (!authors.length) return '';
  const f = authors.map(ieeeAuthor);
  if (f.length === 1) return f[0];
  if (f.length === 2) return `${f[0]} and ${f[1]}`;
  if (f.length <= 6) return `${f.slice(0, -1).join(', ')}, and ${f[f.length - 1]}`;
  return `${f[0]} et al.`;
}
function formatIEEE(paper, index) {
  const n = Number.isFinite(index) ? `[${index}] ` : '';
  const authors = ieeeAuthorList(paperAuthors(paper));
  const title = cleanName(paper.title) ? `"${cleanName(paper.title)},"` : '';
  const venue = cleanName(paper.venue) ? `*${cleanName(paper.venue)}*,` : '';
  const year = paper.year ? `${paper.year}.` : '';
  const doi = paper.doi ? `doi: ${String(paper.doi).replace(/^https?:\/\/doi\.org\//i, '')}.` : '';
  return `${n}${[authors ? `${authors},` : null, title, venue, year, doi].filter(Boolean).join(' ')}`
    .replace(/\s+/g, ' ').trim();
}

// ── MLA 9 ──────────────────────────────────────────────────────────────
function mlaPrimary(p) {
  const given = p.given.join(' ');
  return given ? `${p.family}, ${given}` : p.family;
}
function mlaAuthorList(authors) {
  if (!authors.length) return '';
  if (authors.length === 1) return `${mlaPrimary(authors[0])}.`;
  if (authors.length === 2) {
    const second = [authors[1].given.join(' '), authors[1].family].filter(Boolean).join(' ');
    return `${mlaPrimary(authors[0])}, and ${second}.`;
  }
  return `${mlaPrimary(authors[0])}, et al.`;
}
function formatMLA(paper) {
  const authors = mlaAuthorList(paperAuthors(paper));
  const title = cleanName(paper.title) ? `"${cleanName(paper.title)}."` : '';
  const venue = cleanName(paper.venue) ? `*${cleanName(paper.venue)}*,` : '';
  const year = paper.year ? `${paper.year},` : '';
  const doi = paper.doi ? `https://doi.org/${String(paper.doi).replace(/^https?:\/\/doi\.org\//i, '')}.` : (paper.htmlUrl ? `${paper.htmlUrl}.` : '');
  return [authors, title, venue, year, doi].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// In-text citation token, e.g. (García & Smith, 2021) / (García et al., 2021).
function inTextCitation(paper) {
  const authors = paperAuthors(paper);
  const year = paper.year || 's.f.';
  if (!authors.length) {
    const t = cleanName(paper.title);
    const short = t.split(/\s+/).slice(0, 3).join(' ');
    return `("${short}", ${year})`;
  }
  if (authors.length === 1) return `(${authors[0].family}, ${year})`;
  if (authors.length === 2) return `(${authors[0].family} & ${authors[1].family}, ${year})`;
  return `(${authors[0].family} et al., ${year})`;
}

const STYLES = ['apa', 'ieee', 'mla'];

function formatCitation(paper, style = 'apa', index) {
  switch (String(style).toLowerCase()) {
    case 'ieee': return formatIEEE(paper, index);
    case 'mla': return formatMLA(paper);
    case 'apa':
    default: return formatAPA(paper);
  }
}

function formatBibliography(papers, style = 'apa') {
  const list = (papers || []).map((p, i) => formatCitation(p, style, i + 1));
  if (String(style).toLowerCase() === 'apa') {
    // APA references are alphabetised by first author surname.
    return list.slice().sort((a, b) => a.localeCompare(b, 'es'));
  }
  return list;
}

module.exports = {
  formatCitation,
  formatBibliography,
  formatAPA,
  formatIEEE,
  formatMLA,
  inTextCitation,
  parseName,
  STYLES,
};
