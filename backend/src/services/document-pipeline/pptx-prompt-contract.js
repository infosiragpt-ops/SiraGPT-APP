'use strict';

const DEFAULT_TOTAL_SLIDES = 8;
const MIN_TOTAL_SLIDES = 2;
const MAX_TOTAL_SLIDES = 40;

const GENERIC_META_RE = /\b(?:pipeline|multiagente|generado por|contenido editable|validaci[oó]n t[eé]cnica|estructura premium|presentaci[oó]n profesional)\b/i;
const CLOSING_RE = /\b(?:cierre|conclus|recomend|pr[oó]ximos pasos|plan de acci[oó]n|decisi[oó]n)\b/i;
const STRONG_NUMERIC_CLAIM_RE = /(?:[$€£]|S\/)\s*\d[\d.,]*|\b\d+(?:[.,]\d+)?\s*(?:%|por\s+ciento|millones?|billones?|mil\s+millones|usd|eur|d[oó]lares?|euros?)(?=\s|[.,;:!?)]|$)|(?<![\d-])\b(?!30\s+d[ií]as\b|60\s+d[ií]as\b|90\s+d[ií]as\b)\d+(?:[.,]\d+)?\s+[a-záéíóúüñ]{3,}(?=\s|[.,;:!?)]|$)/gi;

function clean(value, max = 240) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function normalize(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEvidence(value = '') {
  return normalize(value).replace(/\s*([%$€£/.,])\s*/g, '$1');
}

function clampTotalSlides(value, fallback = DEFAULT_TOTAL_SLIDES) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(MIN_TOTAL_SLIDES, Math.min(MAX_TOTAL_SLIDES, number));
}

function buildPptxDeckManifest({ slideTarget, references = [] } = {}) {
  const explicit = slideTarget !== null && slideTarget !== undefined && slideTarget !== ''
    && Number.isInteger(Number(slideTarget));
  const totalSlides = clampTotalSlides(slideTarget);
  const includeAgenda = totalSlides >= 5;
  const includeReferences = Array.isArray(references) && references.length > 0 && totalSlides >= 7;
  const shellSlides = 1 + (includeAgenda ? 1 : 0) + (includeReferences ? 1 : 0);
  return {
    explicit,
    totalSlides,
    contentSlides: Math.max(1, totalSlides - shellSlides),
    includeCover: true,
    includeAgenda,
    includeReferences,
    shellSlides,
  };
}

function slideText(slide = {}) {
  const parts = [slide.title, slide.kicker, slide.summary, slide.takeaway, slide.insight, slide.notes];
  for (const bullet of slide.bullets || []) parts.push(bullet?.label, bullet?.text || bullet);
  for (const item of slide.support || []) parts.push(item);
  for (const column of slide.columns || []) parts.push(column?.heading, ...(column?.items || []));
  if (slide.stat) parts.push(slide.stat.value, slide.stat.caption, slide.stat.source);
  if (slide.chart) parts.push(slide.chart.title, ...(slide.chart.labels || []), ...(slide.chart.values || []), slide.chart.unit, slide.chart.source);
  if (slide.quote) parts.push(slide.quote, slide.attribution);
  return parts.filter(Boolean).join(' ');
}

function visibleSlideText(slide = {}) {
  return slideText({ ...slide, notes: '' });
}

const CITATION_TOKEN_STOPWORDS = new Set([
  'para', 'como', 'desde', 'sobre', 'entre', 'este', 'esta', 'estos', 'estas', 'that', 'with', 'from',
  'resultados', 'estudio', 'evidencia', 'analisis', 'conclusiones', 'datos', 'fuente', 'sources', 'study',
]);

function sourceLabel(reference = {}) {
  const match = String(reference?.name || '').match(/^\[(S\d{1,2})\]/i);
  return match ? `[${match[1].toUpperCase()}]` : null;
}

function citationTokens(value = '') {
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !CITATION_TOKEN_STOPWORDS.has(token));
}

