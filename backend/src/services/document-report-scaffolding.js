'use strict';

/**
 * document-report-scaffolding — strip plagiarism / AI-detection report chrome
 * (Turnitin and similar) from extracted document text before it is summarized.
 *
 * Students upload the Turnitin report PDF of their thesis: the first pages are
 * the report cover («Página 2 de 38 - Descripción general de la escritura con
 * IA», «Identificador de la entrega trn:oid:::1:…», the AI-detection
 * disclaimer). A summary built on that text describes the report, not the
 * research. This keeps the author's own content and drops only report chrome.
 * Pure, deterministic, no I/O.
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
  if (/\b(?:p[aá]gina|page)\s+\d+\s+(?:de|of)\s+\d+\s*[-–—]/i.test(sample)) hits += 1;
  if (/escritura con ia|ai writing overview|integrity overview|[ií]ndice de similitud/i.test(sample)) hits += 1;
  return hits >= 2;
}

/** Remove report chrome; returns the original text when it is not a report export. */
function stripReportScaffolding(text) {
  const raw = String(text || '');
  if (!raw.trim() || !looksLikeReportExport(raw)) return raw;
  let cleaned = raw;
  for (const re of INLINE_CHROME_PATTERNS) cleaned = cleaned.replace(re, ' ');
  const kept = splitUnits(cleaned)
    .filter((unit) => unit && !CHROME_SENTENCE_RE.test(unit) && !COUNTER_ONLY_RE.test(unit))
    .filter((unit) => /[\p{L}]{3,}/u.test(unit));
  const out = kept.join('\n').replace(/[ \t]{2,}/g, ' ').trim();
  // Never return an empty context: if everything looked like chrome, keep the input.
  return out.length >= 200 ? out : raw;
}

module.exports = {
  looksLikeReportExport,
  stripReportScaffolding,
};
