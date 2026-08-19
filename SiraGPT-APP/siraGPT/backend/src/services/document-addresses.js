'use strict';

/**
 * document-addresses.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects street address lines in business / shipping / legal docs:
 *
 *   - US: "123 Main St", "456 Oak Avenue, Suite 200"
 *   - Spanish: "Calle Mayor 12", "Avenida Constitución 25, 3ºB"
 *   - PO Box: "PO Box 123" / "P.O. Box 123"
 *   - Labeled: "address: 123 Main St"
 *
 * Routes "what address?" / "where's the location?" to a citeable list.
 *
 * Public API:
 *   extractAddresses(text)         → AddressReport
 *   buildAddressesForFiles(files)  → { perFile, aggregate, totals }
 *   renderAddressesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 16;
const MAX_BLOCK_CHARS = 4500;
const MAX_VALUE_LEN = 180;

const STREET_SUFFIX_EN = ['St', 'Street', 'Ave', 'Avenue', 'Rd', 'Road', 'Blvd', 'Boulevard', 'Ln', 'Lane', 'Dr', 'Drive', 'Way', 'Pl', 'Place', 'Ct', 'Court', 'Sq', 'Square', 'Hwy', 'Highway', 'Pkwy', 'Parkway', 'Cir', 'Circle', 'Ter', 'Terrace'];
const STREET_PREFIX_ES = ['Calle', 'Avenida', 'Av\\.?', 'Av', 'Paseo', 'Plaza', 'Ronda', 'Camino', 'Carretera', 'Travesía', 'Carrer'];

const PATTERNS = [
  // US/EN: 123 Main St / Main Avenue / 456 Oak Rd
  { kind: 'us-en', re: new RegExp(`\\b(\\d{1,6}[A-Z]?\\s+[A-Z][a-zA-Z]+(?:\\s+[A-Z][a-zA-Z]+)?\\s+(?:${STREET_SUFFIX_EN.join('|')})(?:\\s*,\\s*(?:Suite|Ste|Apt|Unit|Floor|Fl)\\s+\\w+)?)\\b`, 'g') },
  // Spanish: Calle Mayor 12 / Avenida Constitución 25
  { kind: 'es', re: new RegExp(`\\b((?:${STREET_PREFIX_ES.join('|')})\\s+[A-ZÁÉÍÓÚÑ][\\wÀ-ÿ\\.\\s]{2,40}\\d{1,4}(?:\\s*,\\s*\\d{1,3}\\s*[ºªA-Z]?)?)\\b`, 'gu') },
  // PO Box
  { kind: 'po-box', re: /\b(P\.?\s?O\.?\s+Box\s+\d{1,8}|Apartado\s+(?:Postal\s+)?\d{1,8})\b/gi },
  // Labeled
  { kind: 'labeled', re: /\b(?:address|direcci[óo]n|domicilio)\s*[:=]\s*([^\n]{8,180})/gi },
];

const KINDS = PATTERNS.map((p) => p.kind);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_VALUE_LEN) return t;
  return `${t.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractAddresses(input) {
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
      const value = clipValue(m[1]);
      const key = `${kind}|${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ kind, value });
      totals[kind] += 1;
    }
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildAddressesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractAddresses(safeText(f.extractedText));
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
  return `- [${e.kind}] \`${e.value}\`${file}`;
}

function renderAddressesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## ADDRESSES
Street address lines detected: US/EN ("123 Main St", "456 Oak Avenue, Suite 200"), Spanish ("Calle Mayor 12", "Avenida Constitución 25"), PO Box (P.O. Box 123 / Apartado Postal 123), and labeled ("address: ...", "dirección: ..."). Routes "what address?" / "where's the location?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate addresses across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...addresses block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractAddresses,
  buildAddressesForFiles,
  renderAddressesBlock,
  _internal: {
    PATTERNS,
    KINDS,
    STREET_SUFFIX_EN,
    STREET_PREFIX_ES,
  },
};
