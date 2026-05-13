'use strict';

/**
 * document-identifiers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracts standardized DOCUMENT IDENTIFIERS — ISBN / ISSN / DOI for
 * academic / publishing; ticker / CUSIP / CIK for finance; ARN / UUID
 * / GUID for technical / cloud refs. Routes "what's the document
 * identifier?" / "what ticker is this for?" to a citeable list.
 *
 * Public API:
 *   extractIdentifiers(text)             → IdentifierReport
 *   buildIdentifiersForFiles(files)      → { perFile, aggregate }
 *   renderIdentifiersBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE_PER_KIND = 6;
const MAX_BLOCK_CHARS = 3600;

const ID_PATTERNS = [
  { kind: 'ISBN-13', re: /\bISBN(?:-13)?[:\s]*97[89][\s-]?(?:\d[\s-]?){9}\d\b/gi },
  { kind: 'ISBN-10', re: /\bISBN(?:-10)?[:\s]*(?:\d[\s-]?){9}[\dXx]\b/gi },
  { kind: 'ISSN',    re: /\bISSN[:\s]*\d{4}-\d{3}[\dXx]\b/gi },
  { kind: 'DOI',     re: /\b(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)10\.\d{4,9}\/[\w.\-/()]+/gi },
  { kind: 'PMID',    re: /\bPMID[:\s]*\d{4,9}\b/gi },
  { kind: 'arXiv',   re: /\barXiv:\s*\d{4}\.\d{4,5}(?:v\d+)?\b/gi },
  { kind: 'ticker',  re: /\b(?:NYSE|NASDAQ|TICKER)\s*[:\s]+[A-Z]{1,5}\b|\$[A-Z]{1,5}\b/g },
  { kind: 'CUSIP',   re: /\bCUSIP[:\s]*[A-Z0-9]{9}\b/gi },
  { kind: 'CIK',     re: /\bCIK[:\s]*0*\d{4,10}\b/gi },
  { kind: 'SEDOL',   re: /\bSEDOL[:\s]*[A-Z0-9]{7}\b/gi },
  { kind: 'ISIN',    re: /\b(?:ISIN[:\s]*)?[A-Z]{2}[A-Z0-9]{9}\d\b/g },
  { kind: 'UUID',    re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g },
  { kind: 'AWS-ARN', re: /\barn:(?:aws|aws-cn|aws-us-gov):[a-zA-Z0-9-]{2,30}:[a-z0-9-]*:\d{0,12}:[\w/\-.:*]+/g },
  { kind: 'CVE',     re: /\bCVE-\d{4}-\d{4,7}\b/gi },
  { kind: 'RFC',     re: /\bRFC[\s-]?\d{1,5}\b/g },
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function unique(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const k = String(v).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function extractIdentifiers(input) {
  const text = safeText(input);
  if (!text) return { identifiers: {}, total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const out = {};
  let total = 0;
  for (const { kind, re } of ID_PATTERNS) {
    const matches = unique(Array.from(head.matchAll(re), (m) => m[0])).slice(0, MAX_PER_FILE_PER_KIND);
    if (matches.length === 0) continue;
    out[kind] = matches;
    total += matches.length;
  }
  return { identifiers: out, total, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildIdentifiersForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  const aggregateCounts = new Map();
  for (const f of list) {
    const r = extractIdentifiers(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, identifiers: r.identifiers });
    for (const [kind, values] of Object.entries(r.identifiers)) {
      aggregateCounts.set(kind, (aggregateCounts.get(kind) || 0) + values.length);
    }
  }
  const aggregate = Array.from(aggregateCounts.entries())
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);
  return { perFile, aggregate };
}

function renderIdentifiersBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## DOCUMENT IDENTIFIERS
Standardised identifiers detected per attached file — ISBN / ISSN / DOI / arXiv / PMID (publishing & academic); ticker / CUSIP / CIK / SEDOL / ISIN (finance); UUID / AWS ARN / CVE / RFC (technical). Use this block to anchor the chat's answer in the source's stated identifiers when the user asks "what's the ID?" / "which ticker is this for?".`;
  const sections = [];
  for (const entry of report.perFile) {
    sections.push(`### File: ${entry.file}`);
    for (const [kind, values] of Object.entries(entry.identifiers)) {
      sections.push(`- **${kind}**: ${values.join(', ')}`);
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...identifiers block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractIdentifiers,
  buildIdentifiersForFiles,
  renderIdentifiersBlock,
  _internal: {
    unique,
    ID_PATTERNS,
  },
};
