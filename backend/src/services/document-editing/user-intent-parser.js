'use strict';

/**
 * Sensitive Office-edit intent parser.
 *
 * Users type fast, informal Spanish (and English) with typos:
 *   "en esta misma ppt agrega 5 slaind mas sobre ejemplos y 1 de bibliografi"
 * The generic planner used to treat ANY "agrega…" as append_generic and dump
 * the raw prompt onto an ANEXOS slide. This module turns those requests into
 * concrete operations (N add_slide, last bibliography) without calling an LLM.
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
];

const ADD_VERB_RE = /\b(agreg\w*|anad\w*|insert\w*|inclu\w*|incorpor\w*|coloc\w*|sum\w*|pon(?:er|ga|le|me)?)\b/;
const SLIDE_NOUN_RE = /\b(slides?|diapositiv\w*|laminas?|pptx?|powerpoint|presentacion(?:es)?)\b/;
const BIBLIOGRAPHY_RE = /\b(referencias?(?:\s+bibliografic\w*)?|bibliograf\w*|citas?\s+bibliografic\w*|fuentes?\s+bibliografic\w*)\b/;
const SAME_DECK_RE = /\b(esta|este|la)\s+misma\s+(ppt|pptx|presentacion|diapositiva|archivo|deck)\b|\ben esta\s+(ppt|pptx|presentacion)\b|\bsin\s+(crear|generar|hacer)\s+(otra|un\s+nuevo|una\s+nueva)\b/;
const PROMPT_DUMP_RE = /\bcontenido agregado segun solicitud\b|\bdocumento base:\b|^\s*anexos\s*$/im;

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

function clampSlideCount(n) {
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(15, n);
}

function cleanTopic(raw = '') {
  return String(raw || '')
    .replace(/\b(esta misma ppt|en esta ppt|al final|por favor|porfavor|profesional\w*|mas|mas slides?|adicionales?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSlideTopic(text = '') {
  const sobre = text.match(/\bsobre\s+(.+?)(?:\s+y\s+(?:1|un|una)\s+de\s+bibl|\s+y\s+la\s+ultima|\s*$)/);
  if (sobre) return cleanTopic(sobre[1]);
  const afterNoun = text.match(/\b(?:slides?|diapositiv\w*|laminas?)\s+(?:mas\s+)?(?:de|con)\s+(.+?)(?:\s+y\s+(?:1|un|una)\s+de\s+bibl|\s*$)/);
  if (afterNoun) return cleanTopic(afterNoun[1]);
  return '';
}

function extractSlideCount(text = '') {
  const countWords = Object.keys(SPANISH_COUNTS).join('|');
  const patterns = [
    new RegExp(`\\b(\\d{1,2}|${countWords})\\s+(?:slides?|diapositiv\\w*|laminas?)\\b`),
    new RegExp(`\\b(?:agreg\\w*|anad\\w*|insert\\w*|inclu\\w*|coloc\\w*)\\s+(\\d{1,2}|${countWords})\\b`),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const count = clampSlideCount(parseCountToken(match[1]));
    if (count) return count;
  }
  if (/\b(?:una|un)\s+(?:nueva\s+)?(?:slide|diapositiva|lamina)\b/.test(text)) return 1;
  return null;
}

/**
 * "5 slides sobre ejemplos y 1 de bibliografía" is how users ask for
 * 5 slides whose LAST one is bibliography (owner clarification).
 * Two explicit counts greater than 1 stay compositional (5 + 2).
 */
function parseBibliographyPlacement(text = '', count) {
  const wantsBibliography = BIBLIOGRAPHY_RE.test(text);
  if (!wantsBibliography) {
    return { wantsBibliography: false, lastIsBibliography: false, extraBibliographySlides: 0 };
  }
  const lastCue = /\b(?:la\s+)?ultima(?:\s+es|\s+de)?\b/.test(text)
    || /\bde las\s+\d{1,2}\s+la ultima\b/.test(text)
    || /\bcierre\s+(?:con\s+)?(?:bibl|referenc)/.test(text);
  const extraCount = text.match(/\by\s+(\d{1,2}|un|una)\s+(?:slides?|diapositiv\w*|laminas?\s+)?(?:de\s+)?(?:bibl|referenc)/);
  const extraN = extraCount ? parseCountToken(extraCount[1]) : null;
  if (lastCue || extraN === 1 || (count && extraN == null)) {
    return { wantsBibliography: true, lastIsBibliography: true, extraBibliographySlides: 0 };
  }
  if (Number.isInteger(extraN) && extraN > 1) {
    return { wantsBibliography: true, lastIsBibliography: false, extraBibliographySlides: extraN };
  }
  return { wantsBibliography: true, lastIsBibliography: Boolean(count), extraBibliographySlides: 0 };
}

