'use strict';

/**
 * Format-agnostic Office-edit intent parser.
 *
 * Turns informal requests (any topic, any Office file) into a precise
 * structural plan: add N units, last bibliography, keep the same file.
 * Content is grounded in the attached document + the requested topic.
 * Nothing here is specialised to a single deck or subject.
 */

const SPANISH_COUNTS = Object.freeze({
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  quince: 15,
});

const OFFICE_TYPO_FIXES = [
  [/\bslaind\w*\b/g, 'slides'],
  [/\bslied\w*\b/g, 'slides'],
  [/\bsilds\b/g, 'slides'],
  [/\bsildes\b/g, 'slides'],
  [/\bdiapositv\w*\b/g, 'diapositivas'],
  [/\blandin\w*\b/g, 'laminas'],
  [/\bbliograf\w*\b/g, 'bibliografia'],
  [/\bbibliografi\b/g, 'bibliografia'],
  [/\bamdinistrativ(\w*)\b/g, 'administrativ$1'],
  [/\badminstrativ(\w*)\b/g, 'administrativ$1'],
  [/\badminitrativ(\w*)\b/g, 'administrativ$1'],
  [/\bprofe[ei]+sonal\w*\b/g, 'profesional'],
  [/\bprofeiosnal\w*\b/g, 'profesional'],
  [/\bprofeiosnak\w*\b/g, 'profesional'],
  [/\bdocuemnt\w*\b/g, 'documento'],
  [/\bestas\s+mimas\b/g, 'estas mismas'],
  [/\beste\s+mimo\b/g, 'este mismo'],
  [/\besta\s+mima\b/g, 'esta misma'],
  [/\bd\s+elas\b/g, 'de las'],
  [/\bdelas\b/g, 'de las'],
  [/\b7ma\b/g, '7a'],
];

