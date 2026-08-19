'use strict';

/**
 * document-benchmarks.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects BENCHMARK / COMPARISON references — "vs competitor", "vs
 * baseline", "industry average", "compared with", "comparado con",
 * "frente al promedio". Routes "how does X compare to Y?" / "what's
 * the reference benchmark?" to citeable trigger sentences.
 *
 * Bilingual. Deterministic. < 12 ms on 1 MB.
 *
 * Public API:
 *   extractBenchmarks(text)              → BenchmarkReport
 *   buildBenchmarksForFiles(files)       → { perFile, aggregate }
 *   renderBenchmarksBlock(report)        → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4000;
const MIN_SENTENCE_LEN = 14;
const MAX_SENTENCE_LEN = 320;

const BENCHMARK_PATTERNS = [
  /\b(vs\.?|versus|compared\s+to|compared\s+with|in\s+comparison\s+to|relative\s+to|against|industry\s+(?:average|benchmark|standard)|baseline|peer\s+group|market\s+average)\b/i,
  /(?:^|[^\p{L}])(frente\s+al?|comparado\s+con|en\s+comparaci[oó]n\s+con|respecto\s+al?|promedio\s+(?:de\s+la\s+)?industria|referencia\s+del\s+sector|grupo\s+de\s+pares|l[íi]nea\s+base)(?=[^\p{L}]|$)/iu,
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

function isBenchmark(sentence) {
  for (const re of BENCHMARK_PATTERNS) if (re.test(sentence)) return true;
  return false;
}

function extractBenchmarks(input) {
  const text = safeText(input);
  if (!text) return { benchmarks: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const benchmarks = [];
  const seen = new Set();
  for (const s of sentences) {
    if (benchmarks.length >= MAX_PER_FILE) break;
    if (!isBenchmark(s)) continue;
    const clipped = clip(s);
    const key = clipped.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    benchmarks.push({ sentence: clipped });
  }
  return { benchmarks, total: benchmarks.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildBenchmarksForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractBenchmarks(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, benchmarks: r.benchmarks });
    aggregate = aggregate.concat(r.benchmarks.map((x) => ({ ...x, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(item, opts = {}) {
  const file = opts.includeFile && item.file ? ` _(${item.file})_` : '';
  return `- [**BENCHMARK**]${file} ${item.sentence}`;
}

function renderBenchmarksBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## BENCHMARK REFERENCES
Comparison and benchmark references surfaced from the attached document(s) — "vs competitor", "industry average", "comparado con", "frente al promedio". Routes "how does X compare to Y?" / "what's the reference?" to citeable trigger sentences.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const x of only.benchmarks) sections.push(renderLine(x));
  } else {
    sections.push('### Aggregate benchmark references across all files');
    for (const x of report.aggregate) sections.push(renderLine(x, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const x of p.benchmarks) sections.push(renderLine(x));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...benchmarks block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractBenchmarks,
  buildBenchmarksForFiles,
  renderBenchmarksBlock,
  _internal: {
    splitSentences,
    isBenchmark,
    BENCHMARK_PATTERNS,
  },
};
