'use strict';

/**
 * Document text is UNTRUSTED. Template / authoring instructions inside an
 * uploaded file must never be treated as the user's task or as summary
 * evidence. This module tags those lines so the planner can drop them.
 */

const EDITORIAL_PATTERNS = [
  /\bincluir\s+la\s+imagen\b/i,
  /\breporte\s+de\s+similitud\b/i,
  /\bporcentaje\s+de\s+(?:coincidenc|plagio|similitud)/i,
  /\bmatriz\s+de\s+sistematizaci[oó]n\b/i,
  /\bformato\s+para\s+el\s+art[ií]culo\b/i,
  /\b(?:el\s+autor|los\s+autores|el\s+estudiante)\s+debe\b/i,
  /\bse\s+debe\s+(?:incluir|agregar|a[nñ]adir|insertar|adjuntar|colocar)\b/i,
  /\bdebe(?:n)?\s+(?:incluir|contener|agregar|presentar|adjuntar)\b/i,
  /\b(?:incluir|agregar|a[nñ]adir|insertar|adjuntar|colocar)\b.{0,80}\b(?:imagen|figura|tabla|gr[aá]fico|anexo|matriz|captura|screenshot|foto)\b/i,
  /\bcomplete(?:r)?\s+(?:the\s+)?(?:following|template|section)\b/i,
  /\binclude\s+the\s+(?:image|figure|table|screenshot|similarity)\b/i,
  /\bsimilarity\s+report\b/i,
  /\binstructions?\s+for\s+(?:authors?|students?|writers?)\b/i,
  /\bno\s+olvid(?:e|ar)\s+(?:incluir|adjuntar|agregar)\b/i,
  /\bplaceholder\b/i,
  /\b\[(?:insertar|incluir|agregar|TODO|TBD|completar)[^\]]*\]/i,
];

const TEMPLATE_HEADING_RE =
  /\b(?:formato|plantilla|template|instrucciones?|indicaciones?|pauta(?:s)?|gu[ií]a\s+de\s+estilo)\b/i;

function normalizeLine(line) {
  return String(line || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isEditorialLine(line) {
  const text = normalizeLine(line);
  if (!text) return false;
  if (text.length > 400) return false;
  return EDITORIAL_PATTERNS.some((re) => re.test(text));
}

function isTemplateHeading(line) {
  const text = normalizeLine(line).replace(/^#{1,6}\s+/, '');
  if (!text) return false;
  return TEMPLATE_HEADING_RE.test(text) && text.length <= 160;
}

function tagLines(text) {
  const raw = String(text || '');
  return raw.split(/\r?\n/).map((line, index) => {
    const trimmed = normalizeLine(line);
    const editorial = isEditorialLine(trimmed) || isTemplateHeading(trimmed);
    return {
      index,
      raw: line,
      text: trimmed,
      kind: editorial ? 'editorial' : (trimmed ? 'evidence' : 'blank'),
      untrusted: true,
    };
  });
}

function stripEditorial(text, { keepHeadings = true } = {}) {
  const lines = tagLines(text);
  const kept = [];
  for (const row of lines) {
    if (row.kind === 'editorial') continue;
    if (row.kind === 'blank') {
      if (kept.length && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    if (!keepHeadings && /^#{1,6}\s+/.test(row.text)) continue;
    kept.push(row.text);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function collectEditorialSnippets(text, limit = 24) {
  const out = [];
  const seen = new Set();
  for (const row of tagLines(text)) {
    if (row.kind !== 'editorial' || !row.text) continue;
    const key = row.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row.text);
    if (out.length >= limit) break;
  }
  return out;
}

function containsEditorialContamination(answer, editorialSnippets) {
  const hay = String(answer || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!hay.trim()) return false;
  const snippets = Array.isArray(editorialSnippets) ? editorialSnippets : collectEditorialSnippets(editorialSnippets);
  return snippets.some((snippet) => {
    const needle = String(snippet || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (needle.length < 18) return false;
    return hay.includes(needle);
  });
}

module.exports = {
  EDITORIAL_PATTERNS,
  isEditorialLine,
  isTemplateHeading,
  tagLines,
  stripEditorial,
  collectEditorialSnippets,
  containsEditorialContamination,
};
