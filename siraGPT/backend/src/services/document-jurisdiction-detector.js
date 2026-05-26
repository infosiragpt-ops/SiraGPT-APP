'use strict';

/**
 * document-jurisdiction-detector.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Surfaces the LEGAL / REGULATORY jurisdiction signals an attached
 * document carries, so the chat can answer "which law applies?",
 * "what's the governing forum?", "which regulator oversees this?"
 * without re-scanning raw text.
 *
 * Detected signals (deterministic, bilingual, no LLM, < 15 ms on 1 MB):
 *
 *   - Country & sub-national jurisdictions
 *     (Delaware, New York, California; EU member states; Spanish-
 *     speaking countries; UK; Brazil; Mexico; Argentina; LatAm.)
 *   - Currency hint
 *     (dominant currency mentioned, e.g. USD vs EUR vs MXN.)
 *   - Governing-law clauses
 *     ("governed by", "regida por", "ley aplicable", "aplicará la
 *      legislación de", "jurisdiction of …".)
 *   - Regulator references
 *     (SEC, FDA, FINRA, FTC, GDPR, ANMAT, CNV, COFECE, CFE, CNBV,
 *      AEPD, etc.)
 *
 * Public API:
 *   detectJurisdiction(text)            → JurisdictionReport
 *   buildJurisdictionForFiles(files)    → { perFile, aggregate }
 *   renderJurisdictionBlock(report)     → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_BLOCK_CHARS = 3600;

const COUNTRY_PATTERNS = [
  { label: 'United States',  re: /\b(United\s+States|USA|U\.S\.A?\.?|EE\.UU\.|Estados\s+Unidos)\b/i },
  { label: 'Delaware',       re: /\b(Delaware|DE)\b/ },
  { label: 'New York',       re: /\b(New\s+York|NY)\b/ },
  { label: 'California',     re: /\b(California|CA)\b/ },
  { label: 'Texas',          re: /\b(Texas|TX)\b/ },
  { label: 'United Kingdom', re: /\b(United\s+Kingdom|UK|Britain|England|Wales|Scotland|Reino\s+Unido)\b/i },
  { label: 'European Union', re: /\b(European\s+Union|EU|Uni[oó]n\s+Europea)\b/i },
  { label: 'Germany',        re: /\b(Germany|Deutschland|Alemania)\b/i },
  { label: 'France',         re: /\b(France|Francia)\b/i },
  { label: 'Spain',          re: /\b(Spain|Espa[ñn]a|Reino\s+de\s+Espa[ñn]a)\b/i },
  { label: 'Brazil',         re: /\b(Brazil|Brasil)\b/i },
  { label: 'Mexico',         re: /\b(Mexico|M[éeé]xico|Estados\s+Unidos\s+Mexicanos)\b/i },
  { label: 'Argentina',      re: /\b(Argentina|Rep[uú]blica\s+Argentina)\b/i },
  { label: 'Peru',           re: /\b(Peru|Per[úu]|Rep[uú]blica\s+del\s+Per[úu])\b/i },
  { label: 'Colombia',       re: /\b(Colombia|Rep[uú]blica\s+de\s+Colombia)\b/i },
  { label: 'Chile',          re: /\b(Chile|Rep[uú]blica\s+de\s+Chile)\b/i },
  { label: 'Japan',          re: /\b(Japan|Jap[óo]n)\b/i },
  { label: 'China',          re: /\b(China|People's\s+Republic\s+of\s+China|PRC)\b/i },
  { label: 'India',          re: /\b(India|Rep[uú]blica\s+de\s+India)\b/i },
];

const CURRENCY_PATTERNS = [
  { code: 'USD', re: /\b(USD|US\$|U\.S\.\s*dollars?|d[oó]lar(?:es)?\s+(?:estadounidense|americano|de\s+EE\.UU\.))\b/i },
  { code: 'EUR', re: /\b(EUR|€|euros?)\b/i },
  { code: 'GBP', re: /\b(GBP|£|pound(?:s)?\s+sterling)\b/i },
  { code: 'MXN', re: /\b(MXN|MX\$|peso(?:s)?\s+mexicano)\b/i },
  { code: 'BRL', re: /\b(BRL|R\$|real(?:es)?\s+brasile[ñn]o)\b/i },
  { code: 'ARS', re: /\b(ARS|peso(?:s)?\s+argentino)\b/i },
  { code: 'PEN', re: /\b(PEN|S\/\.?\s|sol(?:es)?\s+peruano)\b/i },
  { code: 'COP', re: /\b(COP|peso(?:s)?\s+colombiano)\b/i },
  { code: 'CLP', re: /\b(CLP|peso(?:s)?\s+chileno)\b/i },
  { code: 'JPY', re: /\b(JPY|¥|yen(?:es)?)\b/i },
  { code: 'CHF', re: /\b(CHF|franco(?:s)?\s+suizo)\b/i },
];

const REGULATOR_PATTERNS = [
  { label: 'SEC',     re: /\b(SEC|Securities\s+and\s+Exchange\s+Commission)\b/ },
  { label: 'FDA',     re: /\bFDA\b/ },
  { label: 'FINRA',   re: /\bFINRA\b/ },
  { label: 'FTC',     re: /\b(FTC|Federal\s+Trade\s+Commission)\b/ },
  { label: 'GDPR',    re: /\bGDPR|General\s+Data\s+Protection\s+Regulation\b/i },
  { label: 'HIPAA',   re: /\bHIPAA\b/i },
  { label: 'IRS',     re: /\bIRS|Internal\s+Revenue\s+Service\b/i },
  { label: 'AEPD',    re: /\bAEPD|Agencia\s+Espa[ñn]ola\s+de\s+Protecci[oó]n\s+de\s+Datos\b/i },
  { label: 'CNMV',    re: /\bCNMV|Comisi[oó]n\s+Nacional\s+del\s+Mercado\s+de\s+Valores\b/i },
  { label: 'CNV',     re: /\bCNV\b/ },
  { label: 'CNBV',    re: /\bCNBV|Comisi[oó]n\s+Nacional\s+Bancaria\s+y\s+de\s+Valores\b/i },
  { label: 'COFECE',  re: /\bCOFECE\b/ },
  { label: 'ANMAT',   re: /\bANMAT\b/ },
  { label: 'SUNARP',  re: /\bSUNARP\b/ },
];

const GOVERNING_LAW_PATTERNS = [
  /\b(?:governed\s+by|subject\s+to|in\s+accordance\s+with)\s+(?:the\s+)?(?:laws?\s+of|laws\s+and\s+regulations\s+of)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ\s,.-]{2,60})[\.;,]/i,
  /\b(?:jurisdiction\s+of)\s+(?:the\s+)?(?:courts?\s+of\s+)?([A-Za-zÁÉÍÓÚÑáéíóúñ\s,.-]{2,60})[\.;,]/i,
  /(?:^|[^\p{L}])(?:regida?\s+por\s+|ley\s+aplicable\s+|aplicará\s+la\s+(?:legislación|ley)\s+de\s+|sujet[oa]\s+a\s+las\s+leyes\s+de\s+)([A-Za-zÁÉÍÓÚÑáéíóúñ\s,.-]{2,60})[\.;,]/iu,
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max = 240) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function countAll(text, re) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  let count = 0;
  for (const _ of text.matchAll(global)) count++;
  return count;
}

function detectJurisdiction(input) {
  const text = safeText(input);
  if (!text) {
    return {
      countries: [],
      currencies: [],
      regulators: [],
      governingLaw: [],
      truncated: false,
    };
  }
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;

  const countries = COUNTRY_PATTERNS
    .map((p) => ({ label: p.label, mentions: countAll(head, p.re) }))
    .filter((p) => p.mentions > 0)
    .sort((a, b) => b.mentions - a.mentions);

  const currencies = CURRENCY_PATTERNS
    .map((p) => ({ code: p.code, mentions: countAll(head, p.re) }))
    .filter((p) => p.mentions > 0)
    .sort((a, b) => b.mentions - a.mentions);

  const regulators = REGULATOR_PATTERNS
    .map((p) => ({ label: p.label, mentions: countAll(head, p.re) }))
    .filter((p) => p.mentions > 0)
    .sort((a, b) => b.mentions - a.mentions);

  const governingLaw = [];
  const seen = new Set();
  for (const re of GOVERNING_LAW_PATTERNS) {
    const cloned = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of head.matchAll(cloned)) {
      const phrase = (m[1] || '').trim().replace(/[\s,]+$/, '');
      if (!phrase || phrase.length < 3) continue;
      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      governingLaw.push({ jurisdiction: clip(phrase, 80), excerpt: clip(m[0], 240) });
      if (governingLaw.length >= 4) break;
    }
    if (governingLaw.length >= 4) break;
  }

  return {
    countries: countries.slice(0, 8),
    currencies: currencies.slice(0, 6),
    regulators: regulators.slice(0, 8),
    governingLaw,
    truncated: text.length > SCAN_HEAD_BYTES,
  };
}

function buildJurisdictionForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  for (const f of list) {
    const text = safeText(f.extractedText);
    if (!text) continue;
    const r = detectJurisdiction(text);
    if (r.countries.length === 0 && r.currencies.length === 0 && r.regulators.length === 0 && r.governingLaw.length === 0) continue;
    perFile.push({ file: safeFileName(f), report: r });
  }
  return { perFile };
}

function renderJurisdictionBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## JURISDICTION & APPLICABLE LAW
Legal / regulatory signals surfaced per attached document — country / sub-national jurisdictions mentioned, dominant currency, regulator references, and any explicit governing-law clauses. Use this to answer "which law applies?" / "which regulator oversees this?" without re-scanning raw text; quote the governing-law clause verbatim before claiming a forum.`;
  const sections = [];
  for (const entry of report.perFile) {
    const r = entry.report;
    sections.push(`### File: ${entry.file}`);
    if (r.countries.length) sections.push(`**Countries / regions:** ${r.countries.map((c) => `${c.label} (${c.mentions})`).join(', ')}`);
    if (r.currencies.length) sections.push(`**Currencies:** ${r.currencies.map((c) => `${c.code} (${c.mentions})`).join(', ')}`);
    if (r.regulators.length) sections.push(`**Regulators / authorities:** ${r.regulators.map((c) => `${c.label} (${c.mentions})`).join(', ')}`);
    if (r.governingLaw.length) {
      sections.push('**Governing-law clauses:**');
      for (const g of r.governingLaw) sections.push(`- _${g.jurisdiction}_ — "${g.excerpt}"`);
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...jurisdiction block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  detectJurisdiction,
  buildJurisdictionForFiles,
  renderJurisdictionBlock,
  _internal: {
    countAll,
    COUNTRY_PATTERNS,
    CURRENCY_PATTERNS,
    REGULATOR_PATTERNS,
    GOVERNING_LAW_PATTERNS,
  },
};
