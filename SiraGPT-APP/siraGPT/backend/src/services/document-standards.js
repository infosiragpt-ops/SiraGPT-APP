'use strict';

/**
 * document-standards.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects formal standards references in compliance / engineering / regulatory
 * documents:
 *
 *   - ISO standards: ISO 9001, ISO/IEC 27001:2022
 *   - ANSI: ANSI/ASME Y14.5
 *   - IEEE: IEEE 802.11, IEEE 754
 *   - RFC: RFC 7231 (HTTP/1.1 semantics)
 *   - NIST: NIST SP 800-53
 *   - W3C: W3C HTML5, W3C CSS Snapshot 2024
 *   - GDPR / HIPAA / PCI-DSS / SOC 2 (compliance abbreviations)
 *
 * Different from document-identifiers (DOI, ISBN, CVE) and document-compliance
 * (clause-level GDPR / HIPAA detail) by focusing on standard codes with
 * issuer + number. Routes "what standards does this reference?" /
 * "is this ISO 27001 compliant?" to a citeable list.
 *
 * Public API:
 *   extractStandards(text)         → StandardsReport
 *   buildStandardsForFiles(files)  → { perFile, aggregate, totals }
 *   renderStandardsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_KIND = 10;
const MAX_PER_FILE = 30;
const MAX_AGGREGATE = 36;
const MAX_BLOCK_CHARS = 5500;
const MAX_VALUE_LEN = 80;

const STANDARDS_PATTERNS = [
  { kind: 'ISO',  re: /\bISO(?:\/IEC)?\s+(\d{1,5}(?:[\-_]?\d{1,4})?(?::\d{4})?)/g },
  { kind: 'ANSI', re: /\bANSI(?:\/ASME|\/ASTM|\/ISO|\/IEEE)?\s+([A-Z]?\d{1,5}(?:[-./]?\d{1,4})?)/g },
  { kind: 'IEEE', re: /\bIEEE\s+(\d{1,4}(?:\.\d{1,4}[a-z]?)?(?:-\d{4})?)/g },
  { kind: 'RFC',  re: /\bRFC[\s-]?(\d{1,5})/g },
  { kind: 'NIST', re: /\bNIST\s+(?:SP\s+)?(\d{3,4}(?:[-_]\d{1,3})?(?:[A-Z]\d?)?)/g },
  { kind: 'W3C',  re: /\bW3C\s+([A-Z][A-Za-z0-9-]{1,30}(?:\s+\d+(?:\.\d+)?)?)/g },
  { kind: 'EN',   re: /\bEN\s+(\d{1,5}(?:-\d{1,4})?(?::\d{4})?)/g },
  { kind: 'DIN',  re: /\bDIN\s+(\d{1,5}(?:-\d{1,4})?)/g },
  { kind: 'PCI',  re: /\b(PCI[\s-]?DSS(?:\s+(?:v?\d(?:\.\d)?|requirement\s+\d{1,2}(?:\.\d{1,2})?))?)/gi },
  { kind: 'SOC',  re: /\b(SOC\s*(?:1|2|3)(?:\s+Type\s+(?:I|II))?)/gi },
  { kind: 'compliance', re: /\b(GDPR|HIPAA|FERPA|CCPA|LGPD|FedRAMP|ITAR|FISMA|SOX|FCRA)\b/g },
];

const KINDS = ['ISO', 'ANSI', 'IEEE', 'RFC', 'NIST', 'W3C', 'EN', 'DIN', 'PCI', 'SOC', 'compliance'];

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

function emptyByKind() {
  const r = {};
  for (const k of KINDS) r[k] = 0;
  return r;
}

function extractStandards(input) {
  const text = safeText(input);
  if (!text) return { standards: [], total: 0, byKind: emptyByKind(), truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const standards = [];
  const seen = new Set();
  const byKind = emptyByKind();

  for (const { kind, re } of STANDARDS_PATTERNS) {
    re.lastIndex = 0;
    for (const m of head.matchAll(re)) {
      if (standards.length >= MAX_PER_FILE) break;
      if (byKind[kind] >= MAX_PER_KIND) break;
      const number = clipValue(m[1]);
      if (!number) continue;
      const key = `${kind}|${number.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      standards.push({ kind, value: number });
      byKind[kind] += 1;
    }
  }

  return { standards, total: standards.length, byKind, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildStandardsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const byKind = emptyByKind();
  for (const f of list) {
    const r = extractStandards(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, standards: r.standards, byKind: r.byKind });
    aggregate = aggregate.concat(r.standards.map((s) => ({ ...s, file: name })));
    for (const k of KINDS) byKind[k] += r.byKind[k];
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, byKind };
}

function renderStandard(s, opts = {}) {
  const file = opts.includeFile && s.file ? ` _(${s.file})_` : '';
  return `- [${s.kind}] **${s.value}**${file}`;
}

function renderStandardsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const byKind = report.byKind || emptyByKind();
  const breakdown = KINDS
    .filter((k) => byKind[k] > 0)
    .map((k) => `${k}=${byKind[k]}`)
    .join('  ');
  const heading = `## STANDARDS / SPECIFICATIONS
Formal standard references detected in the document(s): ISO (incl. ISO/IEC), ANSI (incl. ANSI/ASME, ANSI/ASTM), IEEE, RFC (IETF), NIST SP, W3C, EN, DIN, PCI-DSS, SOC 1/2/3, plus compliance abbreviations (GDPR, HIPAA, FERPA, CCPA, LGPD, FedRAMP, ITAR, FISMA, SOX, FCRA). Routes "what standards?" / "is this ISO 27001 compliant?" to a citeable list.

**By kind:** ${breakdown || '(none)'}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const s of only.standards) sections.push(renderStandard(s));
  } else {
    sections.push('### Aggregate standards across all files');
    for (const s of report.aggregate) sections.push(renderStandard(s, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const s of p.standards) sections.push(renderStandard(s));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...standards block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractStandards,
  buildStandardsForFiles,
  renderStandardsBlock,
  _internal: {
    STANDARDS_PATTERNS,
    KINDS,
  },
};
