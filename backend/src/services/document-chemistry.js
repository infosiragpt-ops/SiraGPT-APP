'use strict';

/**
 * document-chemistry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects chemical formulas and periodic-table element references:
 *
 *   - Molecular formulas: H2O, CO2, NaCl, C6H12O6, H2SO4
 *   - Ionic / charged: SO4^2-, Cu2+, NH4+
 *   - Element symbols in chemistry context: Fe, Cu, Au, Ag, Hg
 *   - Element names: Hydrogen, Oxygen, Carbon, Iron, Gold, Mercury
 *
 * Routes "what chemicals?" / "what elements?" to a citeable list.
 *
 * Public API:
 *   extractChemistry(text)         → ChemReport
 *   buildChemistryForFiles(files)  → { perFile, aggregate, totals }
 *   renderChemistryBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

// Periodic table symbols (subset, common usage)
const ELEMENT_SYMBOLS = ['H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
  'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca',
  'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn',
  'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr',
  'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn',
  'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'Hf', 'Ta', 'W', 'Re',
  'Os', 'Ir', 'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi', 'Po', 'At',
  'Rn', 'Fr', 'Ra', 'U', 'Pu',
];

const ELEMENT_NAMES = ['Hydrogen', 'Helium', 'Lithium', 'Beryllium', 'Boron',
  'Carbon', 'Nitrogen', 'Oxygen', 'Fluorine', 'Neon',
  'Sodium', 'Magnesium', 'Aluminium', 'Aluminum', 'Silicon', 'Phosphorus',
  'Sulfur', 'Sulphur', 'Chlorine', 'Argon', 'Potassium', 'Calcium',
  'Iron', 'Copper', 'Zinc', 'Bromine', 'Iodine', 'Silver', 'Gold',
  'Mercury', 'Lead', 'Uranium', 'Plutonium', 'Tungsten',
];

const PATTERNS = [
  // Molecular formula: capital letter + lowercase + optional digit, repeating; must contain at least one digit
  { kind: 'formula', re: /\b([A-Z][a-z]?\d*(?:[A-Z][a-z]?\d*){1,10})\b/g },
  // Element name
  { kind: 'element-name', re: new RegExp(`\\b(${ELEMENT_NAMES.join('|')})\\b`, 'g') },
];

const KINDS = ['formula', 'element-name', 'symbol'];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function looksLikeFormula(s) {
  if (!s) return false;
  // Reject common abbreviations
  if (/^(PhD|MBA|MSc|BSc|CEO|CTO|CFO|CIO|VP|HR|PR|QA|UX|UI|IT|AI|ML|API|URL|SQL|JSON|HTML|CSS|HTTP)$/.test(s)) return false;
  // Each capital must be a known element symbol
  const tokens = s.match(/[A-Z][a-z]?/g) || [];
  for (const t of tokens) {
    if (!ELEMENT_SYMBOLS.includes(t)) return false;
  }
  if (tokens.length < 1) return false;
  // Either has a digit (e.g. H2O, CO2) OR has multiple element symbols (e.g. NaCl, KOH)
  return /\d/.test(s) || tokens.length >= 2;
}

function emptyTotals() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractChemistry(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  for (const m of head.matchAll(PATTERNS[0].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const formula = m[1];
    if (!looksLikeFormula(formula)) continue;
    const key = `formula|${formula}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'formula', value: formula });
    totals.formula += 1;
  }

  for (const m of head.matchAll(PATTERNS[1].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const name = m[1];
    const key = `element|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'element-name', value: name });
    totals['element-name'] += 1;
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildChemistryForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractChemistry(safeText(f.extractedText));
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

function renderChemistryBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## CHEMISTRY / FORMULAS
Chemical formulas (molecular: H2O / CO2 / NaCl / C6H12O6, validated against periodic-table element symbols + presence of digits to reject false positives like PhD/MBA) and element names (Hydrogen / Carbon / Iron / Gold / Mercury / ...). Routes "what chemicals?" / "what elements?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate chemistry across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...chemistry block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractChemistry,
  buildChemistryForFiles,
  renderChemistryBlock,
  _internal: {
    ELEMENT_SYMBOLS,
    ELEMENT_NAMES,
    PATTERNS,
    KINDS,
    looksLikeFormula,
  },
};
