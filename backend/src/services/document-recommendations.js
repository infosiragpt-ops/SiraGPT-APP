'use strict';

/**
 * document-recommendations.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures EXPLICIT recommendations the document makes — "we
 * recommend", "recomendamos", "we suggest", "the panel recommends",
 * "it is advisable to", "se recomienda", "se sugiere". Routes
 * questions like "what does the report recommend?" / "what action is
 * suggested?" to a citeable list rather than synthesising.
 *
 * Different from document-obligations-extractor (binding shall /
 * must language) and the deep-analyzer's action bucket (generic
 * deliverables): recommendations are SUGGESTED actions the author
 * proposes, not binding commitments.
 *
 * Public API:
 *   extractRecommendations(text)         → RecommendationReport
 *   buildRecommendationsForFiles(files)  → { perFile, aggregate }
 *   renderRecommendationsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4000;
const MIN_SENTENCE_LEN = 14;
const MAX_SENTENCE_LEN = 320;

const RECOMMEND_PATTERNS_EN = [
  /\b(we\s+(?:recommend|suggest|advise|propose|encourage|advocate)|it\s+is\s+(?:recommended|suggested|advisable)\s+to|the\s+(?:report|panel|committee|board|analysis)\s+(?:recommends?|suggests?|advises?)|our\s+(?:recommendation|suggestion)\s+is)\b/i,
];

const RECOMMEND_PATTERNS_ES = [
  /(?:^|[^\p{L}])(recomendamos|sugerimos|aconsejamos|proponemos|alentamos|se\s+recomienda|se\s+sugiere|se\s+aconseja|nuestra\s+recomendaci[oó]n\s+es|nuestro\s+consejo\s+es)(?=[^\p{L}]|$)/iu,
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max = MAX_SENTENCE_LEN) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?。！？])\s+(?=[A-ZÁÉÍÓÚÑ\d"'¿¡(])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_LEN);
}

function isRecommendation(sentence) {
  for (const re of RECOMMEND_PATTERNS_EN) if (re.test(sentence)) return true;
  for (const re of RECOMMEND_PATTERNS_ES) if (re.test(sentence)) return true;
  return false;
}

function extractRecommendations(input) {
  const text = safeText(input);
  if (!text) return { recommendations: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const recommendations = [];
  const seen = new Set();
  for (const s of sentences) {
    if (recommendations.length >= MAX_PER_FILE) break;
    if (!isRecommendation(s)) continue;
    const clipped = clip(s);
    const key = clipped.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    recommendations.push({ sentence: clipped });
  }
  return { recommendations, total: recommendations.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildRecommendationsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractRecommendations(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, recommendations: r.recommendations });
    aggregate = aggregate.concat(r.recommendations.map((x) => ({ ...x, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(item, opts = {}) {
  const file = opts.includeFile && item.file ? ` _(${item.file})_` : '';
  return `- [**RECOMMENDATION**]${file} ${item.sentence}`;
}

function renderRecommendationsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## RECOMMENDATIONS
Explicit recommendations / suggestions the attached document(s) propose. Different from obligations (binding) and generic actions (operational): these are SUGGESTED courses of action. Quote the source sentence verbatim before claiming the recommendation is firm.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const x of only.recommendations) sections.push(renderLine(x));
  } else {
    sections.push('### Aggregate recommendations across all files');
    for (const x of report.aggregate) sections.push(renderLine(x, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const x of p.recommendations) sections.push(renderLine(x));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...recommendations block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractRecommendations,
  buildRecommendationsForFiles,
  renderRecommendationsBlock,
  _internal: {
    splitSentences,
    isRecommendation,
    RECOMMEND_PATTERNS_EN,
    RECOMMEND_PATTERNS_ES,
  },
};
