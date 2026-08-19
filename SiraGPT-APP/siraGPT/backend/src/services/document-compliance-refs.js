'use strict';

/**
 * document-compliance-refs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects compliance / regulation framework references:
 *
 *   - privacy: GDPR (EU), CCPA / CPRA (California), LGPD (Brazil), PIPL (China),
 *              PDPA (Singapore/Thailand), POPIA (South Africa), DPDPA (India)
 *   - healthcare: HIPAA (US), HITECH, GDPR-HEALTH
 *   - finance: PCI DSS, PCI-DSS, SOX, GLBA, MiFID II, PSD2, MAS-TRM
 *   - cloud audit: SOC 1/2/3, SOC2, FedRAMP, ISO 27001, ISO 27017, ISO 27018
 *   - cyber: NIST CSF, NIST 800-53, NIST 800-171, CMMC, FISMA
 *   - other:   COPPA, FERPA, OSHA, EU AI Act, AI Bill of Rights
 *
 * Public API:
 *   extractComplianceRefs(text)             → { entries, totals, total }
 *   buildComplianceRefsForFiles(files)      → { perFile, aggregate, totals }
 *   renderComplianceRefsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const FRAMEWORKS = {
  GDPR: 'privacy', CCPA: 'privacy', CPRA: 'privacy', LGPD: 'privacy', PIPL: 'privacy',
  PDPA: 'privacy', POPIA: 'privacy', DPDPA: 'privacy', APPI: 'privacy',
  HIPAA: 'healthcare', HITECH: 'healthcare', HHS: 'healthcare',
  'PCI DSS': 'finance', 'PCI-DSS': 'finance', SOX: 'finance', GLBA: 'finance',
  'MiFID II': 'finance', PSD2: 'finance', 'MAS-TRM': 'finance', 'GDPR-PSD2': 'finance',
  'SOC 1': 'audit', 'SOC 2': 'audit', 'SOC 3': 'audit', SOC1: 'audit', SOC2: 'audit', SOC3: 'audit',
  FedRAMP: 'audit', 'ISO 27001': 'audit', 'ISO 27017': 'audit', 'ISO 27018': 'audit',
  'ISO/IEC 27001': 'audit', 'ISO/IEC 27017': 'audit',
  'NIST CSF': 'cyber', 'NIST 800-53': 'cyber', 'NIST 800-171': 'cyber', 'NIST SP 800': 'cyber',
  CMMC: 'cyber', FISMA: 'cyber', CISA: 'cyber',
  COPPA: 'consumer', FERPA: 'consumer', OSHA: 'workplace',
  'EU AI Act': 'ai-regulation', 'AI Bill of Rights': 'ai-regulation', 'AI Act': 'ai-regulation',
  'NIS2': 'cyber', 'DORA': 'finance',
};

const TERMS = Object.keys(FRAMEWORKS).sort((a, b) => b.length - a.length);
const TERMS_ALT = TERMS.map((t) => t.replace(/[\s\\/.-]/g, (c) => `[\\${c === '\\' ? '\\\\' : c}\\s]?`)).join('|');
const FRAMEWORK_RE = new RegExp(`\\b(${TERMS_ALT})\\b`, 'g');

function normalise(s) {
  return s.toUpperCase().replace(/\s+/g, ' ').trim();
}

function frameworkCategory(s) {
  const norm = normalise(s);
  for (const [k, v] of Object.entries(FRAMEWORKS)) {
    if (normalise(k) === norm) return { canonical: k, category: v };
  }
  return null;
}

function extractComplianceRefs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { privacy: 0, healthcare: 0, finance: 0, audit: 0, cyber: 0, consumer: 0, workplace: 0, 'ai-regulation': 0 };

  FRAMEWORK_RE.lastIndex = 0;
  let m;
  while ((m = FRAMEWORK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const matched = m[1];
    const meta = frameworkCategory(matched);
    if (!meta) continue;
    if (seen.has(meta.canonical)) continue;
    seen.add(meta.canonical);
    entries.push({ framework: meta.canonical, category: meta.category, raw: matched });
    if (totals[meta.category] != null) totals[meta.category] += 1;
  }

  return { entries, totals, total: entries.length };
}

function buildComplianceRefsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { privacy: 0, healthcare: 0, finance: 0, audit: 0, cyber: 0, consumer: 0, workplace: 0, 'ai-regulation': 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractComplianceRefs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.framework)) continue;
      aggSeen.add(e.framework);
      aggregate.push(e);
      if (totals[e.category] != null) totals[e.category] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderComplianceRefsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## COMPLIANCE / REGULATION FRAMEWORKS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- [${e.category}] ${e.framework}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractComplianceRefs,
  buildComplianceRefsForFiles,
  renderComplianceRefsBlock,
  _internal: { frameworkCategory, FRAMEWORKS },
};