function parseAddSlidesIntent(requestText = '') {
  const text = repairOfficeTypos(requestText);
  if (!text) return null;
  const hasAddVerb = ADD_VERB_RE.test(text);
  const hasSlideNoun = SLIDE_NOUN_RE.test(text);
  const sameDocument = SAME_DECK_RE.test(text);
  if (!hasAddVerb) return null;
  if (!hasSlideNoun && !sameDocument) return null;

  const count = extractSlideCount(text);
  const topic = extractSlideTopic(text);
  const bib = parseBibliographyPlacement(text, count);
  if (!count && !bib.wantsBibliography) return null;

  let total = count || (bib.wantsBibliography ? 1 : 0);
  if (bib.extraBibliographySlides) total += bib.extraBibliographySlides;
  total = clampSlideCount(total);
  if (!total) return null;

  const lastIsBibliography = bib.lastIsBibliography || (bib.wantsBibliography && total === 1);
  return {
    kind: 'add_slides',
    count: total,
    topic: topic || '',
    lastIsBibliography,
    wantsBibliography: bib.wantsBibliography,
    sameDocument,
    confidence: hasSlideNoun || sameDocument ? 'high' : 'medium',
  };
}

function parseOfficeUserIntent(requestText = '', { format = '' } = {}) {
  if (!format || format === 'pptx') {
    const slides = parseAddSlidesIntent(requestText);
    if (slides) return slides;
  }
  return null;
}

function looksLikePromptDump(text = '') {
  return PROMPT_DUMP_RE.test(normalizeText(text));
}

function isWeakThemeLine(line = '') {
  const n = normalizeText(line);
  if (!n || n.length < 6) return true;
  if (/\btitulo viejo\b/.test(n) || /\bcontenido base\b/.test(n)) return true;
  return /^(titulo|portada|agenda|indice|briefing ejecutivo|slide \d+|diapositiva \d+)(?:\s+\d+)?$/.test(n);
}