function attachSourceCitations(plan = {}, { referenceBriefs = [] } = {}) {
  const references = (Array.isArray(referenceBriefs) ? referenceBriefs : [])
    .map((reference) => ({
      label: sourceLabel(reference),
      tokens: new Set(citationTokens(`${reference?.name || ''} ${reference?.excerpt || ''}`)),
    }))
    .filter((reference) => reference.label);
  if (!references.length) return plan;
  const knownLabels = new Set(references.map((reference) => reference.label));
  const slides = (Array.isArray(plan.slides) ? plan.slides : []).map((slide, index) => {
    if ((slide.layout || 'bullets') === 'section') return { ...slide, sourceCitations: [] };
    const explicit = (Array.isArray(slide.sourceCitations) ? slide.sourceCitations : Array.isArray(slide.citations) ? slide.citations : [])
      .map((citation) => String(citation || '').toUpperCase())
      .filter((citation) => knownLabels.has(citation));
    if (explicit.length) return { ...slide, sourceCitations: Array.from(new Set(explicit)).slice(0, 3) };
    const tokens = new Set(citationTokens(visibleSlideText(slide)));
    const ranked = references.map((reference) => ({
      label: reference.label,
      score: Array.from(tokens).reduce((score, token) => score + (reference.tokens.has(token) ? 1 : 0), 0),
    })).sort((left, right) => right.score - left.score);
    const matched = ranked.filter((item) => item.score > 0).slice(0, 2).map((item) => item.label);
    return {
      ...slide,
      sourceCitations: matched.length ? matched : [references[index % references.length].label],
    };
  });
  return { ...plan, slides };
}

function uniqueSlides(slides = []) {
  const seen = new Set();
  const result = [];
  for (const slide of Array.isArray(slides) ? slides : []) {
    if (!slide || typeof slide !== 'object') continue;
    const key = normalize(slide.title || slideText(slide)).slice(0, 120);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(slide);
  }
  return result;
}

function overviewSlide(plan, sourceSlides) {
  const bullets = [];
  for (const slide of sourceSlides) {
    const first = (slide.bullets || [])[0];
    const text = clean(first?.text || first || slide.summary || slide.takeaway, 110);
    if (!text) continue;
    bullets.push({ label: clean(slide.title, 28), text });
    if (bullets.length >= 4) break;
  }
  return {
    layout: 'bullets',
    title: 'Síntesis ejecutiva',
    kicker: 'Mensaje central',
    summary: clean(plan.thesis || `${plan.topic || 'El tema'} se resume en decisiones y acciones concretas.`, 190),
    bullets,
    takeaway: clean(plan.thesis || bullets[0]?.text || '', 120),
    notes: 'Presentar el mensaje central, explicar las implicancias y cerrar con la decisión principal.',
  };
}

function expansionSlides(slides = []) {
  const expanded = [];
  for (const slide of slides) {
    for (const bullet of slide.bullets || []) {
      const text = clean(bullet?.text || bullet, 130);
      if (!text) continue;
      expanded.push({
        layout: 'bullets',
        title: clean(bullet?.label || `${slide.title}: detalle`, 64),
        kicker: clean(slide.title, 40),
        summary: text,
        bullets: [],
        takeaway: text,
        notes: clean(`Profundizar esta idea dentro de ${slide.title}.`, 220),
      });
    }
    for (const column of slide.columns || []) {
      const items = (column?.items || []).map((item) => clean(item, 100)).filter(Boolean);
      if (!items.length) continue;
      expanded.push({
        layout: 'bullets',
        title: clean(column.heading || `${slide.title}: análisis`, 64),
        kicker: clean(slide.title, 40),
        summary: clean(slide.summary || slide.takeaway || '', 180),
        bullets: items.slice(0, 4).map((item) => ({ label: '', text: item })),
        takeaway: items[0],
        notes: clean(`Desarrollar ${column.heading || slide.title} con ejemplos y consecuencias.`, 220),
      });
    }
  }
  return uniqueSlides(expanded);
}

