'use strict';

/**
 * document-assumptions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures explicit ASSUMPTIONS the document declares — "we assume",
 * "assuming X", "this analysis assumes", "se asume", "suponemos".
 * Routes "what assumptions did the author make?" / "what are the
 * caveats?" to citeable statements. Critical for auditability of
 * proposals, financial models, risk assessments, and research.
 *
 * Public API:
 *   extractAssumptions(text)             → AssumptionReport
 *   buildAssumptionsForFiles(files)      → { perFile, aggregate }
 *   renderAssumptionsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4000;
const MIN_SENTENCE_LEN = 10;
const MAX_SENTENCE_LEN = 320;

const ASSUME_PATTERNS_EN = [
  /\b(we\s+assume|it\s+is\s+assumed|this\s+(?:analysis|model|plan|report)\s+assumes?|assuming\s+(?:that|a|an)|under\s+the\s+assumption\s+that|on\s+the\s+assumption\s+that)\b/i,
  /\b(?:key\s+)?assumptions?\s*[:.-]/i,
];

const ASSUME_PATTERNS_ES = [
  /(?:^|[^\p{L}])(asumimos|suponemos|se\s+asume|se\s+supone|partimos\s+de\s+la\s+premisa|bajo\s+el\s+supuesto\s+de\s+que|asunci[oó]n(?:es)?\s*[:.-]|supuesto(?:s)?\s*[:.-]|premisa(?:s)?\s*[:.-])(?=[^\p{L}]|$)/iu,
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

function isAssumption(sentence) {
  for (const re of ASSUME_PATTERNS_EN) if (re.test(sentence)) return true;
  for (const re of ASSUME_PATTERNS_ES) if (re.test(sentence)) return true;
  return false;
}

function extractAssumptions(input) {
  const text = safeText(input);
  if (!text) return { assumptions: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const assumptions = [];
  const seen = new Set();
  for (const s of sentences) {
    if (assumptions.length >= MAX_PER_FILE) break;
    if (!isAssumption(s)) continue;
    const clipped = clip(s);
    const key = clipped.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    assumptions.push({ sentence: clipped });
  }
  return { assumptions, total: assumptions.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildAssumptionsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractAssumptions(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, assumptions: r.assumptions });
    aggregate = aggregate.concat(r.assumptions.map((x) => ({ ...x, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(item, opts = {}) {
  const file = opts.includeFile && item.file ? ` _(${item.file})_` : '';
  return `- [**ASSUMPTION**]${file} ${item.sentence}`;
}

function renderAssumptionsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## ASSUMPTIONS & PREMISES
Explicit assumptions / premises stated by the attached document(s). Critical for auditing proposals, financial models, risk assessments and research. Quote the source sentence verbatim before claiming an assumption is binding — they describe the author's mental model, not validated facts.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const x of only.assumptions) sections.push(renderLine(x));
  } else {
    sections.push('### Aggregate assumptions across all files');
    for (const x of report.aggregate) sections.push(renderLine(x, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const x of p.assumptions) sections.push(renderLine(x));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...assumptions block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractAssumptions,
  buildAssumptionsForFiles,
  renderAssumptionsBlock,
  _internal: {
    splitSentences,
    isAssumption,
    ASSUME_PATTERNS_EN,
    ASSUME_PATTERNS_ES,
  },
};
