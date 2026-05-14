'use strict';

/**
 * document-web-vitals.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Core Web Vitals references with values: LCP, FID, INP, CLS, TTFB,
 * FCP, FMP, TBT. Useful for "what's the LCP we're targeting?" / "show me every
 * mention of CLS in the perf review".
 *
 * Classifies values into good / needs-improvement / poor buckets per Google's
 * threshold table.
 *
 * Public API:
 *   extractWebVitals(text)             → { entries, totals, total }
 *   buildWebVitalsForFiles(files)      → { perFile, aggregate, totals }
 *   renderWebVitalsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const METRICS = {
  LCP: { full: 'Largest Contentful Paint', unit: 'ms', good: 2500, poor: 4000 },
  FID: { full: 'First Input Delay', unit: 'ms', good: 100, poor: 300 },
  INP: { full: 'Interaction to Next Paint', unit: 'ms', good: 200, poor: 500 },
  CLS: { full: 'Cumulative Layout Shift', unit: '', good: 0.1, poor: 0.25 },
  TTFB: { full: 'Time to First Byte', unit: 'ms', good: 800, poor: 1800 },
  FCP: { full: 'First Contentful Paint', unit: 'ms', good: 1800, poor: 3000 },
  TBT: { full: 'Total Blocking Time', unit: 'ms', good: 200, poor: 600 },
};

const METRIC_VALUE_RE = /\b(LCP|FID|INP|CLS|TTFB|FCP|TBT)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(ms|s)?\b/g;
const METRIC_KEYWORD_RE = /\b(LCP|FID|INP|CLS|TTFB|FCP|TBT)\b/g;

function classify(metric, value, unit) {
  const m = METRICS[metric];
  if (!m) return 'unknown';
  let v = value;
  if (unit === 's' && m.unit === 'ms') v *= 1000;
  if (v <= m.good) return 'good';
  if (v <= m.poor) return 'needs-improvement';
  return 'poor';
}

function extractWebVitals(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { good: 0, 'needs-improvement': 0, poor: 0, mention: 0 };

  // Metric + value
  METRIC_VALUE_RE.lastIndex = 0;
  let m;
  while ((m = METRIC_VALUE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const metric = m[1];
    const value = parseFloat(m[2]);
    const unit = m[3] || (metric === 'CLS' ? '' : 'ms');
    const bucket = classify(metric, value, unit);
    const key = `${metric}:${value}:${unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ metric, value, unit, bucket, source: 'with-value' });
    if (totals[bucket] != null) totals[bucket] += 1;
  }

  // Metric mentions (no value)
  if (entries.length < MAX_PER_FILE) {
    METRIC_KEYWORD_RE.lastIndex = 0;
    while ((m = METRIC_KEYWORD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const metric = m[1];
      const key = `${metric}:mention`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ metric, value: null, unit: null, bucket: null, source: 'mention' });
      totals.mention += 1;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildWebVitalsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { good: 0, 'needs-improvement': 0, poor: 0, mention: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractWebVitals(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.metric}:${e.value ?? 'mention'}:${e.unit ?? ''}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      const bucket = e.bucket || 'mention';
      if (totals[bucket] != null) totals[bucket] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderWebVitalsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## WEB VITALS'];
  const t = report.totals || {};
  const parts = [];
  if (t.good) parts.push(`good: ${t.good}`);
  if (t['needs-improvement']) parts.push(`needs-improvement: ${t['needs-improvement']}`);
  if (t.poor) parts.push(`poor: ${t.poor}`);
  if (t.mention) parts.push(`mentions: ${t.mention}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      if (e.value != null) {
        lines.push(`- ${e.metric}: ${e.value}${e.unit} (${e.bucket})`);
      } else {
        lines.push(`- ${e.metric} (mention)`);
      }
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractWebVitals,
  buildWebVitalsForFiles,
  renderWebVitalsBlock,
  _internal: { classify, METRICS },
};
