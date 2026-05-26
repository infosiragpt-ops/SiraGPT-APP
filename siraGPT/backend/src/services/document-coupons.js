'use strict';

/**
 * document-coupons.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects promo / coupon / discount codes in marketing docs, contracts:
 *
 *   - "Code: SAVE20", "Promo: BLACKFRIDAY", "Coupon: WELCOME10"
 *   - "Use SAVE20 at checkout"
 *   - Standalone uppercase tokens following "code"/"discount"/"promo"
 *     keywords
 *   - Spanish: "Código: AHORRO20", "Promoción: BLACKFRIDAY"
 *
 * Output captures code + optional discount/value hint nearby. Routes
 * "what's the promo code?" / "what discount?" to a citeable list.
 *
 * Public API:
 *   extractCoupons(text)         → CouponReport
 *   buildCouponsForFiles(files)  → { perFile, aggregate, totals }
 *   renderCouponsBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4000;
const MAX_VALUE_LEN = 40;

const LABELED_RE = /\b(?:Coupon\s+code|Coupon|Promo\s+code|Promo|Code|Discount\s+code|Discount|Voucher|C[óo]digo(?:\s+de\s+(?:descuento|promoci[óo]n|cup[óo]n))?|Promoci[óo]n|Cup[óo]n|Descuento)\s*[:#]?\s*([A-Z][A-Z0-9_\-]{2,29})/gi;
// "Use SAVE20 at checkout" / "Apply SAVE20"
const USE_PHRASE_RE = /\b(?:Use|Apply|Enter|Aplica|Usa|Ingresa)\s+(?:code\s+|c[óo]digo\s+)?([A-Z][A-Z0-9_\-]{2,29})\s+(?:at\s+checkout|on\s+checkout|en\s+el\s+pago|al\s+pagar)?/gi;

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

const STOPWORDS = new Set([
  'NULL', 'TRUE', 'FALSE', 'YES', 'NO', 'OK', 'API', 'CLI', 'SDK', 'HTTP', 'HTTPS',
  'JSON', 'YAML', 'XML', 'PDF', 'PNG', 'JPG', 'GIF', 'CSV', 'TSV', 'BUG', 'FIX',
  'TODO', 'FIXME', 'NOTE', 'HACK', 'XXX', 'WIP', 'WTF',
]);

function isLikelyCode(token) {
  if (!token || token.length < 3 || token.length > 30) return false;
  if (STOPWORDS.has(token.toUpperCase())) return false;
  // Must contain at least one letter and not be pure letters only (some digits boost confidence)
  if (!/[A-Z]/.test(token)) return false;
  return /^[A-Z][A-Z0-9_\-]+$/.test(token);
}

function extractCoupons(input) {
  const text = safeText(input);
  if (!text) return { coupons: [], total: 0, totals: { coupon: 0 }, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const coupons = [];
  const seen = new Set();

  function add(code, source) {
    if (coupons.length >= MAX_PER_FILE) return;
    const c = clipValue(code);
    if (!isLikelyCode(c)) return;
    const key = c.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    coupons.push({ code: c, source });
  }

  for (const m of head.matchAll(LABELED_RE)) {
    add(m[1], 'labeled');
  }
  for (const m of head.matchAll(USE_PHRASE_RE)) {
    add(m[1], 'use-phrase');
  }

  return { coupons, total: coupons.length, totals: { coupon: coupons.length }, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildCouponsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  let total = 0;
  for (const f of list) {
    const r = extractCoupons(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, coupons: r.coupons, totals: r.totals });
    aggregate = aggregate.concat(r.coupons.map((c) => ({ ...c, file: name })));
    total += r.total;
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals: { coupon: total } };
}

function renderCoupon(c, opts = {}) {
  const file = opts.includeFile && c.file ? ` _(${c.file})_` : '';
  return `- \`${c.code}\` _(${c.source})_${file}`;
}

function renderCouponsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## PROMO / COUPON CODES
Promo / coupon / discount codes detected in the document(s): labeled forms ("Code: SAVE20", "Promo: …", "Discount: …", Spanish "Código: …", "Promoción: …") and use-phrase forms ("Use SAVE20 at checkout", "Apply WELCOME10"). Stopword-filtered to exclude common acronyms. Routes "what's the promo code?" / "what discount?" to a citeable list.

**Total codes:** ${report.totals?.coupon || 0}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const c of only.coupons) sections.push(renderCoupon(c));
  } else {
    sections.push('### Aggregate codes across all files');
    for (const c of report.aggregate) sections.push(renderCoupon(c, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const c of p.coupons) sections.push(renderCoupon(c));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...coupons block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractCoupons,
  buildCouponsForFiles,
  renderCouponsBlock,
  _internal: {
    LABELED_RE,
    USE_PHRASE_RE,
    STOPWORDS,
    isLikelyCode,
  },
};
