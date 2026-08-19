'use strict';

/**
 * document-pricing-tiers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects SaaS pricing tier patterns in product pages, comparison docs, sales
 * collateral:
 *
 *   - tier names: Free / Starter / Basic / Pro / Plus / Premium / Business /
 *                 Team / Enterprise / Custom / Unlimited
 *   - per-tier:   "Pro: $20/user/month"
 *   - billing:    "monthly" / "annual" / "yearly" / "per seat" / "per user"
 *   - trials:     "14-day free trial" / "free for 30 days"
 *
 * Public API:
 *   extractPricingTiers(text)             → { entries, totals, total }
 *   buildPricingTiersForFiles(files)      → { perFile, aggregate, totals }
 *   renderPricingTiersBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const TIER_NAMES = [
  'Free', 'Trial', 'Hobby', 'Starter', 'Basic', 'Personal', 'Individual',
  'Pro', 'Plus', 'Premium', 'Advanced', 'Standard',
  'Team', 'Teams', 'Business', 'Enterprise', 'Scale', 'Growth', 'Studio',
  'Custom', 'Unlimited', 'Ultimate',
];
const TIER_ALT = TIER_NAMES.join('|');
const TIER_PRICE_RE = new RegExp(`\\b(${TIER_ALT})(?:\\s+(?:plan|tier|edition))?\\s*[:\\-—]?\\s*(?:from\\s+|starting\\s+at\\s+|\\$|€|£)?(\\d+(?:\\.\\d{1,2})?)(?:\\/(?:user|seat|month|mo|year|yr))?`, 'gi');
const TIER_BARE_RE = new RegExp(`\\b(${TIER_ALT})\\s+(?:plan|tier|edition)\\b`, 'gi');
const BILLING_RE = /\b(monthly|annual|yearly|per\s+seat|per\s+user|billed\s+(?:annually|monthly|quarterly))\b/gi;
const TRIAL_RE = /\b(\d+)[-\s]?day\s+(?:free\s+)?trial\b/gi;
const CONTACT_SALES_RE = /\b(?:contact\s+sales|talk\s+to\s+sales|enterprise\s+pricing|custom\s+pricing|request\s+a\s+quote)\b/gi;

function extractPricingTiers(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { tier: 0, billing: 0, trial: 0, contactSales: 0 };

  function push(kind, raw, normalised) {
    const key = `${kind}:${normalised}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, raw, normalised });
    if (totals[kind] != null) totals[kind] += 1;
  }

  TIER_BARE_RE.lastIndex = 0;
  let m;
  while ((m = TIER_BARE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('tier', m[0], m[1].toLowerCase());
  }

  if (entries.length < MAX_PER_FILE) {
    TIER_PRICE_RE.lastIndex = 0;
    while ((m = TIER_PRICE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const tier = m[1].toLowerCase();
      const price = m[2] ? `${m[2]}` : null;
      push('tier', m[0].slice(0, 50), `${tier}${price ? `@${price}` : ''}`);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    BILLING_RE.lastIndex = 0;
    while ((m = BILLING_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('billing', m[0], m[1].toLowerCase().replace(/\s+/g, '-'));
    }
  }

  if (entries.length < MAX_PER_FILE) {
    TRIAL_RE.lastIndex = 0;
    while ((m = TRIAL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('trial', m[0], `${m[1]}-day`);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    CONTACT_SALES_RE.lastIndex = 0;
    while ((m = CONTACT_SALES_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('contactSales', m[0], 'contact-sales');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildPricingTiersForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { tier: 0, billing: 0, trial: 0, contactSales: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractPricingTiers(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.normalised}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderPricingTiersBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## PRICING TIERS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- [${e.kind}] ${e.raw}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractPricingTiers,
  buildPricingTiersForFiles,
  renderPricingTiersBlock,
  _internal: { TIER_NAMES },
};