function chooseEvenly(slides, target) {
  if (target <= 0) return [];
  if (target === 1) return [slides[0]];
  if (slides.length <= target) return slides.slice();
  const chosen = [];
  const used = new Set();
  for (let index = 0; index < target; index += 1) {
    const sourceIndex = Math.round((index * (slides.length - 1)) / (target - 1));
    if (used.has(sourceIndex)) continue;
    used.add(sourceIndex);
    chosen.push(slides[sourceIndex]);
  }
  for (let index = 0; chosen.length < target && index < slides.length; index += 1) {
    if (!used.has(index)) chosen.splice(Math.max(1, chosen.length - 1), 0, slides[index]);
  }
  return chosen.slice(0, target);
}

function ensureClosingSlide(slides, sourceSlides) {
  if (!slides.length || CLOSING_RE.test(slides.at(-1)?.title || '')) return slides;
  const closing = [...slides, ...sourceSlides].reverse().find((slide) => CLOSING_RE.test(slide.title || ''));
  if (!closing) return slides;
  const closingKey = normalize(closing.title || slideText(closing));
  const withoutClosing = slides.filter((slide) => normalize(slide.title || slideText(slide)) !== closingKey);
  return [...withoutClosing.slice(0, Math.max(0, slides.length - 1)), closing];
}

function ensureLayoutVariety(slides, sourceSlides) {
  if (slides.length < 4 || new Set(slides.map((slide) => slide.layout || 'bullets')).size >= 2) return slides;
  const currentLayout = slides[0]?.layout || 'bullets';
  const alternative = sourceSlides.find((slide) => (slide.layout || 'bullets') !== currentLayout);
  const replaceIndex = Math.min(Math.max(1, Math.floor(slides.length / 2)), slides.length - 2);
  const next = slides.slice();
  if (alternative) {
    next[replaceIndex] = alternative;
  } else {
    const source = next[replaceIndex];
    const items = (source.bullets || []).map((bullet) => clean(bullet?.text || bullet, 90)).filter(Boolean);
    const midpoint = Math.max(1, Math.ceil(items.length / 2));
    const leftItems = items.slice(0, midpoint);
    const rightItems = items.slice(midpoint);
    if (!rightItems.length && source.summary) rightItems.push(clean(source.summary, 90));
    if (!leftItems.length && source.takeaway) leftItems.push(clean(source.takeaway, 90));
    if (!leftItems.length || !rightItems.length) return slides;
    next[replaceIndex] = {
      ...source,
      layout: 'two_column',
      columns: [
        { heading: clean(source.bullets?.[0]?.label || 'Evidencia', 36), items: leftItems },
        { heading: clean(source.bullets?.[midpoint]?.label || 'Implicancia', 36), items: rightItems },
      ],
    };
  }
  return uniqueSlides(next).length === next.length ? next : slides;
}

function ensureRequiredItems(slides, sourceSlides, requiredItems = []) {
  const requirements = (Array.isArray(requiredItems) ? requiredItems : []).filter(Boolean);
  if (!requirements.length || !slides.length) return slides;
  const next = slides.slice();
  const selectedKeys = new Set(next.map((slide) => normalize(slide.title || slideText(slide))));

  for (const requirement of requirements) {
    if (next.some((slide) => requirementIsPresent(requirement, visibleSlideText(slide)))) continue;
    const candidate = sourceSlides.find((slide) => {
      const key = normalize(slide.title || slideText(slide));
      return !selectedKeys.has(key) && requirementIsPresent(requirement, visibleSlideText(slide));
    });
    if (!candidate) continue;

    const protectedIndexes = new Set();
    for (const otherRequirement of requirements) {
      const matches = next
        .map((slide, index) => requirementIsPresent(otherRequirement, visibleSlideText(slide)) ? index : -1)
        .filter((index) => index >= 0);
      if (matches.length === 1) protectedIndexes.add(matches[0]);
    }
    let replaceIndex = -1;
    for (let index = next.length - 1; index >= 0; index -= 1) {
      if (protectedIndexes.has(index) || CLOSING_RE.test(next[index]?.title || '')) continue;
      replaceIndex = index;
      break;
    }
    if (replaceIndex < 0) continue;
    selectedKeys.delete(normalize(next[replaceIndex].title || slideText(next[replaceIndex])));
    next[replaceIndex] = candidate;
    selectedKeys.add(normalize(candidate.title || slideText(candidate)));
  }
  return next;
}

