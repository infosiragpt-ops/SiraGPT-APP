'use strict';

/**
 * document-compliance-matcher.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects mentions of regulated COMPLIANCE FRAMEWORKS in attached
 * documents so the chat can answer "which standards / regulations
 * apply?" / "is this GDPR-compliant?" with a citeable list.
 *
 * Different from document-jurisdiction-detector (countries / forum /
 * governing law): this module names the SPECIFIC framework or
 * standard each document references, with a one-line description so
 * the model can speak to it without inventing detail.
 *
 * Coverage (deterministic, no LLM, < 12 ms on 1 MB):
 *
 *   Data protection / privacy
 *     GDPR, CCPA, LGPD, HIPAA, PIPEDA, FERPA, COPPA, AEPD
 *   Security
 *     ISO 27001, SOC 1, SOC 2, SOC 3, NIST CSF, NIST 800-53, PCI-DSS,
 *     FedRAMP
 *   Financial
 *     SOX, Basel II/III, MiFID II, Dodd-Frank, IFRS
 *   Quality / safety
 *     ISO 9001, ISO 14001, ISO 45001, GMP, GxP, HACCP
 *   AI / emerging
 *     EU AI Act, NIST AI RMF
 *
 * Public API:
 *   detectFrameworks(text)             → FrameworkReport
 *   buildComplianceForFiles(files)     → { perFile, aggregate }
 *   renderComplianceBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_BLOCK_CHARS = 3600;

const FRAMEWORKS = [
  { key: 'GDPR',          re: /\b(GDPR|General\s+Data\s+Protection\s+Regulation|Reglamento\s+General\s+de\s+Protecci[oó]n\s+de\s+Datos|RGPD)\b/i, summary: 'EU data protection regulation (2016/679)' },
  { key: 'CCPA',          re: /\b(CCPA|California\s+Consumer\s+Privacy\s+Act|CPRA)\b/i, summary: 'California Consumer Privacy Act / CPRA' },
  { key: 'LGPD',          re: /\b(LGPD|Lei\s+Geral\s+de\s+Prote[çc][ãa]o\s+de\s+Dados)\b/i, summary: 'Brazilian data protection law (13.709/2018)' },
  { key: 'HIPAA',         re: /\bHIPAA\b/i, summary: 'US health information privacy (Health Insurance Portability and Accountability Act)' },
  { key: 'PIPEDA',        re: /\bPIPEDA\b/i, summary: 'Canadian Personal Information Protection and Electronic Documents Act' },
  { key: 'FERPA',         re: /\bFERPA\b/i, summary: 'US Family Educational Rights and Privacy Act' },
  { key: 'COPPA',         re: /\bCOPPA\b/i, summary: 'US Children\'s Online Privacy Protection Act' },
  { key: 'ISO 27001',     re: /\bISO\s*\/?\s*IEC\s*27001|ISO\s*27001\b/i, summary: 'Information security management system standard' },
  { key: 'ISO 27017',     re: /\bISO\s*\/?\s*IEC\s*27017\b/i, summary: 'Cloud security controls extension to ISO 27001' },
  { key: 'ISO 27018',     re: /\bISO\s*\/?\s*IEC\s*27018\b/i, summary: 'PII protection in public cloud services' },
  { key: 'SOC 1',         re: /\bSOC\s*1\b|System\s+and\s+Organization\s+Controls\s+1/i, summary: 'AICPA report on financial-reporting controls' },
  { key: 'SOC 2',         re: /\bSOC\s*2\b/i, summary: 'AICPA report on security / availability / processing integrity / confidentiality / privacy' },
  { key: 'SOC 3',         re: /\bSOC\s*3\b/i, summary: 'Public-facing summary of SOC 2 results' },
  { key: 'NIST CSF',      re: /\bNIST\s+(?:Cybersecurity\s+Framework|CSF)\b/i, summary: 'NIST Cybersecurity Framework (Identify / Protect / Detect / Respond / Recover)' },
  { key: 'NIST 800-53',   re: /\bNIST\s*(?:SP)?\s*800[-\s]?53\b/i, summary: 'NIST Special Publication 800-53 security & privacy controls' },
  { key: 'PCI-DSS',       re: /\bPCI[-\s]?DSS\b/i, summary: 'Payment Card Industry Data Security Standard' },
  { key: 'FedRAMP',       re: /\bFedRAMP\b/i, summary: 'US Federal Risk and Authorization Management Program' },
  { key: 'SOX',           re: /\b(SOX|Sarbanes[-\s]?Oxley\s*(?:Act)?)\b/i, summary: 'Sarbanes-Oxley Act of 2002 (US public-company accountability)' },
  { key: 'Basel III',     re: /\bBasel\s+(?:III|3)\b/i, summary: 'BCBS bank capital adequacy / liquidity framework' },
  { key: 'Basel II',      re: /\bBasel\s+(?:II|2)\b/i, summary: 'BCBS predecessor capital framework' },
  { key: 'MiFID II',      re: /\bMiFID\s*(?:II|2)?\b/i, summary: 'EU Markets in Financial Instruments Directive' },
  { key: 'Dodd-Frank',    re: /\bDodd[-\s]?Frank\b/i, summary: 'US Wall Street Reform and Consumer Protection Act' },
  { key: 'IFRS',          re: /\bIFRS(?:\s+\d+)?\b/i, summary: 'International Financial Reporting Standards' },
  { key: 'ISO 9001',      re: /\bISO\s*9001\b/i, summary: 'Quality management systems standard' },
  { key: 'ISO 14001',     re: /\bISO\s*14001\b/i, summary: 'Environmental management systems standard' },
  { key: 'ISO 45001',     re: /\bISO\s*45001\b/i, summary: 'Occupational health & safety management system standard' },
  { key: 'GMP',           re: /\bGMP|Good\s+Manufacturing\s+Practice\b/i, summary: 'Good Manufacturing Practice (pharma / food)' },
  { key: 'GxP',           re: /\bGxP\b/i, summary: 'Good Practice family of regulated-life-sciences standards' },
  { key: 'HACCP',         re: /\bHACCP\b/i, summary: 'Hazard Analysis and Critical Control Points (food safety)' },
  { key: 'EU AI Act',     re: /\b(EU\s+AI\s+Act|Reglamento\s+(?:Europeo\s+)?de\s+(?:la\s+)?Inteligencia\s+Artificial)\b/i, summary: 'EU AI Act (2024)' },
  { key: 'NIST AI RMF',   re: /\bNIST\s+AI\s+RMF\b/i, summary: 'NIST AI Risk Management Framework (1.0)' },
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function countAll(text, re) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  let count = 0;
  for (const _ of text.matchAll(global)) count++;
  return count;
}

function detectFrameworks(input) {
  const text = safeText(input);
  if (!text) return { frameworks: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const frameworks = [];
  for (const f of FRAMEWORKS) {
    const mentions = countAll(head, f.re);
    if (mentions === 0) continue;
    frameworks.push({ key: f.key, mentions, summary: f.summary });
  }
  frameworks.sort((a, b) => b.mentions - a.mentions);
  return { frameworks, total: frameworks.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildComplianceForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  const aggregateCounts = new Map();
  for (const f of list) {
    const text = safeText(f.extractedText);
    if (!text) continue;
    const r = detectFrameworks(text);
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, frameworks: r.frameworks });
    for (const fw of r.frameworks) {
      const cur = aggregateCounts.get(fw.key) || { key: fw.key, mentions: 0, summary: fw.summary };
      cur.mentions += fw.mentions;
      aggregateCounts.set(fw.key, cur);
    }
  }
  const aggregate = Array.from(aggregateCounts.values()).sort((a, b) => b.mentions - a.mentions);
  return { perFile, aggregate };
}

function renderFrameworkLine(f, opts = {}) {
  const file = opts.includeFile && f.file ? ` _(${f.file})_` : '';
  return `- **${f.key}**${file} — ${f.summary} _(${f.mentions} mention${f.mentions === 1 ? '' : 's'})_`;
}

function renderComplianceBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## COMPLIANCE FRAMEWORKS
Regulated standards / frameworks mentioned across the attached document(s) with a short summary and mention count. Use this block to answer "which standards apply?" / "is this GDPR-compliant?" without conflating frameworks; quote the source clause before claiming applicability.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const f of only.frameworks) sections.push(renderFrameworkLine(f));
  } else {
    sections.push('### Aggregate frameworks across all files');
    for (const f of report.aggregate) sections.push(renderFrameworkLine(f));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const f of p.frameworks) sections.push(renderFrameworkLine(f));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...compliance block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  detectFrameworks,
  buildComplianceForFiles,
  renderComplianceBlock,
  _internal: {
    countAll,
    FRAMEWORKS,
  },
};
