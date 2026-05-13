'use strict';

/**
 * document-scenarios.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects SCENARIO-PLANNING language — "best case", "worst case",
 * "base case", "downside", "upside", "stress scenario", "mejor caso",
 * "peor caso", "caso base". Routes "what scenarios does the document
 * model?" / "what's the worst case?" to citeable sentences.
 *
 * Public API:
 *   extractScenarios(text)              → ScenarioReport
 *   buildScenariosForFiles(files)       → { perFile, aggregate }
 *   renderScenariosBlock(report)        → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4000;
const MIN_SENTENCE_LEN = 14;
const MAX_SENTENCE_LEN = 320;

const SCENARIO_KIND = [
  { kind: 'best-case',  patterns: [
    /\b(best\s+case|upside\s+scenario|bull\s+case|optimistic\s+scenario)\b/i,
    /(?:^|[^\p{L}])(mejor\s+caso|escenario\s+(?:optimista|alcista|favorable))(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'worst-case', patterns: [
    /\b(worst\s+case|downside\s+scenario|bear\s+case|pessimistic\s+scenario|stress\s+(?:case|scenario|test))\b/i,
    /(?:^|[^\p{L}])(peor\s+caso|escenario\s+(?:pesimista|bajista|adverso|de\s+estr[eé]s)|prueba\s+de\s+estr[eé]s)(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'base-case', patterns: [
    /\b(base\s+case|baseline\s+(?:scenario|case)|central\s+scenario|most\s+likely\s+(?:case|scenario))\b/i,
    /(?:^|[^\p{L}])(caso\s+base|escenario\s+(?:base|central|m[áa]s\s+probable))(?=[^\p{L}]|$)/iu,
  ] },
  { kind: 'sensitivity', patterns: [
    /\b(sensitivity\s+analysis|sensitivity\s+scenario|what[-\s]if\s+scenario|monte\s+carlo)\b/i,
    /(?:^|[^\p{L}])(an[áa]lisis\s+de\s+sensibilidad|escenario\s+(?:de\s+sensibilidad|hipot[ée]tico)|qu[eé]\s+pasa\s+si)(?=[^\p{L}]|$)/iu,
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
  for (const k of SCENARIO_KIND) {
    for (const re of k.patterns) {
      if (re.test(sentence)) return k.kind;
    }
  }
  return null;
}

function extractScenarios(input) {
  const text = safeText(input);
  if (!text) return { scenarios: [], totals: {}, total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const scenarios = [];
  const totals = {};
  const seen = new Set();
  for (const s of sentences) {
    if (scenarios.length >= MAX_PER_FILE) break;
    const kind = detectKind(s);
    if (!kind) continue;
    const clipped = clip(s);
    const key = `${kind}|${clipped.toLowerCase().slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scenarios.push({ kind, sentence: clipped });
    totals[kind] = (totals[kind] || 0) + 1;
  }
  return { scenarios, totals, total: scenarios.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildScenariosForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractScenarios(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.scenarios.map((s) => ({ ...s, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(item, opts = {}) {
  const tag = item.kind.replace(/-/g, ' ').toUpperCase();
  const file = opts.includeFile && item.file ? ` _(${item.file})_` : '';
  return `- [**${tag}**]${file} ${item.sentence}`;
}

function renderScenariosBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## SCENARIO ANALYSIS
Scenario-planning language surfaced from the attached document(s) — best / worst / base case, sensitivity / stress / what-if scenarios. Use this block to answer "what scenarios does the document model?" / "what's the worst case?" with citeable trigger sentences.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const x of only.report.scenarios) sections.push(renderLine(x));
  } else {
    sections.push('### Aggregate scenarios across all files');
    for (const x of batchReport.aggregate) sections.push(renderLine(x, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const x of p.report.scenarios) sections.push(renderLine(x));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...scenarios block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractScenarios,
  buildScenariosForFiles,
  renderScenariosBlock,
  _internal: {
    splitSentences,
    detectKind,
    SCENARIO_KIND,
  },
};
