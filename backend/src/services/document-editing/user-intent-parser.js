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
const SLIDE_NOUN_RE = /\b(slides?|diapositiv\w*|laminas?|pptx?|powerpoint|presentacion(?:es)?|deck)\b/;
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
  if (/\b(?:una|un|a)\s+(?:nueva\s+)?(?:slide|diapositiva|lamina|seccion|apartado|fila)\b/.test(text)) return 1;
  return null;
}

function parseCitationStyle(text = '') {
  if (/\bapa\s*(?:7|vii|septima)|7(?:a|ma|\.?a)?\s+edic|\bseptima\s+edic/.test(text)) return 'apa7';
  if (/\bapa\b/.test(text)) return 'apa7';
  if (/\biso\s*690\b/.test(text)) return 'iso690';
  if (/\bchicago|mla\b/.test(text)) return 'chicago';
  return null;
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

function successCaseAngles(theme) {
  const field = theme || 'la organización';
  return [
    {
      title: `Caso de éxito 1 — Resultado medible en ${field}`,
      bulletsFor(anchor) {
        return [
          anchor
            ? `Situación inicial tomada del documento: «${clip(anchor, 140)}».`
            : `Situación inicial: un proceso crítico de ${field} sin dueño, evidencia ni cadencia.`,
          'Intervención: se definió un responsable, un indicador y una revisión semanal.',
          'Resultado: menos retrabajo, tiempos más cortos y decisiones con evidencia.',
          'Transferencia: el mismo esquema (dueño + métrica + cadencia) se replica en otros procesos.',
        ];
      },
    },
    {
      title: `Caso de éxito 2 — Coordinación entre áreas de ${field}`,
      bulletsFor(anchor) {
        return [
          'Problema: cada área optimizaba lo propio y el resultado conjunto se deterioraba.',
          anchor ? `El documento señala: «${clip(anchor, 130)}».` : 'Se armó un tablero compartido con tres indicadores comunes.',
          'Acuerdo: umbrales de escalamiento y una reunión breve de desbloqueo.',
          'Aprendizaje: la coordinación mejora cuando el criterio de éxito es el mismo para todos.',
        ];
      },
    },
    {
      title: `Caso de éxito 3 — Control proporcional en ${field}`,
      bulletsFor() {
        return [
          'Riesgo evitado: controles tardíos que solo aparecen después de la crisis.',
          'Diseño: alertas tempranas, no formularios extra ni burocracia.',
          'Evidencia: desviaciones se ven en el ciclo, no al cierre del periodo.',
          'Criterio: cada control tiene dueño, umbral y acción predefinida.',
        ];
      },
    },
    {
      title: `Caso de éxito 4 — Ejecución 30-60-90 en ${field}`,
      bulletsFor() {
        return [
          '30 días: diagnóstico honesto, datos actuales y un proceso crítico priorizado.',
          '60 días: roles, tablero y cadencia de seguimiento ya en marcha.',
          '90 días: el hábito queda estandarizado y se retiran excepciones injustificadas.',
          'Cierre: tres compromisos con fecha, responsable y medio de verificación.',
        ];
      },
    },
  ];
}

function exampleAngles(subject, theme, anchors = []) {
  const lower = String(subject || theme || 'el tema').toLowerCase();
  return [
    {
      title: `Ejemplo 1 — ${titleCase(subject)}`,
      bulletsFor(anchor) {
        return [
          anchor
            ? `Punto de partida del documento: «${clip(anchor, 140)}».`
            : `Definir un caso real de ${lower} con actor, contexto y restricción.`,
          `Decisión: qué se cambia, quién lo ejecuta y en qué plazo.`,
          `Evidencia: dato, hito o entrega que demuestra que la decisión funcionó.`,
          `Aprendizaje transferible a otros casos de ${theme}.`,
        ];
      },
    },
    {
      title: `Ejemplo 2 — Cómo se aplica ${lower}`,
      bulletsFor(anchor) {
        return [
          anchor ? `Tomar «${clip(anchor, 120)}» y convertirlo en un flujo con dueño.` : `Asignar dueño, recursos y primera entrega visible.`,
          'Documentar el paso crítico para no depender de una sola persona.',
          'Acordar umbrales: qué se aprueba en el equipo y qué escala.',
          'Revisar avance en ciclos cortos y registrar desviaciones.',
        ];
      },
    },
    {
      title: `Ejemplo 3 — Indicadores de ${lower}`,
      bulletsFor(anchor) {
        return [
          'Medir resultado, no solo actividad: costo, tiempo, calidad e impacto.',
          anchor ? `Vincular un indicador a «${clip(anchor, 110)}».` : `Elegir pocos indicadores que disparen una acción concreta.`,
          'Mostrar tendencia y causa probable, no un número aislado.',
          'Retirar métricas que no cambian ninguna decisión.',
        ];
      },
    },
    {
      title: `Ejemplo 4 — Riesgos de no gestionar ${lower}`,
      bulletsFor() {
        return [
          'Improvisación: costos ocultos, retrabajo y promesas incumplidas.',
          'Dependencia de personas clave sin respaldo de proceso.',
          'Decisiones tardías porque la información llega tarde o incompleta.',
          'Control desproporcionado que aparece solo después de la crisis.',
        ];
      },
    },
    {
      title: `Ejemplo 5 — Plan 30-60-90 para ${lower}`,
      bulletsFor() {
        return [
          '30 días: diagnóstico, datos actuales y un proceso crítico priorizado.',
          '60 días: roles, tablero y cadencia de seguimiento.',
          '90 días: estandarizar, medir y ajustar con evidencia.',
          'Cierre: tres compromisos con dueño, fecha y medio de verificación.',
        ];
      },
    },
  ];
}

function topicDrivenAngles(topic, theme) {
  const subject = topic || theme;
  const lower = String(subject || 'el tema').toLowerCase();
  return [
    {
      title: titleCase(subject),
      bulletsFor(anchor) {
        return [
          `Definir el problema real de ${lower} y el criterio con el que se decidirá.`,
          anchor ? `Anclar la lectura en «${clip(anchor, 140)}».` : `Separar hechos, supuestos y restricciones de ${theme}.`,
          'Traducir el diagnóstico en 2 o 3 decisiones ejecutables.',
          'Dejar visible qué evidencia confirmará que la decisión funcionó.',
        ];
      },
    },
    {
      title: `Cómo se implementa ${lower}`,
      bulletsFor() {
        return [
          'Asignar dueño, recursos y fecha de la primera entrega visible.',
          'Documentar el flujo crítico para no depender de una sola persona.',
          'Acordar umbrales: qué se aprueba en el equipo y qué escala.',
          'Revisar avance en ciclos cortos y registrar desviaciones.',
        ];
      },
    },
    {
      title: `Indicadores para ${lower}`,
      bulletsFor() {
        return [
          'Medir resultado, no solo actividad: costo, tiempo, calidad e impacto.',
          'Elegir pocos indicadores que disparen una acción concreta.',
          'Mostrar tendencia y causa probable, no un número aislado.',
          'Retirar métricas que no cambian ninguna decisión.',
        ];
      },
    },
    {
      title: `Riesgos de no gestionar ${lower}`,
      bulletsFor() {
        return [
          'Improvisación: costos ocultos, retrabajo y promesas incumplidas.',
          'Dependencia de personas clave sin respaldo de proceso.',
          'Decisiones tardías porque la información llega tarde o incompleta.',
          'Control desproporcionado que aparece solo después de la crisis.',
        ];
      },
    },
    {
      title: `Plan 30-60-90 para ${lower}`,
      bulletsFor() {
        return [
          '30 días: diagnóstico, datos actuales y priorización de un proceso crítico.',
          '60 días: rediseño de roles, tablero y cadencia de seguimiento.',
          '90 días: estandarizar, medir y ajustar con evidencia.',
          'Cierre: tres compromisos con dueño, fecha y medio de verificación.',
        ];
      },
    },
  ];
}

function bibliographySlide(theme = '', sourceText = '', citationStyle = null) {
  const citations = extractSourceCitations(sourceText);
  const apa = citationStyle === 'apa7';
  const title = apa ? 'Referencias (APA 7.ª edición)' : 'Referencias bibliográficas';
  const fromSource = citations.map((item) => (
    apa
      ? `${item}. Formato APA 7: Apellido, A. A. (Año). Título en oración. Fuente.`
      : `${item}. Conservar la cita tal como aparece en el documento base.`
  ));
  const bullets = apa
    ? [
      'American Psychological Association. (2020). Publication manual of the American Psychological Association (7.ª ed.).',
      ...fromSource,
      `Incluir solo fuentes verificables del campo «${theme || 'el documento'}»; no inventar DOI, URLs ni años.`,
      'Libro: Apellido, A. A. (Año). Título en cursiva (ed.). Editorial.',
      'Artículo: Apellido, A. A., y Apellido, B. B. (Año). Título del artículo. Revista, volumen(número), pp. xx–xx. https://doi.org/xx',
    ]
    : (fromSource.length
      ? [
        ...fromSource,
        'Completar título, editorial u organismo solo cuando figure en la fuente original.',
        'No inventar URLs, DOI ni años ausentes del expediente.',
      ]
      : [
        `Fuentes primarias del tema «${theme || 'el documento'}»: normas, reportes institucionales y literatura del campo.`,
        'Citar autor, año, título y editorial u organismo emisor.',
        'Priorizar ediciones recientes y documentos verificables; no inventar URLs ni cifras.',
        'Separar fuentes académicas, normativas y evidencia interna de la organización.',
      ]);
  return { title, bullets: bullets.filter(Boolean).slice(0, 6) };
}

function planContentUnits(intent, ctx = {}) {
  const theme = inferTheme(ctx.sourceText, ctx.originalName, ctx.requestText);
  const topic = intent.topic || '';
  const lastBib = Boolean(intent.lastIsBibliography);
  const contentCount = lastBib ? Math.max(0, intent.count - 1) : intent.count;
  const taken = new Set(existingTitles(ctx.sourceText));
  const anchors = extractSourceAnchors(ctx.sourceText);
  const subject = (isGenericExamplesTopic(topic) || isSuccessCaseTopic(topic)) ? theme : (topic || theme);
  const angles = isSuccessCaseTopic(topic)
    ? successCaseAngles(subject)
    : (isGenericExamplesTopic(topic) || !topic
      ? exampleAngles(subject, theme, anchors)
      : topicDrivenAngles(subject, theme));

  const units = [];
  for (let i = 0; i < contentCount; i += 1) {
    const angle = angles[i] || angles[i % angles.length];
    const anchor = anchors[i] || anchors[0] || '';
    const title = uniqueTitle(angle.title, taken);
    taken.add(normalizeText(title));
    units.push({
      title,
      bullets: (typeof angle.bulletsFor === 'function' ? angle.bulletsFor(anchor) : angle.bullets || [])
        .filter(Boolean)
        .slice(0, 6),
    });
  }
  if (lastBib || (intent.wantsBibliography && units.length < intent.count)) {
    const bib = bibliographySlide(theme, ctx.sourceText, intent.citationStyle);
    units.push({ title: uniqueTitle(bib.title, taken), bullets: bib.bullets });
  }
  while (units.length < intent.count) {
    if (lastBib && units.length === intent.count - 1) {
      const bib = bibliographySlide(theme, ctx.sourceText, intent.citationStyle);
      units.push({ title: uniqueTitle(bib.title, taken), bullets: bib.bullets });
      continue;
    }
    const extraBank = isSuccessCaseTopic(topic)
      ? successCaseAngles(subject)
      : (isGenericExamplesTopic(topic) ? exampleAngles(subject, theme) : topicDrivenAngles(subject, theme));
    const extra = extraBank[units.length % extraBank.length];
    units.push({
      title: uniqueTitle(extra.title, taken),
      bullets: extra.bulletsFor(anchors[units.length] || ''),
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
  }));
}

function buildAddSectionOperations(intent, ctx = {}) {
  if (!intent || (intent.kind !== 'add_sections' && intent.unit !== 'section') || !intent.count) return [];
  return planContentUnits(intent, ctx).map((section) => ({
    kind: 'append_section',
    sectionTitle: String(section.title || 'Nueva sección').slice(0, 120),
    bullets: (section.bullets || []).map((item) => String(item).slice(0, 220)).filter(Boolean).slice(0, 8),
  }));
}

module.exports = {
  BIBLIOGRAPHY_RE,
  buildAddSectionOperations,
  buildAddSlideOperations,
  extractSourceAnchors,
  inferTheme,
  looksLikePromptDump,
  normalizeText,
  parseAddSlidesIntent,
  parseOfficeUserIntent,
  parseStructuralAppendIntent,
  repairOfficeTypos,
};
