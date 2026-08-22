'use strict';

/**
 * Intent compiler — user prompt → RequestSpec.
 *
 * Document text is never trusted here. Only the user's utterance drives
 * intent, coverage, and output-shape constraints.
 */

const { isDocumentEditRequest, isArtifactDeliverableRequest } = require('../agents/agentic-trigger');

const VERSION = 2;

const SINGLE_PARAGRAPH_RE =
  /\b(?:un\s+solo\s+p[aá]rrafo|un\s+p[aá]rrafo\s+solo|en\s+un\s+(?:solo\s+)?p[aá]rrafo|un\s+[uú]nico\s+p[aá]rrafo|one\s+(?:single\s+)?paragraph|a\s+single\s+paragraph|in\s+one\s+paragraph)\b/i;

const PARAGRAPH_COUNT_RE =
  /\b(?:en|in|de)\s+(\d{1,2})\s+p[aá]rrafos?\b|\b(\d{1,2})\s+p[aá]rrafos?\b|\b(\d{1,2})\s+paragraphs?\b/i;

const SUMMARY_RE =
  /\b(?:resumen|resume|resumir|resumelo|resumila|sintetiza(?:r)?|sintesis|summari(?:ze|se|y)|summarising|tl;?dr|de\s+qu[eé]\s+trata|qu[eé]\s+dice)\b/i;

const BULLET_RE =
  /\b(?:vi[nñ]etas?|bullets?|lista(?:r)?|puntos?\s+clave|key\s+points?)\b/i;

const HEADING_RE =
  /\b(?:con\s+t[ií]tulos?|con\s+encabezados?|con\s+secciones?|with\s+headings?|with\s+sections?)\b/i;

const SPANISH_RE =
  /\b(?:dame|hazme|resumen|p[aá]rrafo|documento|art[ií]culo|por\s+favor|expl[ií]ca|sintetiza)\b/i;

const ENGLISH_RE =
  /\b(?:please|summarize|summarise|paragraph|document|article|explain)\b/i;

function normalizePrompt(prompt) {
  return String(prompt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectLanguage(prompt) {
  const text = String(prompt || '');
  const es = SPANISH_RE.test(text);
  const en = ENGLISH_RE.test(text);
  if (es && !en) return 'es';
  if (en && !es) return 'en';
  if (es && en) return SPANISH_RE.test(text.slice(0, 80)) ? 'es' : 'en';
  return /[áéíóúñ¿¡]/i.test(text) ? 'es' : 'auto';
}

function parseParagraphCount(prompt) {
  if (SINGLE_PARAGRAPH_RE.test(prompt)) return 1;
  const m = String(prompt || '').match(PARAGRAPH_COUNT_RE);
  if (!m) return null;
  const n = Number(m[1] || m[2] || m[3]);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(8, Math.floor(n));
}

function detectIntent(prompt) {
  const text = String(prompt || '');
  if (isDocumentEditRequest(text)) return 'edit';
  if (isArtifactDeliverableRequest(text)) return 'deliverable';
  if (SUMMARY_RE.test(text) || SINGLE_PARAGRAPH_RE.test(text)) return 'summarize';
  if (/\b(?:analiza|an[aá]lisis|analyze|analysis)\b/i.test(text)) return 'analyze';
  if (/\b(?:extrae|extract|identifica|cu[aá]l\s+es|primera\s+palabra)\b/i.test(text)) return 'extract';
  return 'other';
}

function compileIntent(prompt, opts = {}) {
  const raw = String(prompt || '');
  const intent = detectIntent(raw);
  const paragraphs = parseParagraphCount(raw);
  const bulletsRequested = BULLET_RE.test(raw);
  const headingsRequested = HEADING_RE.test(raw);
  const language = detectLanguage(raw);
  const summarize = intent === 'summarize';
  const singleParagraph = paragraphs === 1 || (summarize && !bulletsRequested && paragraphs == null);

  /** @type {import('./types').RequestSpec} */
  const spec = {
    version: VERSION,
    intent,
    strategy: summarize ? 'summarize_full' : (intent === 'analyze' ? 'section_walk' : 'passthrough'),
    scope: {
      coverage: summarize || intent === 'analyze' ? 'full' : 'targeted',
      excludeEditorial: opts.excludeEditorial !== false,
    },
    output: {
      paragraphs: summarize && !bulletsRequested
        ? (paragraphs == null ? 1 : paragraphs)
        : paragraphs,
      headings: headingsRequested && !singleParagraph,
      bullets: bulletsRequested && !singleParagraph,
      language,
    },
    grounding: {
      source: 'document',
      untrustedDocument: true,
      allowInvention: false,
    },
    signals: {
      singleParagraph: Boolean(singleParagraph),
      rawPrompt: raw.slice(0, 500),
    },
  };

  if (spec.output.paragraphs === 1) {
    spec.output.headings = false;
    spec.output.bullets = false;
    spec.strategy = 'summarize_full';
    spec.scope.coverage = 'full';
  }

  return spec;
}

function hasDocumentText(files) {
  return (Array.isArray(files) ? files : []).some((file) => {
    if (!file || /image\//i.test(file.mimeType || file.type || '')) return false;
    const text = String(file.extractedText || file.content || '').trim();
    return text.length >= 40;
  });
}

/**
 * SDIE owns read-only document understanding (summary / analysis) when a
 * document is in scope. Mutation, OOXML transform, and "make me a Word"
 * deliverables stay on FEATURE_DOC_ENGINE / the agent runner.
 */
function shouldHandle({ prompt, files, spec, env } = {}) {
  const compiled = spec || compileIntent(prompt);
  if (!hasDocumentText(files)) return false;
  if (compiled.intent === 'edit' || compiled.intent === 'deliverable') return false;
  try {
    if (isDocumentEditRequest(prompt) || isArtifactDeliverableRequest(prompt)) return false;
  } catch (_) { /* detectors optional */ }
  if (compiled.strategy === 'summarize_full') return true;
  if (compiled.intent === 'analyze' && compiled.scope.coverage === 'full') return true;
  return false;
}

/**
 * summarize_full / full-document RequestSpecs must not use the live
 * message-attachments → documentIntelligence.retrieveEvidence top-k path
 * (limit 16–18, topK 3–8). That is the screenshot bug.
 */
function shouldSkipTopK(spec) {
  return spec?.strategy === 'summarize_full' || spec?.scope?.coverage === 'full';
}

function shouldSkipRetrieveEvidence(prompt, env = process.env) {
  try {
    const { isSdieV2Enabled } = require('./flags');
    if (!isSdieV2Enabled(env)) return false;
    return shouldSkipTopK(compileIntent(prompt));
  } catch (_) {
    return false;
  }
}

module.exports = {
  VERSION,
  compileIntent,
  shouldHandle,
  hasDocumentText,
  shouldSkipTopK,
  shouldSkipRetrieveEvidence,
  detectIntent,
  parseParagraphCount,
  detectLanguage,
  normalizePrompt,
  SINGLE_PARAGRAPH_RE,
  SUMMARY_RE,
};
