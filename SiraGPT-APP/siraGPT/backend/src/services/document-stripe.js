'use strict';

/**
 * document-stripe.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Stripe API object IDs and method calls. Object IDs are MASKED
 * (prefix + last 4 chars).
 *
 *   - Customer IDs:      cus_XXX
 *   - PaymentIntent IDs: pi_XXX
 *   - Charge IDs:        ch_XXX
 *   - Invoice IDs:       in_XXX
 *   - Subscription IDs:  sub_XXX
 *   - Product/Price:     prod_XXX / price_XXX
 *   - Setup intents:     seti_XXX
 *   - Refunds:           re_XXX
 *   - Payment methods:   pm_XXX
 *   - Sources:           src_XXX
 *   - Methods:           .create(), .retrieve(), .update(), .list(), .del(),
 *                        .confirm(), .cancel(), .capture(), .pay()
 *   - Resources:         stripe.customers / stripe.charges / stripe.subscriptions
 *
 * Public API:
 *   extractStripe(text)             → { entries, totals, total }
 *   buildStripeForFiles(files)      → { perFile, aggregate, totals }
 *   renderStripeBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const ID_PREFIXES = {
  cus: 'customer',
  pi: 'paymentIntent',
  ch: 'charge',
  in: 'invoice',
  sub: 'subscription',
  prod: 'product',
  price: 'price',
  seti: 'setupIntent',
  re: 'refund',
  pm: 'paymentMethod',
  src: 'source',
  tok: 'token',
  acct: 'account',
  ba: 'bankAccount',
  card: 'card',
  evt: 'event',
  txn: 'balanceTransaction',
  cs: 'checkoutSession',
  plan: 'plan',
  fee: 'applicationFee',
  fr: 'fileLink',
  file: 'file',
  payout: 'payout',
};
const PREFIX_GROUP = Object.keys(ID_PREFIXES).join('|');
const ID_RE = new RegExp(`\\b(${PREFIX_GROUP})_(test_)?([A-Za-z0-9]{14,40})\\b`, 'g');
const RESOURCE_RE = /\bstripe\.(customers|charges|paymentIntents|invoices|subscriptions|products|prices|setupIntents|refunds|paymentMethods|sources|tokens|accounts|events|balanceTransactions|checkout|plans|payouts|webhookEndpoints|files|reviews)\b/g;
const METHOD_RE = /\.(create|retrieve|update|list|del|delete|confirm|cancel|capture|pay|void|finalizeInvoice|markUncollectible|sendInvoice|attach|detach|search|listLineItems)\s*\(/g;
const WEBHOOK_EVENT_RE = /\b(charge\.succeeded|charge\.failed|payment_intent\.(?:succeeded|payment_failed|created)|customer\.(?:created|updated|deleted|subscription\.(?:created|updated|deleted)))\b/g;

function maskId(prefix, suffix) {
  if (suffix.length <= 8) return `${prefix}_${suffix}`;
  return `${prefix}_…${suffix.slice(-4)}`;
}

function extractStripe(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;

  if (!/\b(cus|pi|ch|in|sub|prod|price|seti|pm|cs|evt)_[a-zA-Z0-9]{8,}|stripe\./.test(body)) {
    return { entries: [], totals: {}, total: 0 };
  }

  const seen = new Set();
  const entries = [];
  const totals = {
    customer: 0, paymentIntent: 0, charge: 0, invoice: 0,
    subscription: 0, product: 0, price: 0, setupIntent: 0,
    refund: 0, paymentMethod: 0, source: 0, token: 0,
    account: 0, bankAccount: 0, card: 0, event: 0,
    balanceTransaction: 0, checkoutSession: 0, plan: 0,
    applicationFee: 0, fileLink: 0, file: 0, payout: 0,
    resource: 0, method: 0, webhookEvent: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  ID_RE.lastIndex = 0;
  let m;
  while ((m = ID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const prefix = m[1];
    const objectType = ID_PREFIXES[prefix];
    if (!objectType) continue;
    const isTest = !!m[2];
    const suffix = m[3];
    const masked = maskId(prefix, suffix);
    push(objectType, masked, isTest ? 'test' : 'live');
  }
  if (entries.length < MAX_PER_FILE) {
    RESOURCE_RE.lastIndex = 0;
    while ((m = RESOURCE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('resource', `stripe.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    METHOD_RE.lastIndex = 0;
    while ((m = METHOD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('method', `.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    WEBHOOK_EVENT_RE.lastIndex = 0;
    while ((m = WEBHOOK_EVENT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('webhookEvent', m[1], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildStripeForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractStripe(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      totals[e.kind] = (totals[e.kind] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderStripeBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## STRIPE API OBJECTS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` (${e.detail})` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractStripe,
  buildStripeForFiles,
  renderStripeBlock,
  _internal: { maskId, ID_PREFIXES },
};
