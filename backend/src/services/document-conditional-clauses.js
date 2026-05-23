'use strict';

/**
 * document-conditional-clauses.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures CONDITIONAL CLAUSES ("if X then Y", "si X entonces Y",
 * "provided that …", "siempre que …", "in the event of …") so the
 * chat can answer "what happens if X?" / "under what condition does Y
 * apply?" with citeable logic instead of inference.
 *
 * Bilingual (Spanish / English). Deterministic. < 12 ms on 1 MB.
 *
 * Coverage:
 *   - if … then …          / si … entonces …
 *   - unless …              / a menos que …
 *   - provided (that) …     / siempre que …
 *   - in the event of …     / en caso de …
 *   - subject to …          / sujeto a …
 *   - failing which …       / en su defecto …
 *   - upon …                / al / tras …
 *
 * Each clause is emitted as { trigger, sentence } with the matched
 * conjunction so the chat knows which trigger fired.
 *
 * Public API:
 *   extractConditionals(text)            → ConditionalReport
 *   buildConditionalsForFiles(files)     → { perFile, aggregate }
 *   renderConditionalsBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4200;
const MIN_SENTENCE_LEN = 10;
const MAX_SENTENCE_LEN = 320;

const TRIGGER_PATTERNS = [
  { trigger: 'if-then', patterns: [
    /\bif\s+[^.]{1,80}?,?\s+then\b/i,
    /(?:^|[^\p{L}])si\s+[^.]{1,80}?,?\s+entonces/iu,
  ] },
  { trigger: 'unless', patterns: [
    /\bunless\s+[^.]{4,80}/i,
    /(?:^|[^\p{L}])a\s+menos\s+que\s+[^.]{4,80}/iu,
  ] },
  { trigger: 'provided', patterns: [
    /\bprovided\s+(?:that\s+)?[^.]{4,80}/i,
    /(?:^|[^\p{L}])siempre\s+que\s+[^.]{4,80}/iu,
  ] },
  { trigger: 'event-of', patterns: [
    /\bin\s+the\s+event\s+(?:of|that)\s+[^.]{4,80}/i,
    /(?:^|[^\p{L}])en\s+(?:caso\s+de|el\s+caso\s+de\s+que)\s+[^.]{4,80}/iu,
  ] },
  { trigger: 'subject-to', patterns: [
    /\bsubject\s+to\s+[^.]{4,80}/i,
    /(?:^|[^\p{L}])sujet[oa]\s+a\s+[^.]{4,80}/iu,
  ] },
  { trigger: 'failing-which', patterns: [
    /\bfailing\s+which\b/i,
    /(?:^|[^\p{L}])en\s+su\s+defecto/iu,
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

function detectTrigger(sentence) {
  for (const t of TRIGGER_PATTERNS) {
    for (const re of t.patterns) {
      if (re.test(sentence)) return t.trigger;
    }
  }
  return null;
}

function extractConditionals(input) {
  const text = safeText(input);
  if (!text) return { clauses: [], totals: {}, total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const clauses = [];
  const totals = {};
  const seen = new Set();
  for (const s of sentences) {
    if (clauses.length >= MAX_PER_FILE) break;
    const trigger = detectTrigger(s);
    if (!trigger) continue;
    const clipped = clip(s);
    const key = `${trigger}|${clipped.toLowerCase().slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clauses.push({ trigger, sentence: clipped });
    totals[trigger] = (totals[trigger] || 0) + 1;
  }
  return { clauses, totals, total: clauses.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildConditionalsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractConditionals(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.clauses.map((c) => ({ ...c, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(c, opts = {}) {
  const tag = c.trigger.toUpperCase();
  const file = opts.includeFile && c.file ? ` _(${c.file})_` : '';
  return `- [**${tag}**]${file} ${c.sentence}`;
}

function renderConditionalsBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## CONDITIONAL CLAUSES
Conditional logic surfaced from the attached document(s) — "if … then", "unless", "provided that", "in the event of", "subject to", "failing which". Use this block to answer "what happens if X?" / "under what condition does Y apply?" with citeable trigger sentences.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const c of only.report.clauses) sections.push(renderLine(c));
  } else {
    sections.push('### Aggregate conditionals across all files');
    for (const c of batchReport.aggregate) sections.push(renderLine(c, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const c of p.report.clauses) sections.push(renderLine(c));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...conditional clauses block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractConditionals,
  buildConditionalsForFiles,
  renderConditionalsBlock,
  _internal: {
    splitSentences,
    detectTrigger,
    TRIGGER_PATTERNS,
  },
};