const ADD_VERB_RE = /\b(agreg\w*|anad\w*|insert\w*|inclu\w*|incorpor\w*|coloc\w*|sum\w*|pon(?:er|ga|le|me)?|add|append)\b/;
const SLIDE_NOUN_RE = /\b(slides?|diapositiv\w*|laminas?|ppt(?:x|s)?|powerpoint|presentacion(?:es)?|deck)\b/;
const SECTION_NOUN_RE = /\b(secciones?|apartados?|capitulos?|secciones?)\b/;
const ROW_NOUN_RE = /\b(filas?|rows?)\b/;
const BIBLIOGRAPHY_RE = /\b(referencias?(?:\s+bibliografic\w*)?|bibliograf\w*|citas?\s+bibliografic\w*|fuentes?\s+bibliografic\w*)\b/;
const SAME_FILE_RE = /\b(esta|este|la|el|estas|estos)\s+(mism[oa]s?|mim[oa]s?)\s+(ppt|pptx|ppts?|presentacion|diapositiv\w*|laminas?|archivo|deck|documento|word|docx|excel|xlsx|pdf)\b|\ben est[ea]s?\s+(mism[oa]s?\s+)?(ppt|pptx|presentacion|diapositiv\w*|documento|archivo|word|excel)\b|\bsin\s+(crear|generar|hacer)\s+(otra|otro|un\s+nuevo|una\s+nueva)\b|##\s*\S+\.(?:pptx?|docx?|xlsx?|pdf)\b/;
const PROMPT_DUMP_RE = /\bcontenido agregado segun solicitud\b|\bdocumento base:\b|^\s*anexos\s*$/im;
const WEAK_LINE_RE = /^(titulo|portada|agenda|indice|briefing ejecutivo|contenido base|slide \d+|diapositiva \d+|untitled|nueva diapositiva)(?:\s+\d+)?$/;

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function repairOfficeTypos(value = '') {
  let text = normalizeText(value);
  for (const [pattern, replacement] of OFFICE_TYPO_FIXES) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function parseCountToken(token = '') {
  const raw = String(token || '').trim();
  if (/^\d{1,2}$/.test(raw)) return Number(raw);
  return SPANISH_COUNTS[raw] || null;
}

function clampCount(n, max = 15) {
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(max, n);
}

function clip(value = '', max = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${cut.slice(0, at > 40 ? at : cut.length).trim()}…`;
}

function titleCase(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function cleanTopic(raw = '') {
  return String(raw || '')
    .replace(/\b(esta misma ppt|en esta ppt|este mismo (?:documento|archivo|word|excel)|al final|por favor|porfavor|profesional\w*|mas|mas slides?|adicionales?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRequestedTopic(text = '') {
  const sobre = text.match(/\b(?:que\s+hablen\s+)?sobre\s+(.+?)(?:\s+y\s+(?:1|un|una)\s+de\s+bibl|\s+y\s+la\s+ultima|\s*$)/);
  if (sobre) return cleanTopic(sobre[1]);
  const afterNoun = text.match(/\b(?:slides?|diapositiv\w*|laminas?|ppts?|secciones?|apartados?|capitulos?|filas?)\s+(?:mas\s+)?(?:de|con|sobre)\s+(.+?)(?:\s+y\s+(?:1|un|una)\s+de\s+bibl|\s+y\s+la\s+ultima|\s*$)/);
  if (afterNoun) return cleanTopic(afterNoun[1]);
  return '';
}

function extractRequestedCount(text = '') {
  const countWords = Object.keys(SPANISH_COUNTS).join('|');
  const unit = '(?:slides?|diapositiv\\w*|laminas?|ppts?|pptx?|secciones?|apartados?|capitulos?|filas?|rows?)';
  const patterns = [
    new RegExp(`\\b(\\d{1,2}|${countWords})\\s+${unit}\\b`),
    new RegExp(`\\b(?:agreg\\w*|anad\\w*|insert\\w*|inclu\\w*|coloc\\w*|add)\\s+(\\d{1,2}|${countWords})\\b`),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const count = clampCount(parseCountToken(match[1]));
    if (count) return count;
  }
  if (/\b(?:una|un|a)\s+(?:nueva\s+)?(?:slide|diapositiva|lamina|ppt|ppts?|seccion|apartado|fila)\b/.test(text)) return 1;
  return null;
}

function parseCitationStyle(text = '') {
  if (/\bapa\s*(?:7|vii|septima)|7(?:a|ma|\.?a)?\s+edic|\bseptima\s+edic/.test(text)) return 'apa7';
  if (/\bapa\b/.test(text)) return 'apa7';
  if (/\biso\s*690\b/.test(text)) return 'iso690';
  if (/\bchicago|mla\b/.test(text)) return 'chicago';
  return null;
}

function parseRequestedSourceCount(text = '') {
  const match = String(text || '').match(/\b(\d{1,2}|un|una|dos|tres|cuatro|cinco|seis)\s+fuentes?\b/);
  if (!match) return null;
  return clampCount(parseCountToken(match[1]), 10);
}

function parseBibliographyPlacement(text = '', count) {
  const wantsBibliography = BIBLIOGRAPHY_RE.test(text);
  if (!wantsBibliography) {
    return { wantsBibliography: false, lastIsBibliography: false, extraBibliographyUnits: 0 };
  }
  const lastCue = /\b(?:la\s+)?ultima(?:\s+es|\s+de)?\b/.test(text)
    || /\bde las\s+\d{1,2}\s+(?:la ultima|que\s+sean)\b/.test(text)
    || /\bcierre\s+(?:con\s+)?(?:bibl|referenc)/.test(text);
  const extraCount = text.match(/\by\s+(\d{1,2}|un|una)\s+(?:slides?|diapositiv\w*|laminas?|secciones?|apartados?\s+)?(?:de\s+)?(?:bibl|referenc)/);
  const extraN = extraCount ? parseCountToken(extraCount[1]) : null;
  if (lastCue || extraN === 1 || (count && extraN == null)) {
    return { wantsBibliography: true, lastIsBibliography: true, extraBibliographyUnits: 0 };
  }
  if (Number.isInteger(extraN) && extraN > 1) {
    return { wantsBibliography: true, lastIsBibliography: false, extraBibliographyUnits: extraN };
  }
  return { wantsBibliography: true, lastIsBibliography: Boolean(count), extraBibliographyUnits: 0 };
}

function inferUnit(text = '', format = '') {
  if (SLIDE_NOUN_RE.test(text) || format === 'pptx') return 'slide';
  if (SECTION_NOUN_RE.test(text) || format === 'docx') return 'section';
  if (ROW_NOUN_RE.test(text) || format === 'xlsx') return 'row';
  return format || null;
}

function parseStructuralAppendIntent(requestText = '', { format = '' } = {}) {
  const text = repairOfficeTypos(requestText);
  if (!text || !ADD_VERB_RE.test(text)) return null;
  const sameDocument = SAME_FILE_RE.test(text);
  const hasUnitNoun = SLIDE_NOUN_RE.test(text) || SECTION_NOUN_RE.test(text) || ROW_NOUN_RE.test(text);
  if (!hasUnitNoun && !sameDocument) return null;

  const count = extractRequestedCount(text);
  const topic = extractRequestedTopic(text);
  const bib = parseBibliographyPlacement(text, count);
  if (!count && !bib.wantsBibliography) return null;

  let total = count || (bib.wantsBibliography ? 1 : 0);
  if (bib.extraBibliographyUnits) total += bib.extraBibliographyUnits;
  total = clampCount(total);
  if (!total) return null;

  const unit = inferUnit(text, format);
  const lastIsBibliography = bib.lastIsBibliography || (bib.wantsBibliography && total === 1);
  return {
    kind: unit === 'section' ? 'add_sections' : unit === 'row' ? 'add_rows' : 'add_slides',
    unit: unit || 'slide',
    count: total,
    topic: topic || '',
    lastIsBibliography,
    wantsBibliography: bib.wantsBibliography,
    citationStyle: parseCitationStyle(text),
    sourceCount: parseRequestedSourceCount(text),
    sameDocument,
    confidence: hasUnitNoun || sameDocument ? 'high' : 'medium',
  };
}

function parseAddSlidesIntent(requestText = '') {
  const intent = parseStructuralAppendIntent(requestText, { format: 'pptx' });
  return intent && intent.kind === 'add_slides' ? intent : null;
}

function parseOfficeUserIntent(requestText = '', { format = '' } = {}) {
  const intent = parseStructuralAppendIntent(requestText, { format });
  if (!intent) return null;
  if (format === 'pptx' && intent.kind !== 'add_slides') return null;
  if (format === 'docx' && intent.kind !== 'add_sections' && !intent.sameDocument) {
    if (intent.kind === 'add_slides') return { ...intent, kind: 'add_sections', unit: 'section' };
  }
  if (format && format === 'docx' && intent.kind === 'add_slides' && !SLIDE_NOUN_RE.test(repairOfficeTypos(requestText))) {
    return { ...intent, kind: 'add_sections', unit: 'section' };
  }
  return intent;
}

function looksLikePromptDump(text = '') {
  return PROMPT_DUMP_RE.test(normalizeText(text));
}

function isWeakThemeLine(line = '') {
  const n = normalizeText(line);
  if (!n || n.length < 6) return true;
  if (/\btitulo viejo\b/.test(n) || /\bcontenido base\b/.test(n)) return true;
  if (/^fuente:\s+\S+\.(pptx?|docx?|xlsx?|pdf)\b/.test(n)) return true;
  if (/^slide \d+$/.test(n) || /^diapositiva \d+$/.test(n)) return true;
  return WEAK_LINE_RE.test(n);
}

function inferTheme(sourceText = '', originalName = '', requestText = '') {
  const name = String(originalName || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  const repairedName = repairOfficeTypos(name)
    .replace(/\b(editado|con anexos|completado|copy|final|v\d+)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const nameLooksTopical = repairedName && !isWeakThemeLine(repairedName);
  const lines = String(sourceText || '')
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 8 && line.length <= 90 && !isWeakThemeLine(line))
    .slice(0, 24);
  const heading = lines[0] || '';
  const fromRequest = extractRequestedTopic(repairOfficeTypos(requestText));
  const raw = (nameLooksTopical && !heading)
    ? repairedName
    : (heading || repairedName || fromRequest || 'el documento');
  return titleCase(raw);
}

function existingTitles(sourceText = '') {
  return String(sourceText || '')
    .split(/\n+/)
    .map((line) => normalizeText(line).slice(0, 80))
    .filter((line) => line.length >= 8);
}

function uniqueTitle(title, taken) {
  const base = polishEs(String(title || 'Continuación').trim());
  if (!taken.has(normalizeText(base))) return base;
  const alt = `${base} — ampliación`;
  return taken.has(normalizeText(alt)) ? `${base} (${taken.size + 1})` : alt;
}

function extractSourceAnchors(sourceText = '', limit = 8) {
  const seen = new Set();
  const anchors = [];
  for (const raw of String(sourceText || '').split(/\n+/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length < 18 || line.length > 160 || isWeakThemeLine(line) || looksLikePromptDump(line)) continue;
    const key = normalizeText(line).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push(line);
    if (anchors.length >= limit) break;
  }
  return anchors;
}

function extractSourceCitations(sourceText = '', limit = 5) {
  const seen = new Set();
  const citations = [];
  const pattern = /([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñü.''-]{2,40}(?:,\s*[A-Z]\.)?(?:\s+y\s+[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñü.''-]{2,40})?)\s*\(((?:19|20)\d{2})\)/g;
  let match;
  while ((match = pattern.exec(String(sourceText || ''))) && citations.length < limit) {
    const item = `${match[1].trim()} (${match[2]})`;
    const key = normalizeText(item);
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push(item);
  }
  return citations;
}

function isGenericExamplesTopic(topic = '') {
  return /^(ejemplos?|examples?|casos?(?:\s+de\s+estudio)?|casuistica)$/.test(normalizeText(topic));
}

function isSuccessCaseTopic(topic = '') {
  const t = normalizeText(topic);
  return /\bcasos?\s+de\s+exito\b/.test(t)
    || /\bsuccess\s+cases?\b/.test(t)
    || /\bcasos?\s+exitosos?\b/.test(t)
    || /\bejemplos?\s+de\s+casos?\b/.test(t);
}

function polishEs(value = '') {
  return String(value || '')
    .replace(/\bexito\b/gi, 'éxito')
    .replace(/\bultima\b/gi, 'última')
    .replace(/\bedicion\b/gi, 'edición')
    .replace(/\bseccion\b/gi, 'sección')
    .replace(/\bdiapositiva\b/gi, 'diapositiva');
}

function extractDocumentFacts(sourceText = '', limit = 20) {
  const seen = new Set();
  const facts = [];
  for (const raw of String(sourceText || '').split(/\n+/)) {
    const line = raw.replace(/\s+/g, ' ').replace(/^[•\-–—*]\s+/, '').trim();
    if (line.length < 18 || line.length > 240 || isWeakThemeLine(line) || looksLikePromptDump(line)) continue;
    const key = normalizeText(line).slice(0, 90);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(line);
    if (facts.length >= limit) break;
  }
  return facts;
}

function shortTitleFromFact(fact = '', max = 78) {
  const cleaned = String(fact || '').replace(/^[•\-\d.)\s]+/, '').trim();
  const clause = cleaned.split(/[.:;—–]/)[0].trim();
  if (clause.length >= 12 && clause.length <= max) return titleCase(clause);
  return titleCase(clip(cleaned, max).replace(/…$/, ''));
}

function unitLabel(topic = '', index = 0) {
  if (isSuccessCaseTopic(topic)) return `Caso ${index + 1}`;
  if (isGenericExamplesTopic(topic)) return `Ejemplo ${index + 1}`;
  return '';
}

function isSpecificRequestedTopic(topic = '') {
  const t = normalizeText(topic);
  if (!t || t.length < 4) return false;
  if (isGenericExamplesTopic(t) || isSuccessCaseTopic(t)) return false;
  return true;
}

function titleFromDocument(fact, topic, theme, index, contentCount) {
  if (isSpecificRequestedTopic(topic)) {
    return contentCount > 1 ? `${titleCase(topic)} (${index + 1})` : titleCase(topic);
  }
  if (fact) {
    const core = shortTitleFromFact(fact);
    const label = unitLabel(topic, index);
    return label ? `${label}: ${core}` : core;
  }
  if (topic) {
    return contentCount > 1 ? `${titleCase(topic)} (${index + 1})` : titleCase(topic);
  }
  return `${theme || 'Continuación'} (${index + 1})`;
}

function bulletsFromDocument({ fact, related = [], topic = '', theme = '' }) {
  const bullets = [];
  if (fact) bullets.push(clip(fact, 200));
  for (const line of related) {
    if (bullets.length >= 4) break;
    if (normalizeText(line) === normalizeText(fact)) continue;
    bullets.push(clip(line, 180));
  }
  if (!bullets.length && topic) {
    bullets.push(`Desarrollar «${clip(topic, 80)}» con hechos de este documento, no con una plantilla genérica.`);
  }
  if (bullets.length < 2 && theme) {
    bullets.push(`Anclado al documento «${clip(theme, 80)}».`);
  }
  return bullets.slice(0, 6);
}

function bibliographyUnit(theme = '', sourceText = '', { citationStyle = null, sourceCount = null } = {}) {
  const wanted = Number.isInteger(sourceCount) && sourceCount > 0 ? sourceCount : 5;
  const citations = extractSourceCitations(sourceText, wanted);
  const apa = citationStyle === 'apa7';
  const title = apa ? 'Referencias (APA 7.ª edición)' : 'Referencias bibliográficas';
  const bullets = citations.length
    ? citations.map((item) => (apa ? `${item}.` : item))
    : [`No hay citas verificables dentro del documento «${theme || 'adjunto'}». No se inventan autor, año ni DOI.`];
  return {
    title,
    bullets: bullets.slice(0, 8),
    needsVerifiedSources: Math.max(0, (Number.isInteger(sourceCount) ? sourceCount : 0) - citations.length),
  };
}

function planContentUnits(intent, ctx = {}) {
  const theme = inferTheme(ctx.sourceText, ctx.originalName, ctx.requestText);
  const topic = intent.topic || '';
  const lastBib = Boolean(intent.lastIsBibliography);
  const contentCount = lastBib ? Math.max(0, intent.count - 1) : intent.count;
  const taken = new Set(existingTitles(ctx.sourceText));
  const facts = extractDocumentFacts(ctx.sourceText);
  const units = [];

  for (let i = 0; i < contentCount; i += 1) {
    const fact = facts[i] || facts[i % Math.max(facts.length, 1)] || '';
    const related = facts.filter((line, idx) => idx !== i).slice(i, i + 3);
    const title = uniqueTitle(titleFromDocument(fact, topic, theme, i, contentCount), taken);
    taken.add(normalizeText(title));
    units.push({
      title,
      bullets: bulletsFromDocument({ fact, related, topic, theme }),
    });
  }
  if (lastBib || (intent.wantsBibliography && units.length < intent.count)) {
    const bib = bibliographyUnit(theme, ctx.sourceText, {
      citationStyle: intent.citationStyle,
      sourceCount: intent.sourceCount,
    });
    units.push({
      title: uniqueTitle(bib.title, taken),
      bullets: bib.bullets,
      needsVerifiedSources: bib.needsVerifiedSources,
    });
  }
  while (units.length < intent.count) {
    if (lastBib && units.length === intent.count - 1) {
      const bib = bibliographyUnit(theme, ctx.sourceText, {
        citationStyle: intent.citationStyle,
        sourceCount: intent.sourceCount,
      });
      units.push({
        title: uniqueTitle(bib.title, taken),
        bullets: bib.bullets,
        needsVerifiedSources: bib.needsVerifiedSources,
      });
      continue;
    }
    const extraIdx = units.length;
    const fact = facts[extraIdx % Math.max(facts.length, 1)] || '';
    units.push({
      title: uniqueTitle(titleFromDocument(fact, topic, theme, extraIdx, intent.count), taken),
      bullets: bulletsFromDocument({ fact, related: facts, topic, theme }),
    });
  }
  return units.slice(0, intent.count);
}

function buildAddSlideOperations(intent, ctx = {}) {
  if (!intent || (intent.kind !== 'add_slides' && intent.unit !== 'slide') || !intent.count) return [];
  return planContentUnits(intent, ctx).map((slide) => ({
    kind: 'add_slide',
    title: String(slide.title || 'Nueva diapositiva').slice(0, 120),
    bullets: (slide.bullets || []).map((item) => String(item).slice(0, 220)).filter(Boolean).slice(0, 8),
    needsVerifiedSources: slide.needsVerifiedSources || 0,
  }));
}

function buildAddSectionOperations(intent, ctx = {}) {
  if (!intent || (intent.kind !== 'add_sections' && intent.unit !== 'section') || !intent.count) return [];
  return planContentUnits(intent, ctx).map((section) => ({
    kind: 'append_section',
    sectionTitle: String(section.title || 'Nueva sección').slice(0, 120),
    bullets: (section.bullets || []).map((item) => String(item).slice(0, 220)).filter(Boolean).slice(0, 8),
    needsVerifiedSources: section.needsVerifiedSources || 0,
  }));
}

function buildAddRowOperations(intent, ctx = {}) {
  if (!intent || (intent.kind !== 'add_rows' && intent.unit !== 'row') || !intent.count) return [];
  return planContentUnits(intent, ctx).map((row) => ({
    kind: 'append_rows',
    rows: [[
      String(row.title || '').slice(0, 120),
      ...(row.bullets || []).slice(0, 4).map((item) => String(item).slice(0, 180)),
    ]],
  }));
}

module.exports = {
  BIBLIOGRAPHY_RE,
  buildAddRowOperations,
  buildAddSectionOperations,
  buildAddSlideOperations,
  extractDocumentFacts,
  extractSourceAnchors,
  extractSourceCitations,
  inferTheme,
  looksLikePromptDump,
  normalizeText,
  parseAddSlidesIntent,
  parseOfficeUserIntent,
  parseRequestedSourceCount,
  parseStructuralAppendIntent,
  planContentUnits,
  repairOfficeTypos,
};
