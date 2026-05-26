'use strict';

/**
 * document-pricing-extractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pulls explicit pricing / cost / fee statements out of commercial
 * documents (proposals, contracts, SLAs, invoices) so the chat can
 * answer "how much does X cost?" / "what's the rate?" / "are there
 * recurring fees?" with the source sentence intact.
 *
 * Different from document-kpi-extractor (operational metrics with
 * periods + trends) and document-numeric-coherence (math validator):
 * this module specialises in monetary-anchor sentences that name a
 * product / service / line item, attach a currency amount, and (when
 * detectable) attach a billing cadence — per hour / per month /
 * one-time / per user / per seat / annual.
 *
 * Each entry → { label, amount, currency, cadence, sentence }.
 *
 * Bilingual (Spanish + English). Deterministic. < 20 ms on 1 MB.
 *
 * Public API:
 *   extractPricing(text)                  → PricingReport
 *   buildPricingForFiles(files)           → { perFile, aggregate }
 *   renderPricingBlock(batchReport)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_ITEMS_PER_FILE = 16;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4400;
const MIN_SENTENCE_LEN = 12;
const MAX_SENTENCE_LEN = 280;

const CURRENCY_SYMBOLS = [
  { token: 'US$', label: 'USD' },
  { token: 'MX$', label: 'MXN' },
  { token: 'R$', label: 'BRL' },
  { token: 'S/.', label: 'PEN' },
  { token: 'S/', label: 'PEN' },
  { token: '$', label: 'USD' }, // best-effort default
  { token: '€', label: 'EUR' },
  { token: '£', label: 'GBP' },
  { token: '¥', label: 'JPY' },
];

const CADENCE_PATTERNS = [
  { cadence: 'per-hour',  re: /\b(?:per\s+hour|hourly|\/h\b|por\s+hora|x\s+hora)\b/i },
  { cadence: 'per-day',   re: /\b(?:per\s+day|daily|\/day|por\s+d[ií]a)\b/i },
  { cadence: 'per-week',  re: /\b(?:per\s+week|weekly|\/week|por\s+semana|semanal)\b/i },
  { cadence: 'monthly',   re: /\b(?:per\s+month|monthly|\/month|por\s+mes|mensual(?:mente)?)\b/i },
  { cadence: 'quarterly', re: /\b(?:per\s+quarter|quarterly|trimestral|por\s+trimestre)\b/i },
  { cadence: 'annual',    re: /\b(?:per\s+year|per\s+annum|annual(?:ly)?|yearly|anual(?:mente)?|por\s+a[ñn]o)\b/i },
  { cadence: 'per-user',  re: /\b(?:per\s+user|per\s+seat|por\s+usuario|por\s+asiento)\b/i },
  { cadence: 'one-time',  re: /\b(?:one[- ]time|setup\s+fee|cuota\s+(?:inicial|única)|pago\s+único)\b/i },
];

const AMOUNT_RE = /([$€£¥]|US\$|MX\$|R\$|S\/\.?)\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?(?:\s?(?:[KkMmBb]|million|billion|millones?|billones?))?)/g;
const CODE_AMOUNT_RE = /\b(USD|EUR|GBP|JPY|BRL|ARS|MXN|PEN|COP|CLP|CHF)\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?(?:\s?(?:[KkMmBb]|million|billion|millones?|billones?))?)/gi;

const LABEL_BEFORE_AMOUNT_RE = /([A-Z][A-Za-z0-9ÁÉÍÓÚÑáéíóúñ\s/&\-]{2,40})\s*(?:[:=]|\bof\s+|\bes\s+de\s+|\bcuesta\s+|\bvale\s+|\bdel?\s+|\b)\s*([$€£¥]|US\$|MX\$|R\$|S\/\.?)/g;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max = MAX_SENTENCE_LEN) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?。！？])\s+(?=[A-ZÁÉÍÓÚÑ\d"'¿¡(])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_LEN);
}

function symbolToCurrency(symbol) {
  if (!symbol) return null;
  for (const { token, label } of CURRENCY_SYMBOLS) {
    if (symbol === token) return label;
  }
  // Codes are returned as-is.
  return symbol.toUpperCase();
}

function detectCadence(sentence) {
  for (const c of CADENCE_PATTERNS) {
    if (c.re.test(sentence)) return c.cadence;
  }
  return null;
}

function pickLabel(sentence, amountIndex) {
  // Look at the ~50 chars before the amount for a noun-phrase label.
  const lookback = sentence.slice(Math.max(0, amountIndex - 55), amountIndex);
  const m = lookback.match(/([A-ZÁÉÍÓÚÑ][\p{L}\p{N}'\-\s/&]{2,40}?)\s*(?:[:=]|\bof\s+|\bes\s+de\s+|\bcuesta\s+|\bvale\s+|\b)\s*$/u);
  if (m && m[1]) return m[1].trim().replace(/\s+/g, ' ');
  // Fall back: use the first 3-5 words before the amount.
  const words = lookback.match(/[\p{L}\p{N}/&\-]+/gu) || [];
  if (words.length >= 2) return words.slice(-4).join(' ').trim();
  return null;
}

function extractPricing(input) {
  const text = safeText(input);
  if (!text) return { items: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const items = [];
  const seen = new Set();
  for (const sentence of sentences) {
    if (items.length >= MAX_ITEMS_PER_FILE) break;
    const matches = [
      ...sentence.matchAll(new RegExp(AMOUNT_RE.source, AMOUNT_RE.flags)),
      ...sentence.matchAll(new RegExp(CODE_AMOUNT_RE.source, CODE_AMOUNT_RE.flags)),
    ];
    if (matches.length === 0) continue;
    const cadence = detectCadence(sentence);
    const clipped = clip(sentence);
    for (const m of matches) {
      if (items.length >= MAX_ITEMS_PER_FILE) break;
      const currency = symbolToCurrency(m[1]);
      const amount = (m[2] || '').trim();
      if (!amount) continue;
      const label = pickLabel(sentence, m.index || 0);
      const key = `${(label || '').toLowerCase()}|${currency}|${amount}|${clipped.slice(0, 50).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ label, amount, currency, cadence, sentence: clipped });
    }
  }
  return { items, total: items.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildPricingForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractPricing(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, report: r });
    aggregate = aggregate.concat(r.items.map((i) => ({ ...i, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderItem(i, opts = {}) {
  const labelText = i.label ? `**${i.label}**` : '_(unlabelled)_';
  const cadence = i.cadence ? ` _[${i.cadence}]_` : '';
  const file = opts.includeFile && i.file ? ` _(${i.file})_` : '';
  return `- ${labelText}${file} = **${i.currency || ''} ${i.amount}**${cadence} — "${i.sentence}"`;
}

function renderPricingBlock(batchReport) {
  if (!batchReport || !Array.isArray(batchReport.perFile) || batchReport.perFile.length === 0) return '';
  const heading = `## PRICING & FEES
Monetary anchors surfaced from the attached document(s) with their label, currency, amount, and cadence (per hour / monthly / annual / per user / one-time, etc.) when detectable. Quote the source sentence verbatim before claiming a price is firm; cadence and label are best-effort heuristics.`;
  const sections = [];
  if (batchReport.perFile.length === 1) {
    const only = batchReport.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const i of only.report.items) sections.push(renderItem(i));
  } else {
    sections.push('### Aggregate pricing items across all files');
    for (const i of batchReport.aggregate) sections.push(renderItem(i, { includeFile: true }));
    for (const p of batchReport.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const i of p.report.items) sections.push(renderItem(i));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...pricing block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractPricing,
  buildPricingForFiles,
  renderPricingBlock,
  _internal: {
    splitSentences,
    symbolToCurrency,
    detectCadence,
    pickLabel,
    CADENCE_PATTERNS,
    AMOUNT_RE,
    CODE_AMOUNT_RE,
  },
};
