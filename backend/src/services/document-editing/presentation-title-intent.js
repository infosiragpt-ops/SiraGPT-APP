'use strict';

// Shared by the existing surgical editor and AgentRunner. A location inside an
// existing slide is NOT a request to append a slide or regenerate a deck.
const ORDINALS = Object.freeze({ primer: 1, primera: 1, primero: 1, first: 1,
  segunda: 2, segundo: 2, second: 2, tercera: 3, tercero: 3, tercer: 3, third: 3,
  cuarta: 4, cuarto: 4, quinta: 5, quinto: 5, sexta: 6, sexto: 6,
  septima: 7, septimo: 7, octava: 8, octavo: 8, novena: 9, noveno: 9, decima: 10, decimo: 10 });
const UNIT = '(?:diapositivas?|laminas?|landin\\w*|slides?)';
const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const EDIT = /\b(?:cambi\w*|actualiz\w*|reempla[zc]\w*|edita\w*|escrib\w*|modific\w*|pon(?:er|ga|le)?|agreg\w*|anad\w*|inclu\w*|set|change\w*|rename\w*)\b/;
function slideNumberFromRequest(value) {
  const text = normalize(value);
  const numeric = new RegExp(`\\b${UNIT}\\s*(?:n(?:ro|umero)?\\.?\\s*|#\\s*)?(\\d{1,3})\\b`).exec(text);
  if (numeric) return Number(numeric[1]);
  const ordinal = new RegExp(`\\b(${Object.keys(ORDINALS).join('|')})\\s+${UNIT}\\b`).exec(text);
  if (ordinal) return ORDINALS[ordinal[1]];
  if (/\b(?:portada|caratula)\b/.test(text)) return 1;
  return null;
}
function isScopedSlideMutation(value) {
  const text = normalize(value);
  if (!EDIT.test(text) || !slideNumberFromRequest(text)) return false;
  if (/\b(?:agreg\w*|anad\w*|insert\w*)\s+(?:una?|otra|nueva)\s+(?:\w+\s+)?(?:diapositiva|lamina|landin\w*|slide)\b/.test(text)) return false;
  return true;
}
function originalSpan(raw, needle) {
  // Match accent/case-insensitively, but return offsets into the original user
  // text so punctuation, capitalization and accents never get rewritten.
  let normalized = ''; const offsets = [];
  for (let index = 0; index < raw.length;) {
    const value = String.fromCodePoint(raw.codePointAt(index));
    const clean = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    for (const character of clean) { normalized += character; offsets.push(index); }
    index += value.length;
  }
  const escaped = normalize(needle).split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const match = new RegExp(escaped, 'u').exec(normalized);
  if (!match) return null;
  return { start: offsets[match.index], end: (offsets[match.index + match[0].length] ?? raw.length) };
}
function parsePresentationTitleEdit(requestText = '', { slides = [] } = {}) {
  const raw = String(requestText || ''); const normalized = normalize(raw);
  if (!normalized || !EDIT.test(normalized)) return null;
  if (/\b(?:y|and)\s+(?:cambi\w*|agreg\w*|anad\w*|quit\w*|elimin\w*|reemplaz\w*|pon\w*|colore\w*)\b/.test(normalized)) return null;
  const slideNumber = slideNumberFromRequest(raw);
  const outsideQuotes = normalize(raw.replace(/["“'][^"”']{1,160}["”']/g, ' '));
  if (/\b(?:y|and)\s+(?!(?:conserv\w*|manten\w*|mante\w*|preserv\w*|sin|no)\b)/.test(outsideQuotes)) return null;
  if (/(?:[,;.]\s*|\bluego\s+)(?:cambi\w*|agreg\w*|anad\w*|quit\w*|elimin\w*|reemplaz\w*|pon\w*|pint\w*|colore\w*)\b/.test(outsideQuotes)) return null;
  const quoteCount = (raw.match(/["“'][^"”']{1,160}["”']/g) || []).length;
  if (quoteCount >= 2) return null; // explicit replace-pairs keep their own path
  const titleNoun = /\b(?:titulo|title)\b/.test(outsideQuotes);
  const setVerb = /\b(?:cambi\w*|actualiz\w*|reempla[zc]\w*|edita\w*|escrib\w*|modific\w*|pon(?:er|ga|le)?|set|change\w*|rename\w*)\b/.test(outsideQuotes);
  if (titleNoun && setVerb) {
    const quoted = /["“']([^"”']{2,160})["”']/.exec(raw);
    const tail = /\bt[ií]tulo\b[^,;.]*?(?:\b(?:a|por)\b|:)\s+(.+?)(?:\s+y\s+|\s+and\s+|[,;]|\.\s|\.$|$)/i.exec(raw);
    const title = (quoted?.[1] || tail?.[1] || '').trim();
    if (title.length >= 2 && title.length <= 160 && !/^(?:color\s+)?(?:azul|rojo|verde|negro|gris|amarillo|naranja|morado|violeta|blanco|blue|red|green|black|gray|grey|yellow|orange|purple|white)$/i.test(title))
      return { kind: 'set_slide_title', slideNumber, title };
  }
  // "en la primera Landin agrega en la Historia ... de 1998": infer a title
  // only if the source proves that exact title already exists on that slide.
  // No topic-specific defaults, no new slide, no ambiguous body-title guessing.
  if (!isScopedSlideMutation(raw) || !/\b(?:agreg\w*|anad\w*|inclu\w*)\b/.test(normalized)) return null;
  const slide = slides.find((entry) => entry.number === slideNumber);
  if (!slide?.title || normalize(slide.title).length < 4) return null;
  const span = originalSpan(raw, slide.title);
  if (!span) return null;
  const tail = raw.slice(span.end).replace(/\s+y\s+(?:conserva|mant[eé]n|preserva)[\s\S]*$/i, '').replace(/[.\s]+$/, '');
  if (!tail.trim() || tail.length > 100 || /[;\n]|\by\s+(?:cambia|agrega|quita|elimina|reemplaza)\b/i.test(tail)) return null;
  const title = `${raw.slice(span.start, span.end)}${tail}`.trim();
  if (title.length > 160) return null;
  return { kind: 'set_slide_title', slideNumber, title };
}
module.exports = { slideNumberFromRequest, isScopedSlideMutation, parsePresentationTitleEdit };
