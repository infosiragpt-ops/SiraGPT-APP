'use strict';

/**
 * document-phone-codes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects E.164 phone numbers and country codes in contact info / docs:
 *
 *   - E.164: +1 555 123 4567, +44 20 7946 0958, +52 55 1234 5678
 *   - Labeled forms: "phone: +1 ...", "tel:+1...", "móvil: +52..."
 *   - Bare country code prefix: "Country code: +49"
 *
 * Different from document-contact-info (which captures emails/phones in
 * masked form) by surfacing the country code dimension. Routes "what
 * country phone?" / "what international code?" to a citeable list.
 *
 * Public API:
 *   extractPhoneCodes(text)         → PhoneCodeReport
 *   buildPhoneCodesForFiles(files)  → { perFile, aggregate, totals }
 *   renderPhoneCodesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 20;
const MAX_BLOCK_CHARS = 4500;
const MAX_NUMBER_LEN = 30;

// Common country codes (subset of E.164 country prefixes)
const COUNTRY_CODES = {
  '+1': 'US/CA', '+7': 'RU/KZ', '+20': 'EG', '+27': 'ZA', '+30': 'GR',
  '+31': 'NL', '+32': 'BE', '+33': 'FR', '+34': 'ES', '+36': 'HU',
  '+39': 'IT', '+40': 'RO', '+41': 'CH', '+43': 'AT', '+44': 'GB',
  '+45': 'DK', '+46': 'SE', '+47': 'NO', '+48': 'PL', '+49': 'DE',
  '+51': 'PE', '+52': 'MX', '+53': 'CU', '+54': 'AR', '+55': 'BR',
  '+56': 'CL', '+57': 'CO', '+58': 'VE', '+60': 'MY', '+61': 'AU',
  '+62': 'ID', '+63': 'PH', '+64': 'NZ', '+65': 'SG', '+66': 'TH',
  '+81': 'JP', '+82': 'KR', '+84': 'VN', '+86': 'CN', '+90': 'TR',
  '+91': 'IN', '+92': 'PK', '+95': 'MM', '+98': 'IR',
  '+212': 'MA', '+213': 'DZ', '+216': 'TN', '+218': 'LY', '+220': 'GM',
  '+233': 'GH', '+234': 'NG', '+254': 'KE', '+255': 'TZ', '+256': 'UG',
  '+351': 'PT', '+352': 'LU', '+353': 'IE', '+354': 'IS', '+358': 'FI',
  '+359': 'BG', '+370': 'LT', '+371': 'LV', '+372': 'EE', '+380': 'UA',
  '+385': 'HR', '+386': 'SI', '+420': 'CZ', '+421': 'SK', '+503': 'SV',
  '+504': 'HN', '+505': 'NI', '+506': 'CR', '+507': 'PA', '+591': 'BO',
  '+593': 'EC', '+595': 'PY', '+598': 'UY', '+852': 'HK', '+886': 'TW',
  '+961': 'LB', '+962': 'JO', '+966': 'SA', '+971': 'AE', '+972': 'IL',
};

const PHONE_RE = /(?<![\w])(\+\d{1,3})(?:[\s\-.]?\d){5,15}(?![\w])/g;
const LABELED_RE = /\b(?:phone|tel|telephone|m[óo]vil|cell|tel[ée]fono|whatsapp)\s*[:=]?\s*(\+\d{1,3}(?:[\s\-.]?\d){5,15})/gi;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipNumber(s) {
  const t = String(s || '').trim();
  if (t.length <= MAX_NUMBER_LEN) return t;
  return `${t.slice(0, MAX_NUMBER_LEN - 1)}…`;
}

function matchedCountryCode(s) {
  const cleaned = s.replace(/[\s\-.]/g, '');
  // Try 3-digit then 2-digit then 1-digit
  for (let len = 4; len >= 2; len--) {
    const prefix = cleaned.slice(0, len);
    if (COUNTRY_CODES[prefix]) return { code: prefix, country: COUNTRY_CODES[prefix] };
  }
  return null;
}

function extractPhoneCodes(input) {
  const text = safeText(input);
  if (!text) return { entries: [], total: 0, totals: { total: 0 }, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const entries = [];
  const seen = new Set();

  function add(number, source) {
    if (entries.length >= MAX_PER_FILE) return;
    const n = clipNumber(number);
    if (!n) return;
    const cc = matchedCountryCode(n);
    if (!cc) return;
    const key = n.replace(/\s/g, '');
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ number: n, countryCode: cc.code, country: cc.country, source });
  }

  for (const m of head.matchAll(LABELED_RE)) {
    add(m[1], 'labeled');
  }
  for (const m of head.matchAll(PHONE_RE)) {
    add(m[0], 'bare');
  }

  return { entries, total: entries.length, totals: { total: entries.length }, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildPhoneCodesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  let total = 0;
  for (const f of list) {
    const r = extractPhoneCodes(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, entries: r.entries });
    aggregate = aggregate.concat(r.entries.map((e) => ({ ...e, file: name })));
    total += r.total;
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals: { total } };
}

function renderEntry(e, opts = {}) {
  const file = opts.includeFile && e.file ? ` _(${e.file})_` : '';
  return `- [${e.country}] \`${e.number}\` (cc=${e.countryCode})${file}`;
}

function renderPhoneCodesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const total = report.totals?.total || 0;
  const heading = `## PHONE COUNTRY CODES (E.164)
E.164-style phone numbers detected with country code resolution against a curated table of ~70 country prefixes. Labeled forms (phone: / tel: / móvil: / WhatsApp) and bare +CC patterns. Different from contact-info masking by surfacing the country dimension. Routes "what country phone?" / "what international code?" to a citeable list.

**Total numbers:** ${total}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const e of only.entries) sections.push(renderEntry(e));
  } else {
    sections.push('### Aggregate phone numbers across all files');
    for (const e of report.aggregate) sections.push(renderEntry(e, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const e of p.entries) sections.push(renderEntry(e));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...phone codes block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractPhoneCodes,
  buildPhoneCodesForFiles,
  renderPhoneCodesBlock,
  _internal: {
    COUNTRY_CODES,
    PHONE_RE,
    LABELED_RE,
    matchedCountryCode,
  },
};
