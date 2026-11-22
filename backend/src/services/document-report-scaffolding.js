'use strict';

/**
 * document-report-scaffolding — strip plagiarism / AI-detection report chrome
 * (Turnitin and similar) AND deduplicate repeated multi-page running headers /
 * footers from extracted document text before it is summarized or analyzed.
 *
 * Students and teams frequently upload Turnitin / Moodle PDF exports or
 * multi-page institutional PDFs:
 *   1. The first pages carry report covers («Página 2 de 38 - Descripción
 *      general de la escritura con IA», «Identificador de la entrega trn:oid:…»,
 *      AI-detection disclaimers).
 *   2. Every single page repeats institutional running headers/footers
 *      («202602 - DISTANCIA - H - LIMA NORTE - MAESTRÍA EN EDUCACIÓN… (Moodle TT)»,
 *      «Página X de 38 - Entrega», `[page N]`), polluting summaries and eating
 *      context budgets.
 *
 * Pure, deterministic, no I/O. Leaves ordinary documents and verbatim
 * transcription requests untouched.
 */

const INLINE_CHROME_PATTERNS = [
  // «Página 2 de 38 - Descripción general de la escritura con IA», «Page 3 of 38 - Integrity Overview»
  /\b(?:p[aá]gina|page)\s+\d{1,4}\s+(?:de|of)\s+\d{1,4}\s*[-–—]\s*(?:portada|cover(?:\s+page)?|descripci[oó]n general[^.\n]{0,60}|integrity overview|ai writing overview|entrega|submission)[^\n.]{0,40}/gi,
  /\b(?:identificador de la entrega|submission id)\s*:?\s*trn:oid:[:\d]+/gi,
  /\btrn:oid:[:\d]+/gi,
  // Report file name echoes: «108236_YENY_..._14677794_1261054847.pdf»
  /\b[\w-]*\d{5,}[\w-]*_\d{6,}\.(?:pdf|docx?)\b/gi,
];

const CHROME_SENTENCE_RE = new RegExp([
  'turnitin',
  'moodle\\s+tt',
  'escritura con ia',
  'ai writing',
  'detecci[oó]n de (?:ia|escritura)',
  'herramienta de ia generativa',
  'generad[oa]s? (?:probablemente )?por (?:ia|humanos)',
  'redacciones probablemente generadas',
  'texto calificado',
  'falsos? positivos?',
  'descripci[oó]n general de (?:la escritura|integridad|similitud)',
  'integrity overview',
  'similarity (?:report|index)',
  '[ií]ndice de similitud',
  'reporte turnitin',
  'detalles del documento',
  'fecha de (?:entrega|descarga)',
  'nombre del archivo',
  'tama[nñ]o del archivo',
  'identificador de la entrega',
  'preguntas frecuentes',
].join('|'), 'i');

// «38 páginas 12.730 palabras 70.746 caracteres» report counters.
const COUNTER_ONLY_RE = /^\s*(?:\d[\d.,]*\s*(?:p[aá]ginas?|palabras?|caracteres?|pages?|words?|characters?)\s*)+$/i;
const STANDALONE_PAGE_MARKER_RE = /^\s*(?:\[\s*(?:p[aá]gina|page)\s*\d{1,4}(?:\s*(?:\/|de|of)\s*\d{1,4})?\s*\]|(?:p[aá]gina|page|p[aá]g\.?)\s*\d{1,4}(?:\s*(?:\/|de|of)\s*\d{1,4})?)\s*$/i;

