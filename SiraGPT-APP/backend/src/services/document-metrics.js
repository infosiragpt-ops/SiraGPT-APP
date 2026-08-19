'use strict';

/**
 * document-metrics.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects observability metric names following Prometheus / OpenMetrics
 * naming conventions:
 *
 *   - Counter: *_total (e.g. http_requests_total)
 *   - Histogram/Summary: *_seconds, *_bucket, *_count, *_sum,
 *     *_duration_seconds
 *   - Gauge: noun_state, no suffix
 *   - Common suffixes: _bytes, _milliseconds, _ratio, _ms, _rate
 *
 * Routes "what metrics?" / "what's monitored?" to a citeable list.
 *
 * Public API:
 *   extractMetrics(text)         → MetricReport
 *   buildMetricsForFiles(files)  → { perFile, aggregate, totals }
 *   renderMetricsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;
const MAX_VALUE_LEN = 80;

const METRIC_SUFFIXES = [
  'total', 'seconds', 'bucket', 'count', 'sum', 'bytes', 'milliseconds',
  'ratio', 'ms', 'rate', 'duration_seconds', 'duration_ms',
  'gauge', 'errors', 'queue_size', 'in_flight',
];

const PATTERNS = [
  // Metric with known suffix
  { kind: 'metric', re: new RegExp(`\\b([a-z][a-z0-9]*(?:_[a-z][a-z0-9]*){0,8}_(${METRIC_SUFFIXES.join('|')}))\\b`, 'g') },
  // Labeled mention: "metric: name" or "counter: name"
  { kind: 'labeled', re: /\b(?:metric|counter|gauge|histogram|summary)\s*[:=]\s*([a-z][a-z0-9_]{4,60})/gi },
];

const KINDS = PATTERNS.map((p) => p.kind);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(s) {
  const t = String(s || '').trim();
  if (t.length <= MAX_VALUE_LEN) return t;
  return `${t.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function classifyMetric(name) {
  if (!name) return 'gauge';
  if (name.endsWith('_total') || name.endsWith('_count')) return 'counter';
  if (name.endsWith('_bucket') || name.endsWith('_sum') || name.endsWith('_seconds')) return 'histogram';
  if (name.endsWith('_bytes') || name.endsWith('_ratio') || name.endsWith('_rate')) return 'gauge';
  return 'gauge';
}

function emptyTotals() {
  return { counter: 0, gauge: 0, histogram: 0 };
}

function extractMetrics(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  for (const m of head.matchAll(PATTERNS[0].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const name = clipValue(m[1]);
    const type = classifyMetric(name);
    const key = `metric|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ name, type, source: 'pattern' });
    totals[type] = (totals[type] || 0) + 1;
  }

  for (const m of head.matchAll(PATTERNS[1].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const name = clipValue(m[1]);
    const type = classifyMetric(name);
    const key = `labeled|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ name, type, source: 'labeled' });
    totals[type] = (totals[type] || 0) + 1;
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildMetricsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractMetrics(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k] || 0;
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.type}] \`${e.name}\` _(${e.source})_${file}`;
}

function renderMetricsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## OBSERVABILITY METRICS
Prometheus / OpenMetrics-style metric names detected — snake_case with common suffixes (_total, _seconds, _bucket, _count, _sum, _bytes, _ratio, _rate, _duration_seconds, etc.) plus labeled forms (metric: / counter: / gauge: / histogram:). Classified into counter / gauge / histogram by suffix heuristic. Routes "what metrics?" / "what's monitored?" to a citeable list.

**By type:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate metrics across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...metrics block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractMetrics,
  buildMetricsForFiles,
  renderMetricsBlock,
  _internal: {
    PATTERNS,
    KINDS,
    METRIC_SUFFIXES,
    classifyMetric,
  },
};
