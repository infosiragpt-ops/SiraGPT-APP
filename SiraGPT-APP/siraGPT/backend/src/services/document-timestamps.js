'use strict';

/**
 * document-timestamps.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects machine-format timestamps and durations within text:
 *
 *   - ISO 8601 timestamps with timezone (2024-03-15T08:30:00Z,
 *     2024-03-15T08:30:00.123-05:00, 2024-03-15T08:30:00+0000)
 *   - ISO 8601 dates without time (2024-03-15)
 *   - Epoch seconds / milliseconds when prefixed (epoch: 1709654400,
 *     timestamp: 1709654400000)
 *   - HTTP date format (Mon, 15 Mar 2024 08:30:00 GMT)
 *   - ISO 8601 duration (PT1H30M, P1Y2M, PT45S)
 *   - Human-readable durations (5 minutes, 2 days, 3 hours, 30s)
 *
 * Different from document-temporal-timeline (sentence-level dates
 * grouped chronologically) and document-temporal-expressions
 * (verbose absolute/relative dates "next quarter", "Q3 2024"):
 * THIS module focuses on _machine_ timestamps + durations useful
 * for logs, runbooks, SLA documents, contracts with countdowns.
 *
 * Public API:
 *   extractTimestamps(text)         → TimestampReport
 *   buildTimestampsForFiles(files)  → { perFile, aggregate, totals }
 *   renderTimestampsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_KIND = 8;
const MAX_PER_FILE_TOTAL = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5500;
const MAX_CONTEXT_LEN = 180;

// ISO 8601 datetime with TZ (Z or ±HH:MM or ±HHMM)
const ISO_DATETIME_RE = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))\b/g;
// Plain ISO date (no time)
const ISO_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b(?!T)/g;
// Epoch (s / ms), only when explicitly prefixed to avoid false positives
const EPOCH_RE = /(?:epoch|timestamp|ts|unix)\s*[:=]\s*(\d{10,13})\b/gi;
// HTTP date
const HTTP_DATE_RE = /\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+(?:GMT|UTC))\b/g;
// ISO 8601 duration
const ISO_DURATION_RE = /\b(P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?)\b/g;
// Human duration (e.g. "5 minutes", "2 days", "30s", "1.5h")
const HUMAN_DURATION_RE = /\b(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mos?|years?|yrs?|y)\b/gi;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function contextFor(text, idx, len) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + len + 80);
  const ctx = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (ctx.length <= MAX_CONTEXT_LEN) return ctx;
  return `${ctx.slice(0, MAX_CONTEXT_LEN - 1)}…`;
}

function isValidIsoDuration(s) {
  // P alone or P + only T is invalid; must contain at least one unit.
  if (s === 'P' || s === 'PT') return false;
  return /\d/.test(s);
}

function isPlausibleEpoch(s) {
  // 10 digits = seconds, 13 digits = ms. Reject extremes.
  const n = Number(s);
  if (!Number.isFinite(n)) return false;
  if (s.length === 10) return n > 946684800 && n < 4102444800;   // 2000-01-01 .. 2100-01-01
  if (s.length === 13) return n > 946684800000 && n < 4102444800000;
  return false;
}

function extractTimestamps(input) {
  const text = safeText(input);
  if (!text) return { items: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const items = [];
  const seen = new Set();
  const perKind = emptyTotals();

  function add(kind, value, index, len) {
    if (perKind[kind] >= MAX_PER_KIND) return;
    if (items.length >= MAX_PER_FILE_TOTAL) return;
    const ctx = contextFor(head, index, len);
    const key = `${kind}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ kind, value, context: ctx });
    perKind[kind] += 1;
  }

  for (const m of head.matchAll(ISO_DATETIME_RE)) add('iso-datetime', m[1], m.index, m[1].length);
  for (const m of head.matchAll(ISO_DATE_RE)) add('iso-date', m[1], m.index, m[1].length);
  for (const m of head.matchAll(EPOCH_RE)) {
    if (isPlausibleEpoch(m[1])) add('epoch', m[1], m.index, m[0].length);
  }
  for (const m of head.matchAll(HTTP_DATE_RE)) add('http-date', m[1], m.index, m[1].length);
  for (const m of head.matchAll(ISO_DURATION_RE)) {
    if (isValidIsoDuration(m[1])) add('iso-duration', m[1], m.index, m[1].length);
  }
  for (const m of head.matchAll(HUMAN_DURATION_RE)) add('human-duration', `${m[1]} ${m[2]}`, m.index, m[0].length);

  return { items, total: items.length, totals: perKind, truncated: text.length > SCAN_HEAD_BYTES };
}

function emptyTotals() {
  return { 'iso-datetime': 0, 'iso-date': 0, 'epoch': 0, 'http-date': 0, 'iso-duration': 0, 'human-duration': 0 };
}

function buildTimestampsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractTimestamps(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, items: r.items, totals: r.totals });
    aggregate = aggregate.concat(r.items.map((it) => ({ ...it, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderItem(it, opts = {}) {
  const file = opts.includeFile && it.file ? ` _(${it.file})_` : '';
  return `- [${it.kind}] \`${it.value}\`${file} — ${it.context}`;
}

function renderTimestampsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const totalsLine = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## TIMESTAMPS & DURATIONS
Machine-format timestamps (ISO 8601 datetimes with timezone, plain ISO dates, epoch s/ms, HTTP date format) and durations (ISO 8601 PT…, human "5 minutes" / "2 days"). Surfaces verbatim source spans so the chat can answer "when did X happen?", "how long is the SLA?", "what's the retention?".

**Totals:** ${totalsLine || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const it of only.items) sections.push(renderItem(it));
  } else {
    sections.push('### Aggregate timestamps across all files');
    for (const it of report.aggregate) sections.push(renderItem(it, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const it of p.items) sections.push(renderItem(it));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...timestamps block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractTimestamps,
  buildTimestampsForFiles,
  renderTimestampsBlock,
  _internal: {
    ISO_DATETIME_RE,
    ISO_DATE_RE,
    EPOCH_RE,
    HTTP_DATE_RE,
    ISO_DURATION_RE,
    HUMAN_DURATION_RE,
    isValidIsoDuration,
    isPlausibleEpoch,
  },
};