function splitUnits(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n+|(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"«(])/)
    .map((unit) => unit.trim());
}

/**
 * True when the text carries enough report chrome to be a report export.
 * Cheap guard so ordinary documents mentioning «IA» are never filtered.
 */
function looksLikeReportExport(text) {
  const sample = String(text || '').slice(0, 20000);
  let hits = 0;
  if (/turnitin/i.test(sample)) hits += 2;
  if (/trn:oid:/i.test(sample)) hits += 2;
  if (/\bmoodle\s+tt\b/i.test(sample)) hits += 2;
  if (/\b(?:p[aá]gina|page)\s+\d+\s+(?:de|of)\s+\d+\s*[-–—]/i.test(sample)) hits += 1;
  if (/escritura con ia|ai writing overview|integrity overview|[ií]ndice de similitud/i.test(sample)) hits += 1;
  return hits >= 2;
}

function canonicalHeaderKey(line) {
  const trimmed = String(line || '').trim();
  if (trimmed.length < 14 || trimmed.length > 190) return '';
  // Never treat Markdown table rows, headings, or bullet items as running headers.
  if (trimmed.includes('|') || /^(?:#{1,6}\s|[-*•]\s|\d{1,2}[.)]\s)/.test(trimmed)) return '';
  return trimmed
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(?:pagina|page|pag\.?)\s*\d{1,4}(?:\s*(?:de|of|\/)\s*\d{1,4})?\b/g, 'pag_n')
    .replace(/\b\d{1,4}\s*\/\s*\d{1,4}\b/g, 'pag_n')
    .replace(/[^a-z0-9_]+/g, ' ')
    .trim();
}

/**
 * Deduplicate running headers/footers repeated >= 3 times across pages of a PDF
 * (e.g. institutional header banners, course codes, or page footers), keeping
 * at most the first occurrence (or zero if it is pure page/LMS chrome).
 */
function dedupeRepeatedPageHeaders(text) {
  const raw = String(text || '');
  if (!raw.includes('\n')) return raw;
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines.length < 12) return raw;

  const freq = new Map();
  for (const line of lines) {
    const key = canonicalHeaderKey(line);
    if (!key || key.split(' ').length < 3) continue;
    freq.set(key, (freq.get(key) || 0) + 1);
  }

  const repeatedKeys = new Set();
  for (const [key, count] of freq.entries()) {
    if (count >= 3) repeatedKeys.add(key);
  }
  if (repeatedKeys.size === 0) {
    return lines.filter((l) => !STANDALONE_PAGE_MARKER_RE.test(l)).join('\n');
  }

  const seenOnce = new Set();
  const out = [];
  for (const line of lines) {
    if (STANDALONE_PAGE_MARKER_RE.test(line)) continue;
    const key = canonicalHeaderKey(line);
    if (key && repeatedKeys.has(key)) {
      const isPureChrome = /\b(?:pag_n|moodle|turnitin|campus virtual|todos los derechos reservados|confidencial)\b/.test(key);
      if (isPureChrome || seenOnce.has(key)) continue;
      seenOnce.add(key);
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Remove report chrome; returns the original text when it is not a report export. */
function stripReportScaffolding(text) {
  const raw = String(text || '');
  if (!raw.trim()) return raw;
  const deduped = dedupeRepeatedPageHeaders(raw);
  if (!looksLikeReportExport(raw)) return deduped;

  let cleaned = deduped;
  for (const re of INLINE_CHROME_PATTERNS) cleaned = cleaned.replace(re, ' ');
  const kept = splitUnits(cleaned)
    .filter((unit) => unit && !CHROME_SENTENCE_RE.test(unit) && !COUNTER_ONLY_RE.test(unit) && !STANDALONE_PAGE_MARKER_RE.test(unit))
    .filter((unit) => /[\p{L}]{3,}/u.test(unit));
  const out = kept.join('\n').replace(/[ \t]{2,}/g, ' ').trim();
  // Never return an empty context: if everything looked like chrome, keep deduped input.
  return out.length >= 200 ? out : deduped;
}

/**
 * Unified entry point for chat & agent attachment pipelines.
 * Skips cleaning when `preserveVerbatim` is true (e.g. exact transcription).
 */
function cleanExtractedDocumentText(text, { preserveVerbatim = false } = {}) {
  const raw = String(text || '');
  if (!raw.trim() || preserveVerbatim) return raw;
  return stripReportScaffolding(raw);
}

module.exports = {
  looksLikeReportExport,
  dedupeRepeatedPageHeaders,
  stripReportScaffolding,
  cleanExtractedDocumentText,
};