function reconcilePptxPlan(plan = {}, { slideTarget, fallbackSlides = [], requiredItems = [] } = {}) {
  const manifest = buildPptxDeckManifest({
    slideTarget,
    references: plan.references,
  });
  const primary = uniqueSlides(plan.slides);
  const candidates = uniqueSlides([...primary, ...fallbackSlides]);
  let slides;
  if (manifest.contentSlides === 1) {
    slides = [overviewSlide(plan, candidates)];
  } else {
    // Once a planner already produced the exact content budget, rebuilding
    // the PPTX or HTML preview must preserve that same ordered set. Mixing
    // fallback slides back into an already-reconciled plan made repeated
    // calls select different content and allowed the preview to diverge from
    // the downloadable file.
    const preferredPool = primary.length >= manifest.contentSlides ? primary : candidates;
    const candidatePool = preferredPool.length >= manifest.contentSlides
      ? preferredPool
      : uniqueSlides([...preferredPool, ...expansionSlides(candidates)]);
    slides = chooseEvenly(candidatePool, manifest.contentSlides);
    slides = ensureLayoutVariety(slides, candidatePool);
    slides = ensureClosingSlide(slides, candidates);
    slides = ensureRequiredItems(slides, candidates, requiredItems);
  }
  if (slides.length < manifest.contentSlides) {
    for (let index = slides.length; index < manifest.contentSlides; index += 1) {
      slides.push({
        layout: 'bullets',
        title: `Decisión ${index + 1}`,
        kicker: 'Profundización',
        summary: clean(plan.thesis || `Profundización de ${plan.topic || 'la presentación'}.`, 180),
        bullets: [],
        takeaway: clean(plan.thesis || '', 120),
        notes: 'Conectar esta decisión con el objetivo, la evidencia disponible y el siguiente paso.',
      });
    }
  }
  slides = slides.slice(0, manifest.contentSlides);
  return {
    ...plan,
    agenda: slides.filter((slide) => slide.layout !== 'section').map((slide) => slide.title).filter(Boolean).slice(0, 10),
    slides,
    manifest,
  };
}

function buildEvidenceText({ prompt = '', referenceBriefs = [], sourceContent = '' } = {}) {
  return [
    prompt,
    sourceContent,
    ...(Array.isArray(referenceBriefs) ? referenceBriefs.map((ref) => `${ref?.name || ''} ${ref?.excerpt || ''}`) : []),
  ].filter(Boolean).join('\n');
}

function extractStrongNumericClaims(value = '') {
  return String(value || '').match(STRONG_NUMERIC_CLAIM_RE) || [];
}

function claimIsGrounded(claim, evidenceText) {
  const normalizedClaim = normalizeEvidence(claim);
  if (!normalizedClaim) return true;
  const normalizedEvidenceText = normalizeEvidence(evidenceText);
  if (normalizedEvidenceText.includes(normalizedClaim)) return true;
  const numericTokens = normalizedClaim.match(/\d+(?:[.,]\d+)?%?/g) || [];
  return numericTokens.length > 0 && numericTokens.every((token) => normalizedEvidenceText.includes(token));
}

function valueIsGrounded(value, evidenceText) {
  const compactValue = normalizeEvidence(value);
  if (!/\d/.test(compactValue)) return false;
  return normalizeEvidence(evidenceText).includes(compactValue);
}

function quoteIsGrounded(quote, evidenceText) {
  const normalizedQuote = normalize(quote);
  if (normalizedQuote.length < 20) return false;
  return normalize(evidenceText).includes(normalizedQuote);
}

const REQUIREMENT_STOPWORDS = new Set([
  'agrega', 'agregar', 'con', 'de', 'del', 'debe', 'deben', 'diapositiva', 'diapositivas',
  'evita', 'evitar', 'incluye', 'incluir', 'la', 'las', 'los', 'no', 'presentacion',
  'que', 'slide', 'slides', 'una', 'un', 'usar', 'use', 'y',
]);

function requirementTokens(value) {
  return normalize(value).split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !REQUIREMENT_STOPWORDS.has(token));
}

