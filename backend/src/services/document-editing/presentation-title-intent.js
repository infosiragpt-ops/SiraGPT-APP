'use strict';

// Shared by the existing surgical editor and AgentRunner. A location inside an
// existing slide is NOT a request to append a slide or regenerate a deck.
const ORDINALS = Object.freeze({ primer: 1, primera: 1, primero: 1, first: 1,
  segunda: 2, segundo: 2, second: 2, tercera: 3, tercero: 3, tercer: 3, third: 3,
  cuarta: 4, cuarto: 4, quinta: 5, quinto: 5, sexta: 6, sexto: 6,
  septima: 7, septimo: 7, octava: 8, octavo: 8, novena: 9, noveno: 9, decima: 10, decimo: 10 });
const UNIT = '(?:diapositivas?|laminas?|landin\\w*|slides?)';
const NUMERIC_SLIDE = `${UNIT}\\s*(?:n(?:ro|umero)?\\.?\\s*|#\\s*)?(\\d{1,3})\\b`;
const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const EDIT = /\b(?:cambi\w*|actualiz\w*|reempla[zc]\w*|edita\w*|escrib\w*|modific\w*|pon(?:er|ga|le)?|agreg\w*|anad\w*|inclu\w*|set|change\w*|rename\w*)\b/;
function unquoteDocumentReferences(value) {
  // A quoted filename after a source cue is not the requested title value.
  return String(value || '').replace(/\b(en|archivo|presentaci[oó]n|documento)\s+["“']([^"”']+\.(?:pptx|docx|xlsx|pdf))["”']/gi, '$1 $2');
}
function documentReferenceText(value) {
  const raw = unquoteDocumentReferences(value);
  const assignment = /\b(?:t[ií]tulo|title)\b[^,;.]*?(?:\b(?:a|por|to)\b|:)\s+/i.exec(raw);
  let references = raw;
  if (assignment) {
    const valueStart = assignment.index + assignment[0].length;
    const tail = raw.slice(valueStart);
    const quotedValue = /^["“'][^"”']*["”']/.exec(tail);
    // A source may follow the replacement: title a "Nuevo" en B.pptx.
    references = raw.slice(0, valueStart) + (quotedValue ? tail.slice(quotedValue[0].length) : '');
  }
  return references.replace(/["“'][^"”']*["”']/g, ' ');
}
function slideNumberFromRequest(value) {
  const text = normalize(value);
  const numeric = new RegExp(`\\b${NUMERIC_SLIDE}`).exec(text);
  if (numeric) return Number(numeric[1]);
  const ordinal = new RegExp(`\\b(${Object.keys(ORDINALS).join('|')})\\s+${UNIT}\\b`).exec(text);
  if (ordinal) return ORDINALS[ordinal[1]];
  if (/\b(?:portada|caratula)\b/.test(text)) return 1;
  return null;
}
function maskDocumentFilenames(value) {
  // Mask quoted filenames BEFORE unquoting them (spaces matter).
  const qualifiedLocation = new RegExp(`\\b(?:${NUMERIC_SLIDE}|(?:${Object.keys(ORDINALS).join('|')})\\s+${UNIT}|portada|caratula)\\s+(?:de|del|en)\\b`);
  return String(value || '')
    .replace(/["“'][^"”']+\.(?:pptx|docx|xlsx|pdf)["”']/gi, ' ')
    // "En la diapositiva 2 de historia.pptx" contains a real location,
    // not one long filename. Leave it for the token-only filename mask.
    .replace(/\ben\s+[^,"“”';!?]+?\.(?:pptx|docx|xlsx|pdf)\b/gi, (match) => EDIT.test(normalize(match)) || qualifiedLocation.test(normalize(match)) ? match : ' ')
    .replace(/[^\s"“”',;!?]+\.(?:pptx|docx|xlsx|pdf)\b/gi, ' ');
}
function resolveSlideScope(value) {
  // Resolve locations from instructions, never from the new title or a source.
  const text = normalize(documentReferenceText(maskDocumentFilenames(value)));
  const ordinals = Object.keys(ORDINALS).join('|');
  const numbers = [
    ...Array.from(text.matchAll(new RegExp(`\\b${NUMERIC_SLIDE}`, 'g')), match => Number(match[1])),
    ...Array.from(text.matchAll(new RegExp(`\\b(${ordinals})\\s+${UNIT}\\b`, 'g')), match => ORDINALS[match[1]]),
    ...(/\b(?:portada|caratula)\b/.test(text) ? [1] : []),
  ];
  const distinct = [...new Set(numbers)];
  // Elliptical lists/ranges have a single unit noun, so ordinary location
  // matches alone would accidentally select only their first/last member.
  const list = new RegExp(`\\b(?:${ordinals})\\s*(?:,|y|e|and|a|hasta)\\s*(?:(?:la|el)\\s+)?(?:${ordinals})\\s+${UNIT}\\b`).test(text)
    || new RegExp(`\\b${UNIT}\\s+\\d{1,3}\\s*(?:,|y|e|and|a|al|hasta|-)\\s*\\d{1,3}\\b`).test(text)
    || new RegExp(`\\b(?:ambas|ambos)\\s+(?:(?:las|los)\\s+)?${UNIT}\\b`).test(text);
  // An explicit whole-deck operation remains supported by the generic/style
  // editors, but never by the single-slide title fast path.
  const allSlides = new RegExp(`\\b(?:cada|todas|todos)\\s+(?:(?:las|los)\\s+)?${UNIT}\\b`).test(text);
  return { slideNumber: distinct[0] ?? null, ambiguous: distinct.length > 1 || list || (allSlides && distinct.length > 0), allSlides };
}
function isPreservationOnlyTitleSuffix(value) {
  let text = normalize(value).replace(/^[\s,;.!?]+|[\s,;.!?]+$/g, '');
  // "… a Nuevo en B.pptx" is a source, not a second action. Keep any
  // following clause for validation rather than discarding that entire tail.
  text = text.replace(/^en\s+(?:(?:el|la)\s+)?(?:(?:archivo|documento|presentacion)\s+)?[^,;!?]+?\.pptx\b\s*/, '');
  const object = '(?:(?:el|la|los|las)\\s+)?(?:diseno|formato|contenido|estructura|fondos|demas\\s+diapositivas|resto(?:\\s+(?:del\\s+(?:archivo|documento)|de\\s+la\\s+presentacion|de\\s+las\\s+diapositivas))?)(?:\\s+(?:original(?:es)?|intact[oa]s?|sin\\s+cambios))?';
  const preserve = new RegExp(`^(?:(?:conserva|conservando|manten|manteniendo|preserva|preservando)\\s+${object}|sin\\s+(?:cambiar|alterar|modificar|tocar)\\s+${object}|no\\s+(?:cambies|alteres|modifiques|toques)\\s+${object})$`);
  return text.split(/[,;.!?]|\b(?:y|and)\b/).every(clause => !clause.trim() || preserve.test(clause.trim()));
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
  const raw = unquoteDocumentReferences(requestText); const normalized = normalize(raw);
  if (!normalized || !EDIT.test(normalized)) return null;
  if (/\b(?:y|and)\s+(?:cambi\w*|agreg\w*|anad\w*|quit\w*|elimin\w*|reemplaz\w*|pon\w*|colore\w*)\b/.test(normalized)) return null;
  const scope = resolveSlideScope(requestText);
  if (scope.ambiguous || scope.allSlides) return null;
  const { slideNumber } = scope;
  const outsideQuotes = normalize(raw.replace(/["“'][^"”']{1,160}["”']/g, ' '));
  if (/\b(?:y|and)\s+(?!(?:conserv\w*|manten\w*|mante\w*|preserv\w*|sin|no)\b)/.test(outsideQuotes)) return null;
  // A location/filename may precede the FIRST action: "En archivo.pptx,
  // cambia el título…". Only a later action clause is a compound edit. Check
  // every delimiter so accepting that prefix cannot hide a second operation.
  // File names such as cambios.pptx are not commands. Keep quoted source
  // names masked too, including names containing spaces, before unquoting.
  const commandText = normalize(maskDocumentFilenames(requestText)
    .replace(/["“'][^"”']*["”']/g, ' '));
  const mutation = `${EDIT.source}|\\b(?:quit\\w*|elimin\\w*|borr\\w*|pint\\w*|colore\\w*)\\b`;
  const firstEditIndex = commandText.search(new RegExp(mutation));
  if (firstEditIndex < 0) return null;
  const prefix = commandText.slice(0, firstEditIndex);
  if (/[,;.]/.test(prefix)) {
    const locationOnly = new RegExp(`^(?:por favor|(?:en|in|on)\\s*(?:(?:el|la)\\s+)?(?:(?:${Object.keys(ORDINALS).join('|')})\\s+${UNIT}|${UNIT}\\s+\\d{1,3}|portada|caratula|archivo|documento|presentacion)?)$`);
    if (prefix.split(/[,;.]/).some(clause => clause.trim() && !locationOnly.test(clause.trim()))) return null;
  }
  for (const clause of commandText.matchAll(new RegExp(`(?:[,;.]\\s*|\\bluego\\s+)(?:${mutation})`, 'g'))) {
    if (clause.index > firstEditIndex) return null;
  }
  const quoteCount = (raw.match(/["“'][^"”']{1,160}["”']/g) || []).length;
  if (quoteCount >= 2) return null; // explicit replace-pairs keep their own path
  const titleNoun = /\b(?:titulo|title)\b/.test(outsideQuotes);
  const setVerb = /\b(?:cambi\w*|actualiz\w*|reempla[zc]\w*|edita\w*|escrib\w*|modific\w*|pon(?:er|ga|le)?|set|change\w*|rename\w*)\b/.test(commandText);
  if (titleNoun && setVerb) {
    const quoted = /["“']([^"”']{2,160})["”']/.exec(raw);
    const tail = /\bt[ií]tulo\b[^,;.]*?(?:\b(?:a|por)\b|:)\s+(.+?)(?:\s+y\s+|\s+and\s+|[,;]|\.\s|\.$|$)/i.exec(raw);
    const title = (quoted?.[1] || tail?.[1] || '').trim();
    const valueEnd = quoted ? quoted.index + quoted[0].length
      : tail ? tail.index + tail[0].lastIndexOf(tail[1]) + tail[1].length : 0;
    if (!valueEnd || !isPreservationOnlyTitleSuffix(raw.slice(valueEnd))) return null;
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
  if (!tail.trim() || tail.length > 100 || /[,;\n]|\.\s|\b(?:y|e|and|luego)\b/i.test(tail)) return null;
  const title = `${raw.slice(span.start, span.end)}${tail}`.trim();
  if (title.length > 160) return null;
  return { kind: 'set_slide_title', slideNumber, title };
}
module.exports = { slideNumberFromRequest, resolveSlideScope, isScopedSlideMutation, parsePresentationTitleEdit, documentReferenceText };
