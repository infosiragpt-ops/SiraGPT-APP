'use strict';

/**
 * document-sla-terms.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures SLA (Service Level Agreement) specific terms — uptime
 * commitments, response/resolution time targets, credit policies,
 * RPO / RTO. Different from document-obligations (binding shall /
 * must clauses): this surfaces the QUANTITATIVE service commitments
 * the chat needs when answering "what's the uptime SLA?" / "what's
 * the response time?".
 *
 * Bilingual. Deterministic. < 12 ms on 1 MB.
 *
 * Categories:
 *   - uptime         "99.9% uptime", "monthly availability of 99.95%"
 *   - response-time  "P1 response within 1 hour"
 *   - resolution     "resolution within 4 business hours"
 *   - credit-policy  "service credit of 10%"
 *   - RPO            "RPO of 1 hour"
 *   - RTO            "RTO of 4 hours"
 *
 * Public API:
 *   extractSLATerms(text)              → SLAReport
 *   buildSLATermsForFiles(files)       → { perFile, aggregate }
 *   renderSLATermsBlock(report)        → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4000;
const MIN_SENTENCE_LEN = 14;
const MAX_SENTENCE_LEN = 320;

const SLA_KINDS = [
  { kind: 'uptime', patterns: [
    /\b(\d{2,3}(?:\.\d{1,3})?\s?%\s*(?:uptime|availability|disponibilidad))\b/i,
    /\b((?:monthly|annual)\s+(?:uptime|availability)\s+of\s+\d{2,3}(?:\.\d{1,3})?\s?%)/i,
    /(?:^|[^\p{L}])(disponibilidad\s+mensual\s+del?\s+\d{2,3}(?:\.\d{1,3})?\s?%)(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'response-time', patterns: [
    /\b(P[0-4]\s+(?:response|incident)\s+(?:time\s+)?(?:of\s+)?\d+\s*(?:minute|hour|business\s+hour|day)|response\s+time\s+(?:of\s+)?\d+\s*(?:minute|hour|business\s+hour|day))/i,
    /(?:^|[^\p{L}])(tiempo\s+de\s+respuesta\s+(?:de\s+)?\d+\s*(?:minutos?|horas?|d[ií]as?))(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'resolution', patterns: [
    /\b(resolution\s+(?:within|in)\s+\d+\s*(?:hours?|business\s+hours?|days?))/i,
    /(?:^|[^\p{L}])(tiempo\s+de\s+resoluci[oó]n\s+(?:de\s+)?\d+\s*(?:horas?|d[ií]as?))(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'credit-policy', patterns: [
    /\b((?:service\s+)?credit\s+of\s+\d{1,3}\s?%|credit\s+rebate\s+of\s+\d+\s?%|service\s+credit\s+equal\s+to)/i,
    /(?:^|[^\p{L}])(cr[eé]dito\s+de\s+servicio\s+(?:del?\s+)?\d{1,3}\s?%|cr[eé]dito\s+por\s+incumplimiento)(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'rpo', patterns: [
    /\b(RPO\s+(?:of\s+)?\d+\s*(?:minute|hour|day))/i,
  ] },
  { kind: 'rto', patterns: [
    /\b(RTO\s+(?:of\s+)?\d+\s*(?:minute|hour|day))/i,
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
  for (const k of SLA_KINDS) {
    for (const re of k.patterns) {
      if (re.test(sentence)) return k.kind;
    }
  }
  return null;
}

function extractSLATerms(input) {
  const text = safeText(input);
  if (!text) return { terms: [], totals: {}, total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const terms = [];
  const totals = {};
  const seen = new Set();
  for (const s of sentences) {
    if (terms.length >= MAX_PER_FILE) break;
    const kind = detectKind(s);
    if (!kind) continue;
    const clipped = clip(s);
    const key = `${kind}|${clipped.toLowerCase().slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push({ kind, sentence: clipped });
    totals[kind] = (totals[kind] || 0) + 1;
  }
  return { terms, totals, total: terms.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildSLATermsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractSLATerms(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.terms.map((t) => ({ ...t, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(t, opts = {}) {
  const tag = t.kind.replace(/-/g, ' ').toUpperCase();
  const file = opts.includeFile && t.file ? ` _(${t.file})_` : '';
  return `- [**${tag}**]${file} ${t.sentence}`;
}

function renderSLATermsBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## SLA TERMS
Service-level commitments surfaced from the attached document(s) — uptime guarantees, response / resolution times, credit policies, RPO / RTO. Routes "what's the uptime SLA?" / "what's the response time?" to citeable trigger sentences with the quantitative commitment intact.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const t of only.report.terms) sections.push(renderLine(t));
  } else {
    sections.push('### Aggregate SLA terms across all files');
    for (const t of batchReport.aggregate) sections.push(renderLine(t, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const t of p.report.terms) sections.push(renderLine(t));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...SLA terms block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractSLATerms,
  buildSLATermsForFiles,
  renderSLATermsBlock,
  _internal: {
    splitSentences,
    detectKind,
    SLA_KINDS,
  },
};
