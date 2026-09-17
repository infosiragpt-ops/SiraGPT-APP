'use strict';

/**
 * Parse PPT follow-up intent: add Nth slide / "una séptima" / conclusiones,
 * without treating a color-only request as an add-slide.
 */

const ORDINALS = Object.freeze({
  primera: 1,
  primer: 1,
  first: 1,
  segunda: 2,
  segundo: 2,
  second: 2,
  tercera: 3,
  tercer: 3,
  third: 3,
  cuarta: 4,
  cuarto: 4,
  fourth: 4,
  quinta: 5,
  quinto: 5,
  fifth: 5,
  sexta: 6,
  sexto: 6,
  sixth: 6,
  septima: 7,
  septimo: 7,
  seventh: 7,
  octava: 8,
  octavo: 8,
  eighth: 8,
  novena: 9,
  noveno: 9,
  ninth: 9,
  decima: 10,
  decimo: 10,
  tenth: 10,
});

const COUNT_WORDS = Object.freeze({
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
});

const ADD_VERB_RE = /\b(agreg\w*|anad\w*|insert\w*|inclu\w*|incorpor\w*|sum\w*|pon(?:er|ga|le|me)?|add|append)\b/;
const SLIDE_NOUN_RE = /\b(slides?|diapositiv\w*|laminas?|ppt(?:x|s)?|powerpoint|presentacion(?:es)?|deck)\b/;

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCountToken(token = '') {
  const raw = String(token || '').trim();
  if (/^\d{1,2}$/.test(raw)) return Number(raw);
  return COUNT_WORDS[raw] || null;
}

function titleCase(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function extractSlideTitle(text) {
  const t = normalizeText(text);
  if (/\bconclus/.test(t)) return 'Conclusiones';
  if (/\bgracias|thanks\b/.test(t)) return 'Gracias';
  if (/\bbibliograf|referencias?\b/.test(t)) return 'Referencias';
  const de = t.match(/\b(?:de|sobre)\s+([a-z0-9][\w\s-]{1,40})$/);
  if (de) {
    const cleaned = de[1].replace(/\b(por favor|please|al final|ahora)\b/g, '').trim();
    if (cleaned.length >= 3) return titleCase(cleaned);
  }
  return null;
}

function parsePptFollowupIntent(requestText = '') {
  const raw = String(requestText || '');
  const text = normalizeText(raw);
  if (!text) {
    return { wantsAddSlide: false, addCount: 0, targetTotal: null, title: null };
  }

  const addVerb = ADD_VERB_RE.test(text);
  const slideNoun = SLIDE_NOUN_RE.test(text);

  let targetTotal = null;
  const ordKeys = Object.keys(ORDINALS).sort((a, b) => b.length - a.length);
  for (const key of ordKeys) {
    if (new RegExp(`\\b${key}\\b`).test(text)) {
      targetTotal = ORDINALS[key];
      break;
    }
  }

  const unit = '(?:slides?|diapositiv\\w*|laminas?|ppt(?:x|s)?)';
  const countWords = Object.keys(COUNT_WORDS).join('|');
  const nUnit = text.match(new RegExp(`\\b(\\d{1,2}|${countWords})\\s+${unit}\\b`));
  const statedCount = nUnit ? parseCountToken(nUnit[1]) : null;
  const addN = text.match(new RegExp(`\\b(?:agreg\\w*|anad\\w*|insert\\w*|inclu\\w*|add)\\s+(\\d{1,2}|${countWords})\\b`));
  const addNCount = addN ? parseCountToken(addN[1]) : null;

  // "7 diapositivas" / "siete slides" is a TARGET count, not "add 7 slides".
  if (statedCount && slideNoun) {
    targetTotal = targetTotal || statedCount;
  }

  let addCount = 0;
  if (targetTotal) {
    addCount = 1;
  } else if (addVerb && addNCount) {
    addCount = addNCount;
  } else if (addVerb && statedCount) {
    addCount = statedCount;
  } else if (addVerb && slideNoun) {
    addCount = 1;
  } else if (addVerb && /\bconclus|gracias|thanks\b/.test(text)) {
    addCount = 1;
  }

  const title = extractSlideTitle(text);
  const createVerb = /\b(crea(?:r|me|nos)?|cr[eé]ame|genera(?:r|me|nos)?|haz(?:me|nos)?|arma|dise[nñ]a|make|create|escribe(?:r|me|nos)?|write)\b/.test(text);
  // Create-a-deck ("crea 6 diapositivas") is a TARGET count, not add-slide.
  // Follow-ups with an add verb still want a new slide.
  const wantsAddSlide = (addCount > 0 || Boolean(targetTotal)) && (!createVerb || addVerb);

  return {
    wantsAddSlide,
    addCount: wantsAddSlide ? Math.max(1, addCount || 1) : 0,
    targetTotal,
    title: title || (wantsAddSlide ? 'Nueva diapositiva' : null),
  };
}

function resolveTargetSlideCount(intent, currentCount) {
  const current = Number(currentCount) || 0;
  if (!intent || !intent.wantsAddSlide) return current;
  if (Number.isInteger(intent.targetTotal)) {
    return Math.max(intent.targetTotal, current);
  }
  return current + Math.max(1, intent.addCount || 1);
}

function buildSlideBullets({ existingTexts = [], title } = {}) {
  const heading = String(title || '');
  if (/^conclus/i.test(heading)) {
    const points = (existingTexts || [])
      .map((t) => String(t || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length >= 8 && !/^conclus/i.test(t) && !/^gracias/i.test(t))
      .slice(0, 5)
      .map((t) => t.slice(0, 160));
    if (points.length) return points;
    return [
      'Síntesis de los temas desarrollados en las diapositivas anteriores.',
      'Ideas clave para recordar y aplicar.',
      'Cierre y próximos pasos.',
    ];
  }
  return [];
}

module.exports = {
  ORDINALS,
  parsePptFollowupIntent,
  resolveTargetSlideCount,
  extractSlideTitle,
  buildSlideBullets,
  normalizeText,
};
