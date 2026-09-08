'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Body-vs-backmatter separation for extracted document text.
//
// Academic documents (review articles, theses) routinely end with
// back matter: references/bibliography, appendices, systematization
// matrices. When a synthesis prompt budget is filled from a naive
// head+tail excerpt, that tail is exactly what leaks into the model —
// which then "summarizes" similarity thresholds and citation lists
// instead of the actual content (real production bug, 2026-08).
//
// This module detects trailing back-matter regions by canonical ES/EN
// headings and lets excerpt builders cut from the body only. It never
// deletes content: callers can still reach back matter through evidence
// retrieval when the query genuinely targets it.
//
// Pure functions, no dependencies. All regexes are accent-tolerant via
// NFD normalization like the rest of the backend.
// ─────────────────────────────────────────────────────────────────────────────

function normalizeHeading(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// Heading-like line: short-ish, no terminal period, optionally markdown
// headings or outline numbering ("3.", "III.", "2.1").
function headingLikeLine(rawLine) {
  const line = String(rawLine || '').replace(/\s+/g, ' ').trim();
  if (!line || line.length > 120) return false;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/[.!?,;:]$/.test(line)) return false;
  // Outline numbering prefix: "3. Referencias", "IV. Anexos", "2.1 Matriz"
  const numbered = /^(?:[ivxlcdm]+|\d+(?:\.\d+)*)[.)]?\s+\S/i.test(line);
  const words = line.split(' ').length;
  return numbered ? words <= 12 : words <= 8;
}

const BACKMATTER_HEADING_RE = new RegExp([
  'referencias?(?:\\s+bibliograficas?)?',
  'bibliografia',
  'referencias?\\s+y\\s+(?:notas|bibliografia)',
  'works\\s+cited',
  'bibliography',
  'references',
  'anexos?',
  'apendices?|appendices?|appendix',
  'matriz\\s+de\\s+(?:sistematizacion|analisis|informacion|datos)',
  'matriz\\s+(?:sistematizadora|de\\s+revision)',
  'tabla\\s+de\\s+contenido', // as trailing block it repeats the TOC
  'declaratoria\\s+de\\s+autenticidad',
].join('|'));

/**
 * Find the earliest index (in characters) at which a trailing back-matter
 * region starts. Only headings in the last 60% of the text qualify — an
 * early "Referencias" mention inside prose must not truncate the body.
 */
function detectBackmatterRegions(text) {
  const source = String(text || '');
  if (!source.trim()) return [];
  const lines = source.split('\n');
  let offset = 0;
  const candidates = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const start = offset;
    offset += raw.length + 1;
    const normalized = normalizeHeading(raw.replace(/^#{1,6}\s*/, '').replace(/^(?:[ivxlcdm]+|\d+(?:\.\d+)*)[.)]?\s+/i, ''));
    if (!normalized) continue;
    if (!BACKMATTER_HEADING_RE.test(normalized)) continue;
    if (normalized.length > 90) continue;
    if (!headingLikeLine(raw)) continue;
    candidates.push({ start, index: i });
  }
  if (candidates.length === 0) return [];
  const cutoff = source.length * 0.4;
  const trailing = candidates.filter((c) => c.start >= cutoff);
  if (trailing.length === 0) return [];
  // Group: keep each candidate as its own region start; merge regions that
  // overlap after boundary checks happen in splitBodyVsBackmatter.
  return trailing.map((c) => ({ start: c.start, lineIndex: c.index }));
}

function countUsefulWords(text) {
  const matches = normalizeHeading(text).match(/[a-z0-9]{3,}/g);
  return matches ? matches.length : 0;
}

/**
 * Split extracted document text into body vs trailing back matter.
 * Returns { body, backmatter, boundary } — boundary is -1 when no
 * back-matter region was found or when cutting would gut the document.
 * The anti-gutting guard scales with document size: large documents
 * must keep a real body (>= 200 useful words); every document must keep
 * most of its substance in the body (> 40% of its useful words), so a
 * lone "Anexos" heading can never empty out a short note.
 */
function splitBodyVsBackmatter(text) {
  const source = String(text || '');
  const regions = detectBackmatterRegions(source);
  if (regions.length === 0) {
    return { body: source, backmatter: '', boundary: -1 };
  }
  // The back-matter block begins at the FIRST qualifying heading; later
  // ones (references → annexes) stay inside it.
  let boundary = regions[0].start;
  // Skip the heading line itself plus blank separators so body doesn't end
  // with dangling whitespace.
  while (boundary < source.length && /[\s]/.test(source[boundary])) boundary += 1;

  const candidateBody = source.slice(0, regions[0].start).trim();
  const backmatter = source.slice(regions[0].start).trim();
  const bodyWords = countUsefulWords(candidateBody);
  const totalWords = countUsefulWords(source);
  const tooAggressive =
    candidateBody.length < source.length * 0.25 ||
    (totalWords >= 200 && bodyWords < 200) ||
    bodyWords < totalWords * 0.4;
  if (tooAggressive) {
    return { body: source, backmatter: '', boundary: -1 };
  }
  return { body: candidateBody, backmatter, boundary };
}

/**
 * Trailing-back-matter stripper with the same string→string contract as the
 * other synthesis cleaners. Returns the input untouched when no safe cut exists.
 */
function stripTrailingBackmatter(text) {
  const { body } = splitBodyVsBackmatter(text);
  return body;
}

/**
 * Body-aware balanced excerpt: same output shape as
 * message-attachments.buildBalancedExcerpt but computed over the body only,
 * so tail budget lands on real conclusions instead of the reference list.
 */
function buildBodyBalancedExcerpt(text, maxChars, query = '') {
  const { body } = splitBodyVsBackmatter(text);
  const source = typeof text === 'string' && body ? body : String(text || '');
  const budget = Math.max(160, Number(maxChars) || 6000);
  if (!source.trim()) return '';
  if (source.length <= budget) return source;

  const normalized = normalizeHeading(source);
  const terms = Array.from(new Set(normalizeHeading(query).match(/[a-z0-9]{4,}/g) || []))
    .filter((term) => !['dame', 'para', 'como', 'documento', 'archivo'].includes(term));
  const firstRelevant = terms
    .map((term) => normalized.indexOf(term))
    .filter((idx) => idx >= Math.floor(source.length * 0.08))
    .sort((a, b) => a - b)[0];

  const headBudget = Math.floor(budget * 0.18);
  const tailBudget = Math.floor(budget * 0.32);
  const middleBudget = budget - headBudget - tailBudget - 120;
  const head = source.slice(0, headBudget).trim();
  const tail = source.slice(Math.max(0, source.length - tailBudget)).trim();
  const middle = Number.isInteger(firstRelevant)
    ? source.slice(
      Math.max(0, firstRelevant - Math.floor(middleBudget / 2)),
      Math.min(source.length, firstRelevant + Math.floor(middleBudget / 2)),
    ).trim()
    : '';

  return [
    head,
    middle ? '\n[Fragmento intermedio relevante]\n' + middle : '',
    '\n[Fragmento final del documento]\n' + tail,
  ].filter(Boolean).join('\n\n...\n\n');
}

module.exports = {
  detectBackmatterRegions,
  splitBodyVsBackmatter,
  stripTrailingBackmatter,
  buildBodyBalancedExcerpt,
};