function inferTheme(sourceText = '', originalName = '', requestText = '') {
  const name = String(originalName || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  const repairedName = repairOfficeTypos(name).replace(/\b(editado|con anexos|completado)\b/g, '').trim();
  const nameLooksTopical = repairedName && !isWeakThemeLine(repairedName);
  const lines = String(sourceText || '')
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 8 && line.length <= 90 && !isWeakThemeLine(line))
    .slice(0, 24);
  const topicalHeading = lines.find((line) => /gestion|administr|empresa|estrateg|planific|operacion|finanza/i.test(line));
  const heading = topicalHeading || lines[0] || '';
  const fromRequest = extractSlideTopic(repairOfficeTypos(requestText));
  const preferName = nameLooksTopical && (
    /administrativ|gestion|empresa/.test(normalizeText(repairedName))
    || !heading
  );
  const raw = preferName
    ? repairedName
    : (heading || repairedName || fromRequest || 'gestión profesional');
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function existingTitles(sourceText = '') {
  return String(sourceText || '')
    .split(/\n+/)
    .map((line) => normalizeText(line).slice(0, 80))
    .filter((line) => line.length >= 8);
}

function uniqueTitle(title, taken) {
  const base = String(title || 'Nueva diapositiva').trim();
  if (!taken.has(normalizeText(base))) return base;
  const alt = `${base} — caso aplicado`;
  return taken.has(normalizeText(alt)) ? `${base} (${taken.size + 1})` : alt;
}

function administrationExampleSlides() {
  return [
    {
      title: 'Caso 1 — Pyme comercial que formaliza su gestión',
      bullets: [
        'Diagnóstico: compras, tesorería e inventario dependen de personas, no de procesos.',
        'Decisión: implantar un ciclo semanal de planificación, ejecución y control de caja.',
        'Evidencia: tablero con días de cobro, quiebre de stock y cumplimiento de presupuesto.',
        'Aprendizaje: formalizar no frena la venta; reduce improvisación y pérdidas invisibles.',
      ],
    },
    {
      title: 'Caso 2 — Área pública que alinea servicio y control',
      bullets: [
        'Problema: trámites sin dueño, tiempos opacos y quejas que no se convierten en mejora.',
        'Diseño: mapa de proceso, responsables, plazos y umbral de escalamiento.',
        'Indicadores: tiempo de ciclo, porcentaje de expedientes completos y retrabajo.',
        'Gobierno: reunión breve de seguimiento con acuerdos escritos y fecha de cierre.',
      ],
    },
    {
      title: 'Caso 3 — Operaciones de servicios con ritmo 30-60-90',
      bullets: [
        '30 días: diagnosticar cuellos de botella, roles reales y datos que ya existen.',
        '60 días: rediseñar responsabilidades, tablero y cadencia de revisión.',
        '90 días: estandarizar el proceso crítico y retirar excepciones injustificadas.',
        'Criterio: cada iniciativa tiene dueño, métrica, fecha y evidencia de cierre.',
      ],
    },
    {
      title: 'Caso 4 — Empresa en crecimiento que protege la velocidad',
      bullets: [
        'Riesgo: el crecimiento diluye control de costos, calidad y caja.',
        'Control proporcional: alertas tempranas, no burocracia extra.',
        'Finanzas y operación se revisan juntas: margen, capacidad y promesa al cliente.',
        'Resultado: decisiones más rápidas porque el criterio ya está escrito.',
      ],
    },
    {
      title: 'Caso 5 — Comité que convierte indicadores en decisiones',
      bullets: [
        'Un tablero útil muestra causa probable y acción, no solo semáforos.',
        'Pocos KPI: productividad, caja, calidad de servicio y cumplimiento de plan.',
        'Cada desviación exige dueño, plazo y evidencia de corrección.',
        'La reunión dura menos cuando los datos llegan antes, no durante.',
      ],
    },
  ];
}

function topicDrivenSlides(topic, theme, count) {
  const subject = topic || theme;
  const lower = String(subject || 'el tema').toLowerCase();
  const bank = [
    {
      title: subject.charAt(0).toUpperCase() + subject.slice(1),
      bullets: [
        `Definir el problema real de ${lower} y el criterio con el que se decidirá.`,
        `Separar hechos, supuestos y restricciones de ${theme}.`,
        'Traducir el diagnóstico en 2 o 3 decisiones ejecutables.',
        'Dejar visible qué evidencia confirmará que la decisión funcionó.',
      ],
    },
    {
      title: `Cómo se implementa ${lower}`,
      bullets: [
        'Asignar dueño, recursos y fecha de la primera entrega visible.',
        'Documentar el flujo crítico para no depender de una sola persona.',
        'Acordar umbrales: qué se aprueba en el equipo y qué escala.',
        'Revisar avance en ciclos cortos y registrar desviaciones.',
      ],
    },
    {
      title: `Indicadores para ${lower}`,
      bullets: [
        'Medir resultado, no solo actividad: costo, tiempo, calidad e impacto.',
        'Elegir pocos indicadores que disparen una acción concreta.',
        'Mostrar tendencia y causa probable, no un número aislado.',
        'Retirar métricas que no cambian ninguna decisión.',
      ],
    },
    {
      title: `Riesgos de no gestionar ${lower}`,
      bullets: [
        'Improvisación: costos ocultos, retrabajo y promesas incumplidas.',
        'Dependencia de personas clave sin respaldo de proceso.',
        'Decisiones tardías porque la información llega tarde o incompleta.',
        'Control desproporcionado que aparece solo después de la crisis.',
      ],
    },
    {
      title: `Plan 30-60-90 para ${lower}`,
      bullets: [
        '30 días: diagnóstico, datos actuales y priorización de un proceso crítico.',
        '60 días: rediseño de roles, tablero y cadencia de seguimiento.',
        '90 días: estandarizar, medir y ajustar con evidencia.',
        'Cierre: tres compromisos con dueño, fecha y medio de verificación.',
      ],
    },
  ];
  return bank.slice(0, Math.max(1, count));
}

function bibliographySlide(theme = '') {
  const text = normalizeText(`${theme}`);
  const admin = /\b(administrativ|gestion|empresa|directiv|organizacion)\b/.test(text);
  if (admin) {
    return {
      title: 'Referencias bibliográficas',
      bullets: [
        'Chiavenato, I. (2019). Introducción a la teoría general de la administración. McGraw-Hill.',
        'Robbins, S. P. y Coulter, M. (2021). Administración. Pearson.',
        'Koontz, H., Weihrich, H. y Cannice, M. Administración: una perspectiva global. McGraw-Hill.',
        'Mintzberg, H. (2009). Managing. Berrett-Koehler.',
        'ISO 9001:2015. Sistemas de gestión de la calidad. Requisitos.',
      ],
    };
  }
  return {
    title: 'Referencias bibliográficas',
    bullets: [
      `Fuentes primarias del tema «${theme || 'el documento'}»: normas, reportes institucionales y literatura del campo.`,
      'Citar autor, año, título y editorial u organismo emisor.',
      'Priorizar ediciones recientes y documentos verificables; no inventar URLs ni cifras.',
      'Separar fuentes académicas, normativas y evidencia interna de la organización.',
    ],
  };
}

function isAdministrationTheme(theme = '', topic = '') {
  const text = normalizeText(`${theme} ${topic}`);
  return /\b(administrativ|gestion|empresa|pyme|municipal|organizacion|directiv)\b/.test(text);
}

function planContentSlides(intent, ctx = {}) {
  const theme = inferTheme(ctx.sourceText, ctx.originalName, ctx.requestText);
  const topic = intent.topic || '';
  const lastBib = Boolean(intent.lastIsBibliography);
  const contentCount = lastBib ? Math.max(0, intent.count - 1) : intent.count;
  const taken = new Set(existingTitles(ctx.sourceText));
  const useExamples = /\bejemplos?\b/.test(normalizeText(topic)) || (!topic && isAdministrationTheme(theme));
  const bank = useExamples && isAdministrationTheme(theme, topic)
    ? administrationExampleSlides()
    : topicDrivenSlides(topic || theme, theme, Math.max(contentCount, 1));
  const slides = [];
  for (let i = 0; i < contentCount; i += 1) {
    const raw = bank[i] || bank[i % bank.length] || topicDrivenSlides(topic || theme, theme, 1)[0];
    const title = uniqueTitle(raw.title, taken);
    taken.add(normalizeText(title));
    slides.push({
      title,
      bullets: (raw.bullets || []).filter(Boolean).slice(0, 6),
    });
  }
  if (lastBib || (intent.wantsBibliography && slides.length < intent.count)) {
    const bib = bibliographySlide(theme);
    slides.push({ title: uniqueTitle(bib.title, taken), bullets: bib.bullets });
  }
  while (slides.length < intent.count) {
    if (lastBib && slides.length === intent.count - 1) {
      const bib = bibliographySlide(theme);
      slides.push({ title: uniqueTitle(bib.title, taken), bullets: bib.bullets });
      continue;
    }
    const extra = topicDrivenSlides(topic || theme, theme, 5)[slides.length % 5];
    slides.push({ title: uniqueTitle(extra.title, taken), bullets: extra.bullets });
  }
  return slides.slice(0, intent.count);
}

function buildAddSlideOperations(intent, ctx = {}) {
  if (!intent || intent.kind !== 'add_slides' || !intent.count) return [];
  return planContentSlides(intent, ctx).map((slide) => ({
    kind: 'add_slide',
    title: String(slide.title || 'Nueva diapositiva').slice(0, 120),
    bullets: (slide.bullets || []).map((item) => String(item).slice(0, 220)).filter(Boolean).slice(0, 8),
  }));
}

module.exports = {
  BIBLIOGRAPHY_RE,
  buildAddSlideOperations,
  inferTheme,
  looksLikePromptDump,
  normalizeText,
  parseAddSlidesIntent,
  parseOfficeUserIntent,
  repairOfficeTypos,
};
