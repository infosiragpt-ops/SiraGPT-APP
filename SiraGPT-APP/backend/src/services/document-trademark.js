'use strict';

/**
 * document-trademark.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects trademark / IP / copyright markers in branding, legal text:
 *
 *   - ™ trademark
 *   - ® registered trademark
 *   - © copyright (with year + holder pulled from document-licenses)
 *   - ℠ service mark
 *   - "Trademark of …" / "Marca registrada de …" attributions
 *
 * Output captures each marker with surrounding entity-name guess.
 * Routes "what trademarks / brand marks?" to a citeable list.
 * Different from document-licenses (full license blocks) by focusing
 * on inline symbols + the attached entity.
 *
 * Public API:
 *   extractTrademark(text)         → TrademarkReport
 *   buildTrademarkForFiles(files)  → { perFile, aggregate, totals }
 *   renderTrademarkBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;
const MAX_VALUE_LEN = 120;

// Pre-symbol entity: "Acme™", "Apple®"
const PRE_SYMBOL_RE = /([A-Z][A-Za-z0-9\-]{1,30}(?:\s+[A-Z][A-Za-z0-9\-]{1,30}){0,3})(™|®|℠)/g;
// Pre-symbol with C/copy: "Acme©"
const COPYRIGHT_SYMBOL_RE = /(?:^|[\s`'"<>(])(©)\s*(\d{4}(?:[-–]\d{4})?)?\s*([A-Z][A-Za-z0-9.\-]{1,30}(?:\s+[A-Za-z0-9.\-]{1,30}){0,4})?/g;
// "Trademark of Acme" / "Marca registrada de Acme"
const ATTRIBUTION_RE = /\b(?:Trademark|Registered\s+Trademark|Service\s+Mark|Marca\s+(?:registrada|de\s+servicio))\s+(?:of|de)\s+([A-Z][A-Za-z0-9.\-]{1,40}(?:\s+[A-Z][A-Za-z0-9.\-]{1,40}){0,3})/gi;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(v) {
  const s = String(v || '').trim();
  if (s.length <= MAX_VALUE_LEN) return s;
  return `${s.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function emptyTotals() {
  return { trademark: 0, registered: 0, serviceMark: 0, copyright: 0, attribution: 0 };
}

function symbolToKind(s) {
  if (s === '™') return 'trademark';
  if (s === '®') return 'registered';
  if (s === '℠') return 'serviceMark';
  if (s === '©') return 'copyright';
  return null;
}

function extractTrademark(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  function add(kind, entity, source) {
    if (entries.length >= MAX_PER_FILE) return;
    const e = clipValue(entity);
    if (!e) return;
    const key = `${kind}|${e.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, entity: e, source });
    totals[kind] += 1;
  }

  for (const m of head.matchAll(PRE_SYMBOL_RE)) {
    const kind = symbolToKind(m[2]);
    if (!kind) continue;
    add(kind, m[1], 'pre-symbol');
  }
  for (const m of head.matchAll(COPYRIGHT_SYMBOL_RE)) {
    const entity = m[3] ? m[3] : (m[2] ? `(year ${m[2]})` : '(holder unknown)');
    add('copyright', entity, 'copyright-symbol');
  }
  for (const m of head.matchAll(ATTRIBUTION_RE)) {
    add('attribution', m[1], 'attribution');
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildTrademarkForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractTrademark(safeText(f.extractedText));
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
  return `- [${e.kind}]${file} **${e.entity}** _(${e.source})_`;
}

function renderTrademarkBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = Object.keys(totals)
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## TRADEMARKS / IP MARKERS
Inline trademark and IP symbol markers detected in the document(s): ™ (trademark), ® (registered), ℠ (service mark), © (copyright with year and holder), and explicit attributions ("Trademark of …" / "Marca registrada de …"). Different from full license blocks. Routes "what trademarks / brand marks?" to a citeable list.

**Totals:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate trademark markers across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...trademark block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractTrademark,
  buildTrademarkForFiles,
  renderTrademarkBlock,
  _internal: {
    PRE_SYMBOL_RE,
    COPYRIGHT_SYMBOL_RE,
    ATTRIBUTION_RE,
    symbolToKind,
  },
};
