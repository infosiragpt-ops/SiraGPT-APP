'use strict';

/**
 * document-taxa.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects binomial nomenclature for biological taxa (Linnaean naming):
 *
 *   - Genus species: Homo sapiens, Escherichia coli, Canis lupus
 *   - Italicized in markdown: *Homo sapiens*
 *   - Family names: -aceae (plants), -idae (animals)
 *
 * Pattern: a capitalized genus word + lowercase species word (Latin chars,
 * 4-25 chars each), with optional italic wrapper.
 *
 * Filtered to require either italics OR a known genus-like form (must end
 * in vowel, etc.). Routes "what species?" / "what taxon?" to a citeable list.
 *
 * Public API:
 *   extractTaxa(text)         → TaxonReport
 *   buildTaxaForFiles(files)  → { perFile, aggregate, totals }
 *   renderTaxaBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const PATTERNS = [
  // Italicized binomial: *Homo sapiens* or _Homo sapiens_
  { kind: 'italic', re: /(?:\*|_)([A-Z][a-zA-Z]{2,24}\s+[a-z]{3,28})(?:\*|_)/g },
  // Bare binomial (high risk — restricted with stricter heuristics)
  { kind: 'binomial', re: /\b([A-Z][a-z]{2,24}\s+[a-z]{3,28})\b/g },
  // Family taxa ending in -aceae or -idae
  { kind: 'family', re: /\b([A-Z][a-z]{2,30}(?:aceae|idae))\b/g },
];

const KINDS = PATTERNS.map((p) => p.kind);

// Filter out common false positives
const STOP_PAIRS = new Set([
  'New york', 'Los angeles', 'San francisco', 'San diego', 'Las vegas',
  'United states', 'United kingdom', 'Hong kong', 'New jersey',
  'San jose', 'San antonio', 'El salvador', 'Costa rica', 'Puerto rico',
  'New mexico', 'New hampshire', 'New zealand', 'South africa', 'South korea',
  'North korea', 'Saudi arabia', 'Dominican republic',
]);

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function isLikelyTaxon(text) {
  if (!text) return false;
  if (STOP_PAIRS.has(text)) return false;
  // Reject if either word is too short
  const [genus, species] = text.split(/\s+/);
  if (!genus || !species) return false;
  if (genus.length < 3 || species.length < 4) return false;
  // Reject if species starts with capital (suggests place name like "New York")
  if (/^[A-Z]/.test(species)) return false;
  return true;
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractTaxa(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  // Process italic first (high confidence)
  const italicMatches = new Set();
  for (const m of head.matchAll(PATTERNS[0].re)) {
    const taxon = m[1];
    if (!isLikelyTaxon(taxon)) continue;
    italicMatches.add(taxon);
    if (entries.length >= MAX_PER_FILE) break;
    const key = `italic|${taxon.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'italic', name: taxon });
    totals.italic += 1;
  }

  // Bare binomial — only accept if italics had nothing for this term
  for (const m of head.matchAll(PATTERNS[1].re)) {
    const taxon = m[1];
    if (italicMatches.has(taxon)) continue;
    if (!isLikelyTaxon(taxon)) continue;
    if (entries.length >= MAX_PER_FILE) break;
    const key = `binomial|${taxon.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'binomial', name: taxon });
    totals.binomial += 1;
  }

  // Family
  for (const m of head.matchAll(PATTERNS[2].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const name = m[1];
    const key = `family|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'family', name });
    totals.family += 1;
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildTaxaForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractTaxa(safeText(f.extractedText));
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
  return `- [${e.kind}] _${e.name}_${file}`;
}

function renderTaxaBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## BIOLOGICAL TAXA
Linnaean binomial nomenclature (Genus species) detected in the document(s): italicized form (*Homo sapiens*), bare binomial (filtered against place-name confusions), and family taxa ending in -aceae (plants) or -idae (animals). Routes "what species?" / "what taxon?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate taxa across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...taxa block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractTaxa,
  buildTaxaForFiles,
  renderTaxaBlock,
  _internal: {
    PATTERNS,
    KINDS,
    STOP_PAIRS,
    isLikelyTaxon,
  },
};
