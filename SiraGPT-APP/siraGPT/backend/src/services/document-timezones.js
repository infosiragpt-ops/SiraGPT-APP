'use strict';

/**
 * document-timezones.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects time zone references in scheduling docs, runbooks, SLA contracts:
 *
 *   - UTC offsets: UTC+5, UTC-08:00, +03:00, GMT+1
 *   - Named TZs: EST, PST, CST, EDT, PDT, CET, CEST, JST, GMT, UTC,
 *     IST, AEST, BST, KST
 *   - IANA TZ: America/New_York, Europe/Madrid, Asia/Tokyo
 *
 * Different from document-timestamps (full ISO datetime with TZ).
 * Routes "what time zone?" / "what's the offset?" to a citeable list.
 *
 * Public API:
 *   extractTimezones(text)         → TimezoneReport
 *   buildTimezonesForFiles(files)  → { perFile, aggregate, totals }
 *   renderTimezonesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4500;
const MAX_VALUE_LEN = 60;

const NAMED_TZS = new Set([
  'UTC', 'GMT', 'EST', 'EDT', 'CST', 'CDT', 'MST', 'MDT', 'PST', 'PDT',
  'AKST', 'AKDT', 'HST', 'AST', 'NST', 'NDT', 'EET', 'EEST', 'CET', 'CEST',
  'WET', 'WEST', 'BST', 'IST', 'JST', 'KST', 'CST', 'HKT', 'SGT', 'AEDT',
  'AEST', 'ACDT', 'ACST', 'AWST', 'NZDT', 'NZST', 'BRT', 'BRST', 'ART',
  'CLT', 'CLST', 'COT', 'PET', 'VET', 'UYT', 'AST', 'EAT', 'CAT', 'WAT',
  'SAST', 'TRT', 'MSK',
]);

const IANA_REGIONS = new Set([
  'Africa', 'America', 'Antarctica', 'Arctic', 'Asia', 'Atlantic',
  'Australia', 'Etc', 'Europe', 'Indian', 'Pacific', 'US',
]);

const UTC_OFFSET_RE = /\b(UTC|GMT)\s*([+-]\d{1,2}(?::\d{2})?)/g;
const SIMPLE_OFFSET_RE = /(?:^|[\s(`,;])([+-]\d{2}:?\d{2})(?=[\s)`,;.!?]|$)/g;
const NAMED_TZ_RE = /\b([A-Z]{2,5})\b/g;
const IANA_TZ_RE = /\b((?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Etc|Europe|Indian|Pacific|US)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\b/g;

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

function emptyTotals() {
  return { offset: 0, named: 0, iana: 0 };
}

function isValidOffset(s) {
  const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(s);
  if (!m) return false;
  const h = Number(m[2]);
  const min = Number(m[3] || 0);
  return h >= 0 && h <= 14 && min >= 0 && min <= 59;
}

function extractTimezones(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, value) {
    if (entries.length >= MAX_PER_FILE) return;
    const v = clipValue(value);
    if (!v) return;
    const key = `${kind}|${v.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, value: v });
    totals[kind] += 1;
  }

  for (const m of head.matchAll(UTC_OFFSET_RE)) {
    if (isValidOffset(m[2])) {
      add('offset', `${m[1]}${m[2]}`);
    }
  }
  for (const m of head.matchAll(SIMPLE_OFFSET_RE)) {
    if (isValidOffset(m[1])) {
      add('offset', m[1]);
    }
  }
  for (const m of head.matchAll(NAMED_TZ_RE)) {
    if (NAMED_TZS.has(m[1])) add('named', m[1]);
  }
  for (const m of head.matchAll(IANA_TZ_RE)) {
    add('iana', m[1]);
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildTimezonesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractTimezones(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of Object.keys(totals)) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] \`${e.value}\`${file}`;
}

function renderTimezonesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## TIME ZONES
Time zone references detected in the document(s): UTC/GMT offsets (UTC+5, UTC-08:00, +03:00), named abbreviations (EST, PST, CET, JST, BST, IST …), and IANA identifiers (America/New_York, Europe/Madrid, Asia/Tokyo). Routes "what time zone?" / "what's the offset?" to a citeable list.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate time zones across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...time zones block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractTimezones,
  buildTimezonesForFiles,
  renderTimezonesBlock,
  _internal: {
    UTC_OFFSET_RE,
    SIMPLE_OFFSET_RE,
    NAMED_TZ_RE,
    IANA_TZ_RE,
    NAMED_TZS,
    IANA_REGIONS,
    isValidOffset,
  },
};
