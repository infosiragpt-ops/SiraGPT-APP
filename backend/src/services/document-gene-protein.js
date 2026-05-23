'use strict';

/**
 * document-gene-protein.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects gene and protein symbols in biomedical / pharma / research docs:
 *
 *   - HGNC gene symbols: BRCA1, TP53, EGFR, KRAS, MYC, BRAF
 *   - Protein notation: p53, p21, pRb
 *   - mRNA / transcript IDs: NM_001234, ENST00000123456
 *   - UniProt accessions: P53_HUMAN, P53527, Q9Y6K9
 *   - rsIDs: rs12345
 *
 * Routes "what genes?" / "what proteins?" to a citeable list.
 *
 * Public API:
 *   extractGeneProtein(text)         → GPReport
 *   buildGeneProteinForFiles(files)  → { perFile, aggregate, totals }
 *   renderGeneProteinBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const KNOWN_GENES = new Set([
  'BRCA1', 'BRCA2', 'TP53', 'EGFR', 'KRAS', 'NRAS', 'HRAS', 'MYC', 'MYCN',
  'BRAF', 'PIK3CA', 'AKT1', 'PTEN', 'APC', 'CDKN2A', 'CDH1', 'RB1', 'NF1',
  'NF2', 'VHL', 'SMAD4', 'STK11', 'MLH1', 'MSH2', 'MSH6', 'PMS2',
  'ALK', 'ROS1', 'RET', 'MET', 'FGFR1', 'FGFR2', 'FGFR3', 'FGFR4',
  'IDH1', 'IDH2', 'JAK2', 'FLT3', 'NPM1', 'CEBPA', 'WT1', 'GATA2',
  'TET2', 'DNMT3A', 'ASXL1', 'EZH2', 'BCL2', 'BCL6', 'MYD88',
  'CD19', 'CD20', 'CD22', 'CD33', 'CD38', 'PD1', 'PDL1', 'CTLA4',
  'APOE', 'LDLR', 'PCSK9', 'CFTR', 'HBB', 'HBA1', 'HBA2', 'DMD',
  'CYP2D6', 'CYP3A4', 'CYP2C19', 'CYP2C9', 'UGT1A1', 'TPMT',
]);

const PATTERNS = [
  // Gene symbols: 2-7 uppercase chars + optional digit
  { kind: 'gene', re: /\b([A-Z]{2,7}\d{0,3}[A-Z]?)\b/g },
  // p53-style protein: p + digit + optional letter
  { kind: 'protein-p', re: /\b(p\d{1,3}[A-Za-z]{0,3})\b/g },
  // RefSeq mRNA: NM_xxxxx
  { kind: 'mrna', re: /\b(NM_\d{4,10})\b/g },
  // Ensembl transcript: ENSTxxxxx
  { kind: 'enst', re: /\b(ENST\d{8,15})\b/g },
  // UniProt accession: P + 5 chars, Q + 5 chars, etc.
  { kind: 'uniprot', re: /\b([OPQ]\d[A-Z0-9]{3}\d)\b/g },
  // rsID
  { kind: 'rsid', re: /\b(rs\d{4,10})\b/g },
];

const KINDS = PATTERNS.map((p) => p.kind);

const COMMON_NON_GENES = new Set([
  'USA', 'USB', 'GPS', 'GPS', 'CPU', 'GPU', 'RAM', 'SSD', 'HTTP', 'HTTPS',
  'JSON', 'YAML', 'CSV', 'PDF', 'HTML', 'CSS', 'SQL', 'API', 'CLI', 'GUI',
  'SDK', 'JWT', 'OAUTH', 'SAML', 'LDAP', 'DNS', 'TCP', 'UDP', 'IP',
  'CEO', 'CTO', 'CFO', 'COO', 'CMO', 'CIO', 'VP', 'HR', 'PR', 'QA',
  'ETC', 'IE', 'EG', 'PHD', 'MBA', 'MSC', 'BSC', 'BCE', 'BCE',
  'AI', 'ML', 'NLP', 'CNN', 'RNN', 'LLM',
]);

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

function extractGeneProtein(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: emptyTotals(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();
  const totals = emptyTotals();

  // Gene symbols — only count if in KNOWN_GENES
  for (const m of head.matchAll(PATTERNS[0].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const sym = m[1];
    if (COMMON_NON_GENES.has(sym)) continue;
    if (!KNOWN_GENES.has(sym)) continue;
    const key = `gene|${sym}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'gene', value: sym });
    totals.gene += 1;
  }

  for (const m of head.matchAll(PATTERNS[1].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const sym = m[1];
    // Only p + digits + optional 1-2 letter modifier
    if (!/^p\d{1,3}([A-Za-z]{1,3})?$/.test(sym)) continue;
    const key = `protein|${sym}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'protein-p', value: sym });
    totals['protein-p'] += 1;
  }

  for (const m of head.matchAll(PATTERNS[2].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const sym = m[1];
    const key = `mrna|${sym}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'mrna', value: sym });
    totals.mrna += 1;
  }

  for (const m of head.matchAll(PATTERNS[3].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const sym = m[1];
    const key = `enst|${sym}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'enst', value: sym });
    totals.enst += 1;
  }

  for (const m of head.matchAll(PATTERNS[4].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const sym = m[1];
    const key = `uniprot|${sym}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'uniprot', value: sym });
    totals.uniprot += 1;
  }

  for (const m of head.matchAll(PATTERNS[5].re)) {
    if (entries.length >= MAX_PER_FILE) break;
    const sym = m[1];
    const key = `rsid|${sym}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind: 'rsid', value: sym });
    totals.rsid += 1;
  }

  return { entries, total: entries.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildGeneProteinForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = emptyTotals();
  for (const f of list) {
    const r = extractGeneProtein(safeText(f.extractedText));
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

function renderGeneProteinBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || emptyTotals();
  const breakdown = KINDS
    .filter((k) => totals[k] > 0)
    .map((k) => `${k}=${totals[k]}`)
    .join('  ');
  const heading = `## GENE / PROTEIN SYMBOLS
Biomedical identifiers detected: HGNC gene symbols (BRCA1/TP53/EGFR/KRAS/MYC/...; whitelist of ~70 commonly studied), p-style proteins (p53/p21/pRb), RefSeq mRNA (NM_001234), Ensembl transcripts (ENST00000123456), UniProt accessions (P53527), and rsIDs (rs12345). Routes "what genes?" / "what proteins?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate gene/protein refs across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...gene/protein block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractGeneProtein,
  buildGeneProteinForFiles,
  renderGeneProteinBlock,
  _internal: {
    KNOWN_GENES,
    COMMON_NON_GENES,
    PATTERNS,
    KINDS,
  },
};
