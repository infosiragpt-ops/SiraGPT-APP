'use strict';

/**
 * document-postal-codes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects postal/ZIP codes by country format:
 *
 *   - US ZIP: 12345 or 12345-6789 (must be labeled to reduce false positives)
 *   - UK postcode: SW1A 1AA
 *   - Canada: M5V 3A1
 *   - Mexico CP: 5 digits with label
 *   - Spain CP: 5 digits with label
 *   - Germany PLZ: 5 digits with label
 *   - Brazil CEP: 12345-678
 *   - Japan: 〒123-4567 or 123-4567
 *
 * Routes "what postal code?" / "ZIP code?" to a citeable list.
 *
 * Public API:
 *   extractPostalCodes(text)         → PostalReport
 *   buildPostalCodesForFiles(files)  → { perFile, aggregate, totals }
 *   renderPostalCodesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;

const PATTERNS = [
  // UK postcode: SW1A 1AA / EC1A 1BB
  { kind: 'uk', re: /\b([A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2})\b/g },
  // Canada postal: M5V 3A1 (alternating letter-digit)
  { kind: 'ca', re: /\b([A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/g },
  // Brazil CEP
  { kind: 'br', re: /\b(\d{5}-\d{3})\b/g },
  // Japan: 〒123-4567
  { kind: 'jp', re: /〒(\d{3}-\d{4})/g },
  // Labeled US ZIP / general postal
  { kind: 'labeled-zip', re: /\b(?:ZIP\s+code|ZIP|postal\s+code|c[óo]digo\s+postal|CP|PLZ|CEP|Zustellpostleitzahl)\s*[:=]?\s*(\d{4,6}(?:-\d{3,4})?)/giu },
  // US ZIP with +4
  { kind: 'us-zip4', re: /\b(\d{5}-\d{4})\b/g },
];

const KINDS = PATTERNS.map((p) => p.kind);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractPostalCodes(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) {
      if (entries.length >= MAX_PER_FILE) break;
      const code = m[1].toUpperCase().trim();
      const key = `${kind}|${code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, code });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildPostalCodesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractPostalCodes(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries, totals: r.totals });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    for (const k of KINDS) totals[k] += r.totals[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.kind}] \`${e.code}\`${file}`;
}

function renderPostalCodesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## POSTAL / ZIP CODES
Postal/ZIP codes by country: UK (SW1A 1AA), Canada (M5V 3A1), Brazil CEP (12345-678), Japan (〒123-4567), US ZIP+4 (12345-6789), and labeled forms (ZIP code: / código postal: / CP: / PLZ: / CEP:). Routes "what postal code?" / "ZIP code?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate postal codes across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...postal codes block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractPostalCodes,
  buildPostalCodesForFiles,
  renderPostalCodesBlock,
  _internal: {
    PATTERNS,
    KINDS,
  },
};
