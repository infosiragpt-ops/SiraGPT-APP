'use strict';

/**
 * document-payment-ids.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects payment-system object identifiers (NOT secrets — these are
 * customer-visible IDs like invoice numbers). Useful for routing
 * support-ticket triage: "what's the Stripe charge for this dispute?".
 *
 * Targets:
 *   - Stripe:    pi_xxx (payment intent), ch_xxx (charge), sub_xxx, cus_xxx,
 *                in_xxx (invoice), evt_xxx, pm_xxx, src_xxx, txn_xxx, po_xxx,
 *                price_xxx, prod_xxx, sk_test/sk_live (LIVE keys flagged but
 *                value masked)
 *   - PayPal:    PAY-xxx, PAYID-xxx
 *   - Square:    sq0-xxx, generic sq_xxx
 *   - Braintree: txn_xxx
 *
 * Public API:
 *   extractPaymentIds(text)             → { entries, totals, total }
 *   buildPaymentIdsForFiles(files)      → { perFile, aggregate, totals }
 *   renderPaymentIdsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const STRIPE_RE = /\b(pi|ch|sub|cus|in|evt|pm|src|txn|po|price|prod|sk_test|sk_live|pk_test|pk_live|seti|setupi|cs|re)_([A-Za-z0-9]{14,40})\b/g;
const STRIPE_KIND = {
  pi: 'payment-intent', ch: 'charge', sub: 'subscription', cus: 'customer',
  in: 'invoice', evt: 'event', pm: 'payment-method', src: 'source',
  txn: 'transaction', po: 'payout', price: 'price', prod: 'product',
  re: 'refund', cs: 'checkout-session', seti: 'setup-intent', setupi: 'setup-intent',
  sk_test: 'secret-key-test', sk_live: 'secret-key-live',
  pk_test: 'publishable-key-test', pk_live: 'publishable-key-live',
};
const PAYPAL_PAY_RE = /\b(PAY(?:ID)?)-([A-Z0-9]{14,30})\b/g;
const SQUARE_RE = /\bsq0([a-z]{3})-([A-Za-z0-9_-]{20,50})\b/g;

function maskValue(v) {
  if (typeof v !== 'string' || v.length < 8) return '****';
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function isSecret(prefix) {
  return /^(?:sk_test|sk_live|pk_test|pk_live)$/.test(prefix);
}

function extractPaymentIds(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  function push(provider, prefix, kind, masked, isSec) {
    const key = `${provider}:${prefix}:${masked}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ provider, prefix, kind, masked, secret: !!isSec });
    totals[kind] = (totals[kind] || 0) + 1;
  }

  // Stripe
  STRIPE_RE.lastIndex = 0;
  let m;
  while ((m = STRIPE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const prefix = m[1];
    const value = m[2];
    const kind = STRIPE_KIND[prefix] || 'unknown';
    const secret = isSecret(prefix);
    const masked = `${prefix}_${secret ? maskValue(value) : value.slice(0, Math.min(24, value.length))}`;
    push('stripe', prefix, kind, masked, secret);
  }

  // PayPal
  if (entries.length < MAX_PER_FILE) {
    PAYPAL_PAY_RE.lastIndex = 0;
    while ((m = PAYPAL_PAY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const prefix = m[1];
      const value = m[2];
      const kind = 'payment';
      push('paypal', prefix, kind, `${prefix}-${value.slice(0, 24)}`, false);
    }
  }

  // Square
  if (entries.length < MAX_PER_FILE) {
    SQUARE_RE.lastIndex = 0;
    while ((m = SQUARE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const prefix = m[1];
      const value = m[2];
      // sq0idp / sq0csp / sq0idb — Square prefixes encode kind in 3-letter
      const kind = /idp/.test(prefix) ? 'id-production' : 'sandbox';
      push('square', `sq0${prefix}`, kind, `sq0${prefix}-${maskValue(value)}`, true);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildPaymentIdsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractPaymentIds(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.masked)) continue;
      aggSeen.add(e.masked);
      aggregate.push(e);
      totals[e.kind] = (totals[e.kind] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderPaymentIdsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## PAYMENT OBJECT IDs', '- Secret keys (sk_/pk_) and Square IDs masked first-4…last-4; non-secret object IDs preserved'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      const flag = e.secret ? ' ⚠ SECRET' : '';
      lines.push(`- ${e.provider} ${e.kind}: \`${e.masked}\`${flag}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractPaymentIds,
  buildPaymentIdsForFiles,
  renderPaymentIdsBlock,
  _internal: { maskValue, isSecret, STRIPE_KIND },
};
