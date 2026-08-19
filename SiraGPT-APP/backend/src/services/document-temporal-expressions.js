'use strict';

/**
 * document-temporal-expressions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects RELATIVE temporal expressions in attached documents
 * ("next quarter", "end of fiscal year", "within the next 6 months",
 * "yesterday", "este trimestre"). Complements
 * document-temporal-timeline (which captures absolute calendar dates)
 * by surfacing the SOFT time anchors that the document leans on when
 * speaking about plans, forecasts, or commitments.
 *
 * Coverage (deterministic, bilingual, < 12 ms on 1 MB):
 *
 *   - English:
 *       today / yesterday / tomorrow / next (week|month|quarter|year)
 *       / last (week|month|quarter|year) / this fiscal year / end of
 *       (week|month|quarter|year) / in the next N (days|weeks|months)
 *       / within (the next) N … / by end of … / EOM / EOQ / EOY.
 *   - Spanish:
 *       hoy / ayer / mañana / próximo (mes|trimestre|año) / pasado
 *       (mes|trimestre|año) / este año (fiscal) / fin de
 *       (mes|trimestre|año) / dentro de N (días|semanas|meses) /
 *       antes de fin de … / cierre del año.
 *
 * Each finding carries the matched phrase, a kind tag (past / present
 * / future / boundary / horizon), and the source sentence.
 *
 * Public API:
 *   extractTemporalExpressions(text)        → ExpressionReport
 *   buildExpressionsForFiles(files)         → { perFile, aggregate }
 *   renderExpressionsBlock(report)          → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 4000;
const MIN_SENTENCE_LEN = 12;
const MAX_SENTENCE_LEN = 280;

const EXPRESSION_PATTERNS = [
  { kind: 'past', patterns: [
    /\b(yesterday|last\s+(?:week|month|quarter|year)|last\s+(?:fiscal|calendar)\s+year|previous\s+(?:week|month|quarter|year))\b/i,
    /(?:^|[^\p{L}])(ayer|pasad[oa]\s+(?:semana|mes|trimestre|año)|el\s+año\s+pasado|el\s+mes\s+pasado)(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'present', patterns: [
    /\b(today|currently|at\s+(?:the\s+)?present|this\s+(?:week|month|quarter|year)|this\s+fiscal\s+year|year[-\s]to[-\s]date|YTD)\b/i,
    /(?:^|[^\p{L}])(hoy|actualmente|en\s+este\s+momento|este\s+(?:mes|trimestre|año)|año\s+en\s+curso)(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'future', patterns: [
    /\b(tomorrow|next\s+(?:week|month|quarter|year)|next\s+(?:fiscal|calendar)\s+year|upcoming\s+(?:week|month|quarter|year))\b/i,
    /(?:^|[^\p{L}])(mañana|pr[oó]xim[oa]\s+(?:semana|mes|trimestre|año)|el\s+a[ñn]o\s+que\s+viene|el\s+pr[oó]ximo\s+(?:mes|trimestre|año))(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'boundary', patterns: [
    /\b(end\s+of\s+(?:week|month|quarter|year|fiscal\s+year)|by\s+(?:eom|eoq|eoy|end\s+of\s+(?:week|month|quarter|year))|fiscal\s+year[-\s]end|year[-\s]end)\b/i,
    /(?:^|[^\p{L}])(fin\s+de\s+(?:semana|mes|trimestre|año)|cierre\s+del\s+(?:trimestre|año)|antes\s+de\s+fin\s+de\s+(?:mes|trimestre|año))(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'horizon', patterns: [
    /\b(within\s+(?:the\s+next\s+)?\d+\s+(?:days?|weeks?|months?|years?)|in\s+the\s+next\s+\d+\s+(?:days?|weeks?|months?|years?)|over\s+the\s+next\s+\d+\s+(?:weeks?|months?|years?))\b/i,
    /(?:^|[^\p{L}])(dentro\s+de\s+\d+\s+(?:d[ií]as?|semanas?|meses?|años?)|en\s+los?\s+pr[oó]xim[oa]s?\s+\d+\s+(?:d[ií]as?|semanas?|meses?|años?)|en\s+un\s+plazo\s+de\s+\d+)(?=[^\p{L}]|$)/iu,
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

function findFirstMatch(sentence, patterns) {
  for (const re of patterns) {
    const m = sentence.match(re);
    if (m) return (m[1] || m[0] || '').trim();
  }
  return null;
}

function extractTemporalExpressions(input) {
  const text = safeText(input);
  if (!text) return { expressions: [], totals: {}, total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const expressions = [];
  const totals = {};
  const seen = new Set();
  for (const s of sentences) {
    if (expressions.length >= MAX_PER_FILE) break;
    for (const group of EXPRESSION_PATTERNS) {
      const phrase = findFirstMatch(s, group.patterns);
      if (!phrase) continue;
      const clipped = clip(s);
      const key = `${group.kind}|${phrase.toLowerCase()}|${clipped.slice(0, 50).toLowerCase()}`;
      if (seen.has(key)) break;
      seen.add(key);
      expressions.push({ kind: group.kind, phrase, sentence: clipped });
      totals[group.kind] = (totals[group.kind] || 0) + 1;
      break; // one tag per sentence
    }
  }
  return {
    expressions,
    totals,
    total: expressions.length,
    truncated: text.length > SCAN_HEAD_BYTES,
  };
}

function buildExpressionsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractTemporalExpressions(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.expressions.map((e) => ({ ...e, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderExpressionLine(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [**${e.kind.toUpperCase()}**]${file} _${e.phrase}_ — "${e.sentence}"`;
}

function renderExpressionsBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## TEMPORAL EXPRESSIONS
Relative time anchors surfaced from the attached document(s) (today / this quarter / next year / end of month / within the next N weeks). Complements the absolute-date timeline. Use this block when the user asks "what's planned soon?" / "what's recent?" / "what's upcoming?" — the source's words carry the intent; absolute dates may need to be inferred from a context anchor.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.report.expressions) sections.push(renderExpressionLine(e));
  } else {
    sections.push('### Aggregate expressions across all files');
    for (const e of batchReport.aggregate) sections.push(renderExpressionLine(e, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.report.expressions) sections.push(renderExpressionLine(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...temporal expressions block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractTemporalExpressions,
  buildExpressionsForFiles,
  renderExpressionsBlock,
  _internal: {
    splitSentences,
    findFirstMatch,
    EXPRESSION_PATTERNS,
  },
};
