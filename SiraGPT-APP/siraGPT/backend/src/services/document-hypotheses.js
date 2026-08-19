'use strict';

/**
 * document-hypotheses.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures explicit hypotheses, research questions and stated claims
 * documents make. Routes academic / scientific / experimental docs'
 * "what is the document testing?" questions to citeable hypothesis
 * statements instead of synthesising from prose.
 *
 * Coverage (deterministic, bilingual, < 12 ms on 1 MB):
 *
 *   - "Hypothesis: …" / "H1: …" / "Null hypothesis: …"
 *   - "We hypothesise that …", "It is hypothesised that …"
 *   - "Research question: …"
 *   - "Hipótesis: …" / "H1: …" / "Hipótesis nula: …"
 *   - "Pregunta de investigación: …"
 *   - "Planteamos que …", "Postulamos que …"
 *
 * Each match keeps its kind (hypothesis / null-hypothesis / research-
 * question) and the source sentence.
 *
 * Public API:
 *   extractHypotheses(text)               → HypothesisReport
 *   buildHypothesesForFiles(files)        → { perFile, aggregate }
 *   renderHypothesesBlock(report)         → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 3800;
const MIN_SENTENCE_LEN = 14;
const MAX_SENTENCE_LEN = 320;

const HYPOTHESIS_KIND = [
  { kind: 'null-hypothesis', patterns: [
    /\b(null\s+hypothesis|H0)\b/i,
    /(?:^|[^\p{L}])(hip[oó]tesis\s+nula|H0)(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'research-question', patterns: [
    /\b(research\s+question|RQ\s?\d?[:.])\b/i,
    /(?:^|[^\p{L}])(pregunta\s+de\s+investigaci[oó]n)(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'hypothesis', patterns: [
    /\b(hypothesis|hypothes(?:e|i)s|H\d|we\s+hypothesise|we\s+hypothesize|it\s+is\s+hypothesi[sz]ed|we\s+predict\s+that)\b/i,
    /(?:^|[^\p{L}])(hip[oó]tesis|planteamos\s+que|postulamos\s+que|predecimos\s+que|sostenemos\s+que)(?=[^\p{L}]|$)/iu,
  ] },
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

function detectKind(sentence) {
  for (const k of HYPOTHESIS_KIND) {
    for (const re of k.patterns) {
      if (re.test(sentence)) return k.kind;
    }
  }
  return null;
}

function extractHypotheses(input) {
  const text = safeText(input);
  if (!text) return { items: [], totals: {}, total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const items = [];
  const totals = {};
  const seen = new Set();
  for (const s of sentences) {
    if (items.length >= MAX_PER_FILE) break;
    const kind = detectKind(s);
    if (!kind) continue;
    const clipped = clip(s);
    const key = `${kind}|${clipped.toLowerCase().slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind, sentence: clipped });
    totals[kind] = (totals[kind] || 0) + 1;
  }
  return { items, totals, total: items.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildHypothesesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractHypotheses(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.items.map((i) => ({ ...i, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(item, opts = {}) {
  const tag = item.kind.replace(/-/g, ' ').toUpperCase();
  const file = opts.includeFile && item.file ? ` _(${item.file})_` : '';
  return `- [**${tag}**]${file} ${item.sentence}`;
}

function renderHypothesesBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## RESEARCH HYPOTHESES & QUESTIONS
Hypotheses (positive / null) and research questions surfaced from the attached document(s). Use this block when the user asks "what is the document testing?" / "what is the main hypothesis?" — quote the source sentence verbatim.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const i of only.report.items) sections.push(renderLine(i));
  } else {
    sections.push('### Aggregate hypotheses across all files');
    for (const i of batchReport.aggregate) sections.push(renderLine(i, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const i of p.report.items) sections.push(renderLine(i));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...hypotheses block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractHypotheses,
  buildHypothesesForFiles,
  renderHypothesesBlock,
  _internal: {
    splitSentences,
    detectKind,
    HYPOTHESIS_KIND,
  },
};
