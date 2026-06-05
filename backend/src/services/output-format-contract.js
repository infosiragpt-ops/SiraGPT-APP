'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Output-format contract
//
// Single source of truth for "how should the final answer be shaped?". The user
// often states the desired shape in the prompt ("en 2 párrafos", "en una tabla",
// "máximo 100 palabras", "una lista numerada"). Historically this detection was
// scattered across message-attachments.js, agent-task-runner.js and routes/ai.js
// with slightly different regexes — which let format requests silently drift.
//
// This module parses the request once into a structured spec and renders precise,
// professional directive lines that every layer of the pipeline reuses verbatim.
// All functions are pure and have no dependency on the rest of the backend.
// ─────────────────────────────────────────────────────────────────────────────

// Strip accents + lowercase so "PÁRRAFOS" and "parrafos" compare equal.
function normalize(query) {
  return String(query || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Spanish number words 1..10 (singular/plural variants the user might type).
const NUMBER_WORDS = {
  un: 1, uno: 1, una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};

const NUMBER_WORD_PATTERN = Object.keys(NUMBER_WORDS).join('|');

function wordToNumber(token) {
  if (token == null) return null;
  const raw = String(token).trim();
  if (/^\d{1,3}$/.test(raw)) return Number(raw);
  const mapped = NUMBER_WORDS[raw];
  return Number.isFinite(mapped) ? mapped : null;
}

// "dos parrafos", "en 3 parrafos", "resumen de cuatro parrafos" → count.
function detectParagraphCount(normalized) {
  const re = new RegExp(`\\b(\\d{1,2}|${NUMBER_WORD_PATTERN})\\s+parrafos?\\b`);
  const match = normalized.match(re);
  if (!match) return null;
  const n = wordToNumber(match[1]);
  return Number.isFinite(n) && n >= 1 ? Math.min(20, n) : null;
}

// "un solo parrafo", "en un parrafo", "parrafo unico".
function detectSingleParagraph(normalized) {
  return (
    /\b(?:un|uno|1)\s+(?:solo\s+)?parrafo\b/.test(normalized) ||
    /\ben\s+(?:un|uno|1)\s+parrafo\b/.test(normalized) ||
    /\bparrafo\s+unico\b/.test(normalized)
  );
}

function detectNumberedList(normalized) {
  return (
    /\blista\s+numerada\b/.test(normalized) ||
    /\bnumerad[oa]s?\b/.test(normalized) ||
    /\benumera\w*\b/.test(normalized)
  );
}

function detectBulletList(normalized) {
  return (
    /\bvinetas?\b/.test(normalized) ||
    /\bbullets?\b/.test(normalized) ||
    /\bpuntos?\s+(?:clave|principales)\b/.test(normalized) ||
    /\bchecklist\b/.test(normalized) ||
    /\ben\s+forma\s+de\s+listas?\b/.test(normalized) ||
    // "lista" only counts as a formatting request when introduced by a
    // formatting verb/preposition, never as content ("la lista de autores").
    /\b(?:en|como|dame|damelo|hazme|hazlo|genera\w*|generame|crea\w*|creame|arma\w*|armame|presenta\w*|presentame|muestra\w*|muestrame|quiero|necesito|prefiero|formato\s+de)\s+(?:una?\s+|en\s+)?listas?\b/.test(
      normalized,
    )
  );
}

function detectTable(normalized) {
  return (
    /\btablas?\b/.test(normalized) ||
    /\bcuadro\s+comparativo\b/.test(normalized) ||
    /\bformato\s+de\s+tabla\b/.test(normalized)
  );
}

// "maximo 100 palabras", "en 80 palabras", "menos de 50 palabras".
function detectMaxWords(normalized) {
  const match = normalized.match(/\b(\d{1,4})\s+palabras\b/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// "en 3 oraciones", "dos frases", "5 lineas".
function detectMaxSentences(normalized) {
  const re = new RegExp(`\\b(\\d{1,2}|${NUMBER_WORD_PATTERN})\\s+(?:oraciones?|frases?|lineas?)\\b`);
  const match = normalized.match(re);
  if (!match) return null;
  const n = wordToNumber(match[1]);
  return Number.isFinite(n) && n > 0 ? Math.min(20, n) : null;
}

/**
 * Parse a user request into a structured output-format spec.
 * @param {string} query
 * @returns {{
 *   paragraphs: number|null,
 *   singleParagraph: boolean,
 *   list: ('bullet'|'numbered'|null),
 *   table: boolean,
 *   maxWords: number|null,
 *   maxSentences: number|null,
 * }}
 */
function parseOutputFormatRequest(query) {
  const normalized = normalize(query);
  const singleParagraph = detectSingleParagraph(normalized);
  let paragraphs = detectParagraphCount(normalized);
  if (singleParagraph) paragraphs = 1;

  // Numbered detection takes precedence over generic "lista" so an explicit
  // "lista numerada" is rendered as ordered items.
  let list = null;
  if (detectNumberedList(normalized)) list = 'numbered';
  else if (detectBulletList(normalized)) list = 'bullet';

  return {
    paragraphs: Number.isFinite(paragraphs) ? paragraphs : null,
    singleParagraph,
    list,
    table: detectTable(normalized),
    maxWords: detectMaxWords(normalized),
    maxSentences: detectMaxSentences(normalized),
  };
}

// Backward-compatible: explicit paragraph count, honored only for >= 2 (the
// single-paragraph path handles "1 parrafo") and capped at 6.
function requestedParagraphCount(query) {
  const { paragraphs } = parseOutputFormatRequest(query);
  if (!paragraphs || paragraphs < 2) return 0;
  return Math.min(6, paragraphs);
}

function wantsSingleParagraphSynthesis(query) {
  return parseOutputFormatRequest(query).singleParagraph;
}

function wantsBulletList(query) {
  return parseOutputFormatRequest(query).list != null;
}

/**
 * Render precise, professional directive lines for the requested format.
 * `lang` selects the wording register: 'es' for the Spanish attachment context,
 * 'en' for the English documentTurnGuard. English lines are prefixed with "- "
 * to match the existing guard bullet style.
 * @param {string} query
 * @param {{lang?: ('es'|'en')}} [opts]
 * @returns {string[]}
 */
function buildFormatDirectiveLines(query, { lang = 'es' } = {}) {
  const spec = parseOutputFormatRequest(query);
  const lines = [];
  const en = lang === 'en';
  const p = en ? '- ' : '';

  // Structure directives are mutually exclusive; table > list > paragraphs.
  if (spec.table) {
    lines.push(en
      ? `${p}The user requested a table: return a clean Markdown table with clear headers and no long preamble.`
      : 'El usuario pidio el resultado en forma de tabla: entrega una tabla Markdown con encabezados claros, sin preambulo largo ni viñetas alrededor.');
  } else if (spec.list === 'numbered') {
    lines.push(en
      ? `${p}The user requested a numbered list: answer with ordered items (1., 2., 3.) in logical order.`
      : 'El usuario pidio una lista numerada: entrega items numerados (1., 2., 3.) en orden logico, sin parrafos largos.');
  } else if (spec.list === 'bullet') {
    lines.push(en
      ? `${p}The user requested a list: answer with concise bullet points, one idea per line.`
      : 'El usuario pidio una lista: entrega viñetas claras y concisas, una idea por linea.');
  } else if (spec.singleParagraph) {
    lines.push(en
      ? `${p}The user requested one paragraph: answer in exactly one polished paragraph, with no heading, no bullets, no table, and no section breaks.`
      : 'El usuario pidio un solo parrafo: la respuesta final debe ser exactamente un parrafo, sin titulo, sin viñetas, sin tabla y sin saltos de seccion.');
  } else if (spec.paragraphs && spec.paragraphs >= 2) {
    const n = Math.min(6, spec.paragraphs);
    lines.push(en
      ? `${p}The user requested ${n} paragraphs: structure the final answer as exactly ${n} well-developed paragraphs, with no headings, no bullets, and no table.`
      : `El usuario pidio ${n} parrafos: la respuesta final debe tener exactamente ${n} parrafos bien desarrollados, sin viñetas y sin tabla.`);
  }

  // Length constraints compose with any structure directive.
  if (spec.maxWords) {
    lines.push(en
      ? `${p}The user set a limit of ${spec.maxWords} words: do not exceed it.`
      : `El usuario fijo un limite de ${spec.maxWords} palabras: no excedas esa extension.`);
  }
  if (spec.maxSentences) {
    lines.push(en
      ? `${p}The user requested ${spec.maxSentences} sentences: answer in exactly ${spec.maxSentences} sentences.`
      : `El usuario pidio ${spec.maxSentences} oraciones: responde en exactamente ${spec.maxSentences} oraciones.`);
  }

  return lines;
}

module.exports = {
  parseOutputFormatRequest,
  requestedParagraphCount,
  wantsSingleParagraphSynthesis,
  wantsBulletList,
  buildFormatDirectiveLines,
};
