'use strict';

/**
 * document-license-plates.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects vehicle license plate formats commonly seen in legal / police /
 * fleet management docs:
 *
 *   - US: 3 letters + 3-4 digits, or vice versa (ABC 1234, 7XYZ123)
 *   - EU: 1-2 letters + digits + letters (B-RR 4321, AB 1234 CD)
 *   - Mexico: 3 letters + 3 digits + 1 letter (ABC-123-D)
 *   - UK: 2 letters + 2 digits + 3 letters (AB12 CDE)
 *   - Spain: 4 digits + 3 letters (1234 BCD)
 *   - Labeled forms: "placa: XYZ", "license plate: XYZ"
 *
 * Routes "what plate?" / "vehicle number?" to a citeable list.
 *
 * Public API:
 *   extractLicensePlates(text)         → PlateReport
 *   buildLicensePlatesForFiles(files)  → { perFile, aggregate, totals }
 *   renderLicensePlatesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4000;

const PATTERNS = [
  // Labeled forms — high confidence
  { kind: 'labeled', re: /\b(?:placa|license\s+plate|plate\s+number|matr[íi]cula|tag\s+number)\s*[:=#]?\s*([A-Z0-9][A-Z0-9\-\s]{4,10}[A-Z0-9])/giu },
  // UK: AB12 CDE
  { kind: 'uk', re: /\b([A-Z]{2}\d{2}\s?[A-Z]{3})\b/g },
  // Mexico: ABC-123-D
  { kind: 'mx', re: /\b([A-Z]{3}-\d{3}-[A-Z])\b/g },
  // Spain: 1234 BCD
  { kind: 'es', re: /\b(\d{4}\s?[A-Z]{3})\b/g },
  // US: ABC-1234 or ABC 1234
  { kind: 'us', re: /\b([A-Z]{3}[-\s]\d{3,4})\b/g },
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

function extractLicensePlates(input) {
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
      const plate = (m[1] || m[0]).trim().toUpperCase();
      const key = `${kind}|${plate}`;
      if (seen.has(key)) continue;
      // Also skip if plate already captured by higher-priority labeled
      if (kind !== 'labeled' && entries.some((e) => e.kind === 'labeled' && e.plate.replace(/\s|-/g, '') === plate.replace(/\s|-/g, ''))) continue;
      seen.add(key);
      entries.push({ kind, plate });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildLicensePlatesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractLicensePlates(safeText(f.extractedText));
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
  return `- [${e.kind}] \`${e.plate}\`${file}`;
}

function renderLicensePlatesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## VEHICLE LICENSE PLATES
License plate formats detected: US (ABC-1234), UK (AB12 CDE), Mexico (ABC-123-D), Spain (1234 BCD), plus labeled forms ("placa: XYZ", "license plate: XYZ", "matrícula: XYZ"). Routes "what plate?" / "vehicle number?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate plates across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...plates block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractLicensePlates,
  buildLicensePlatesForFiles,
  renderLicensePlatesBlock,
  _internal: {
    PATTERNS,
    KINDS,
  },
};