function requirementIsPresent(value, content) {
  const tokens = requirementTokens(value);
  if (!tokens.length) return true;
  const normalizedContent = normalize(content);
  return tokens.every((token) => normalizedContent.includes(token));
}

function auditPptxPlan(plan = {}, {
  prompt = '',
  referenceBriefs = [],
  sourceContent = '',
  requiredItems = [],
  forbiddenItems = [],
} = {}) {
  const evidenceText = buildEvidenceText({ prompt, referenceBriefs, sourceContent });
  const slides = Array.isArray(plan.slides) ? plan.slides : [];
  const titles = slides.map((slide) => normalize(slide.title)).filter(Boolean);
  const unsupportedNumericClaims = [];
  for (const slide of slides) {
    for (const claim of extractStrongNumericClaims(slideText(slide))) {
      if (!claimIsGrounded(claim, evidenceText)) {
        unsupportedNumericClaims.push({ title: slide.title || '', claim });
      }
    }
  }
  const layoutCount = new Set(slides.map((slide) => slide.layout || 'bullets')).size;
  const expectedContent = plan.manifest?.contentSlides || slides.length;
  const visibleContent = slides.map(visibleSlideText).join(' ');
  const missingRequiredItems = (Array.isArray(requiredItems) ? requiredItems : [])
    .filter((item) => !requirementIsPresent(item, visibleContent));
  const presentForbiddenItems = (Array.isArray(forbiddenItems) ? forbiddenItems : [])
    .filter((item) => requirementIsPresent(item, visibleContent));
  const scientificLabels = new Set((Array.isArray(referenceBriefs) ? referenceBriefs : []).map(sourceLabel).filter(Boolean));
  const missingSourceCitations = scientificLabels.size === 0 ? [] : slides
    .filter((slide) => (slide.layout || 'bullets') !== 'section')
    .filter((slide) => !(Array.isArray(slide.sourceCitations)
      && slide.sourceCitations.some((citation) => scientificLabels.has(String(citation || '').toUpperCase()))))
    .map((slide) => slide.title || 'Lámina sin título');
  const missingFigureProvenance = slides
    .filter((slide) => slide.chart || slide.stat)
    .filter((slide) => !clean(slide.chart?.source || slide.stat?.source))
    .map((slide) => slide.title || 'Lámina sin título');
  const checks = {
    exactContentCount: slides.length === expectedContent,
    uniqueTitles: new Set(titles).size === titles.length,
    noMetaText: !GENERIC_META_RE.test(slides.map(slideText).join(' ')),
    groundedNumbers: unsupportedNumericClaims.length === 0,
    layoutVariety: slides.length < 4 || layoutCount >= 2,
    notesPresent: slides.every((slide) => clean(slide.notes).length > 0),
    requiredItems: missingRequiredItems.length === 0,
    forbiddenItems: presentForbiddenItems.length === 0,
    sourceCitations: missingSourceCitations.length === 0,
    figureProvenance: missingFigureProvenance.length === 0,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    unsupportedNumericClaims,
    missingRequiredItems,
    presentForbiddenItems,
    missingSourceCitations,
    missingFigureProvenance,
    layoutCount,
    plannedTotalSlides: (plan.manifest?.shellSlides || 0) + slides.length,
  };
}

module.exports = {
  DEFAULT_TOTAL_SLIDES,
  MIN_TOTAL_SLIDES,
  MAX_TOTAL_SLIDES,
  GENERIC_META_RE,
  STRONG_NUMERIC_CLAIM_RE,
  buildPptxDeckManifest,
  attachSourceCitations,
  reconcilePptxPlan,
  buildEvidenceText,
  extractStrongNumericClaims,
  claimIsGrounded,
  valueIsGrounded,
  quoteIsGrounded,
  requirementIsPresent,
  auditPptxPlan,
  slideText,
  visibleSlideText,
  INTERNAL: {
    clampTotalSlides,
    uniqueSlides,
    overviewSlide,
    expansionSlides,
    chooseEvenly,
    ensureClosingSlide,
    ensureLayoutVariety,
    ensureRequiredItems,
    sourceLabel,
    citationTokens,
    normalizeEvidence,
  },
};
