'use strict';

/**
 * document-disclosures.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects REQUIRED-DISCLOSURE language commonly found in regulated /
 * public-facing documents — forward-looking statements, safe-harbour
 * notices, risk warnings, conflicts of interest, disclaimers
 * regarding past performance, etc. Routes "what disclosures does the
 * document carry?" / "what warnings does it state?" to citeable
 * passages rather than synthesising.
 *
 * Bilingual (English / Spanish). Deterministic. < 12 ms on 1 MB.
 *
 * Detected categories:
 *   - forward-looking      "forward-looking statement(s)", "this
 *                          presentation contains forward-looking …",
 *                          "declaraciones prospectivas".
 *   - safe-harbour         "safe harbor", "safe harbour", "puerto
 *                          seguro".
 *   - risk-warning         "investing involves risk", "no guarantee
 *                          of future results", "past performance is
 *                          not indicative", "rentabilidades pasadas
 *                          no garantizan".
 *   - conflict             "conflict of interest", "conflicto de
 *                          intereses".
 *   - regulatory           "not financial advice", "consult your
 *                          adviser", "no constituye asesoría",
 *                          "consulte a su asesor".
 *
 * Each entry → { kind, sentence }.
 *
 * Public API:
 *   extractDisclosures(text)             → DisclosureReport
 *   buildDisclosuresForFiles(files)      → { perFile, aggregate }
 *   renderDisclosuresBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4000;
const MIN_SENTENCE_LEN = 16;
const MAX_SENTENCE_LEN = 320;

const DISCLOSURE_KINDS = [
  { kind: 'forward-looking', patterns: [
    /\b(forward[-\s]?looking\s+statements?|this\s+(?:document|presentation|report)\s+contains\s+forward[-\s]?looking)\b/i,
    /(?:^|[^\p{L}])(declaraciones\s+prospectivas|este\s+(?:documento|informe)\s+contiene\s+declaraciones\s+prospectivas)(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'safe-harbour', patterns: [
    /\b(safe\s+harbou?r)\b/i,
    /(?:^|[^\p{L}])(puerto\s+seguro)(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'risk-warning', patterns: [
    /\b(investing\s+involves\s+risk|no\s+guarantee\s+of\s+future\s+results|past\s+performance\s+(?:is\s+not\s+)?indicative\s+of\s+future|may\s+result\s+in\s+loss\s+of\s+capital|principal\s+at\s+risk)\b/i,
    /(?:^|[^\p{L}])(invertir\s+implica\s+riesgo|rentabilidades\s+pasadas\s+no\s+garantizan|el\s+capital\s+est[áa]\s+en\s+riesgo|p[eé]rdida\s+de\s+capital)(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'conflict', patterns: [
    /\b(conflict\s+of\s+interest|potential\s+conflict)\b/i,
    /(?:^|[^\p{L}])(conflicto\s+de\s+intereses|potencial\s+conflicto)(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'regulatory', patterns: [
    /\b(not\s+financial\s+advice|not\s+investment\s+advice|consult\s+your\s+(?:adviser|advisor|broker)|seek\s+professional\s+(?:financial|legal)\s+advice)\b/i,
    /(?:^|[^\p{L}])(no\s+constituye\s+asesor[ií]a|no\s+es\s+(?:una\s+)?recomendaci[oó]n|consulte\s+a\s+su\s+asesor|busque\s+asesor[ií]a\s+(?:profesional|financiera|legal))(?=[^\p{L}]|$)/iu,
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
  for (const k of DISCLOSURE_KINDS) {
    for (const re of k.patterns) {
      if (re.test(sentence)) return k.kind;
    }
  }
  return null;
}

function extractDisclosures(input) {
  const text = safeText(input);
  if (!text) return { disclosures: [], totals: {}, total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const disclosures = [];
  const totals = {};
  const seen = new Set();
  for (const s of sentences) {
    if (disclosures.length >= MAX_PER_FILE) break;
    const kind = detectKind(s);
    if (!kind) continue;
    const clipped = clip(s);
    const key = `${kind}|${clipped.toLowerCase().slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    disclosures.push({ kind, sentence: clipped });
    totals[kind] = (totals[kind] || 0) + 1;
  }
  return { disclosures, totals, total: disclosures.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildDisclosuresForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractDisclosures(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.disclosures.map((d) => ({ ...d, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(d, opts = {}) {
  const tag = d.kind.replace(/-/g, ' ').toUpperCase();
  const file = opts.includeFile && d.file ? ` _(${d.file})_` : '';
  return `- [**${tag}**]${file} ${d.sentence}`;
}

function renderDisclosuresBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## REGULATORY DISCLOSURES & WARNINGS
Required-disclosure statements surfaced from the attached document(s) — forward-looking statements, safe-harbour notices, risk warnings, conflict-of-interest disclosures, and "not financial advice" caveats. Use this block when the user asks "what warnings does it state?" / "what disclosures are made?" — quote the source verbatim before claiming a disclosure is enforceable.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const d of only.report.disclosures) sections.push(renderLine(d));
  } else {
    sections.push('### Aggregate disclosures across all files');
    for (const d of batchReport.aggregate) sections.push(renderLine(d, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const d of p.report.disclosures) sections.push(renderLine(d));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...disclosures block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractDisclosures,
  buildDisclosuresForFiles,
  renderDisclosuresBlock,
  _internal: {
    splitSentences,
    detectKind,
    DISCLOSURE_KINDS,
  },
};
