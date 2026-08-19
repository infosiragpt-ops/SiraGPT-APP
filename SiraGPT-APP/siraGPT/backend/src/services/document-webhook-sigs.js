'use strict';

/**
 * document-webhook-sigs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects webhook signature verification patterns and provider-specific
 * signing schemes:
 *
 *   - Provider headers:
 *       Stripe:      Stripe-Signature
 *       GitHub:      X-Hub-Signature-256 / X-Hub-Signature
 *       Slack:       X-Slack-Signature / X-Slack-Request-Timestamp
 *       Twilio:      X-Twilio-Signature
 *       Square:      X-Square-Signature-HMAC-SHA256
 *       Shopify:     X-Shopify-Hmac-SHA256
 *       PayPal:      PAYPAL-AUTH-ALGO / PAYPAL-TRANSMISSION-SIG
 *       SendGrid:    X-Twilio-Email-Event-Webhook-Signature
 *       Mailgun:     X-Mailgun-Signature-V2
 *       Zoom:        X-Zm-Signature
 *       Cloudflare:  CF-Webhook-Auth
 *       Discord:     X-Signature-Ed25519
 *
 *   - Crypto primitives:
 *       crypto.createHmac('sha256', secret) / .update(body) / .digest('hex')
 *       crypto.timingSafeEqual(buf1, buf2)
 *       crypto.subtle.verify / sodium / nacl.sign.detached.verify
 *
 *   - Verifier functions:
 *       verifySignature / verifyWebhook / validateWebhook / constructEvent
 *       stripe.webhooks.constructEvent / @octokit/webhooks
 *
 * Public API:
 *   extractWebhookSigs(text)             → { entries, totals, total }
 *   buildWebhookSigsForFiles(files)      → { perFile, aggregate, totals }
 *   renderWebhookSigsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 28;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const PROVIDER_HEADERS = {
  'Stripe-Signature': 'stripe',
  'X-Hub-Signature-256': 'github',
  'X-Hub-Signature': 'github',
  'X-Slack-Signature': 'slack',
  'X-Slack-Request-Timestamp': 'slack',
  'X-Twilio-Signature': 'twilio',
  'X-Twilio-Email-Event-Webhook-Signature': 'sendgrid',
  'X-Square-Signature-HMAC-SHA256': 'square',
  'X-Square-Hmacsha256-Signature': 'square',
  'X-Shopify-Hmac-SHA256': 'shopify',
  'X-Shopify-Hmac-Sha256': 'shopify',
  'PAYPAL-AUTH-ALGO': 'paypal',
  'PAYPAL-TRANSMISSION-SIG': 'paypal',
  'X-Mailgun-Signature-V2': 'mailgun',
  'X-Zm-Signature': 'zoom',
  'CF-Webhook-Auth': 'cloudflare',
  'X-Signature-Ed25519': 'discord',
  'X-Signature-Timestamp': 'discord',
  'X-Razorpay-Signature': 'razorpay',
  'Svix-Signature': 'svix',
  'Webhook-Signature': 'generic',
  'X-Webhook-Signature': 'generic',
};

const HEADER_RE = new RegExp(
  '\\b(' + Object.keys(PROVIDER_HEADERS).map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
  'gi'
);
const HMAC_CREATE_RE = /\bcrypto\.createHmac\s*\(\s*["']([a-zA-Z0-9-]{3,30})["']/g;
const HMAC_UPDATE_RE = /\.update\s*\([^)]{1,80}\)\s*\.digest\s*\(\s*["']([a-zA-Z0-9]{3,12})["']/g;
const TIMING_SAFE_RE = /\bcrypto\.timingSafeEqual\s*\(/g;
const VERIFIER_FN_RE = /\b(verifyWebhook|verifySignature|validateWebhook|verifyEvent|verifyDeliverySignature|constructEvent|verifySlackRequest|verifyRequest)\s*\(/g;
const STRIPE_CONSTRUCT_RE = /\bstripe\.webhooks\.constructEvent\s*\(/g;
const OCTOKIT_RE = /\b(?:Octokit|Webhooks)\s*\(\s*\{[^}]{0,200}secret/g;
const NACL_RE = /\bnacl\.sign\.detached\.verify\s*\(/g;
const SUBTLE_VERIFY_RE = /\bcrypto\.subtle\.verify\s*\(/g;

function isWebhookSigLike(body) {
  return /\b(?:Stripe-Signature|X-Hub-Signature|X-Slack-Signature|X-Twilio-Signature|X-Shopify-Hmac|X-Webhook-Signature|Webhook-Signature|Svix-Signature)\b|\bcrypto\.createHmac\s*\(|\bstripe\.webhooks\.constructEvent|\btimingSafeEqual\b|\bverifyWebhook\s*\(|\bverifySignature\s*\(/i.test(body);
}

function extractWebhookSigs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isWebhookSigLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    header: 0, provider: 0, hmacAlgo: 0, digestEncoding: 0,
    timingSafe: 0, verifierFn: 0, providerSdk: 0, edSig: 0, subtleVerify: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  HEADER_RE.lastIndex = 0;
  let m;
  const providersSeen = new Set();
  while ((m = HEADER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    // Canonicalize header lookup case-insensitive
    const headerKey = Object.keys(PROVIDER_HEADERS).find((k) => k.toLowerCase() === m[1].toLowerCase());
    if (!headerKey) continue;
    const provider = PROVIDER_HEADERS[headerKey];
    push('header', headerKey, provider);
    if (!providersSeen.has(provider)) {
      providersSeen.add(provider);
      if (entries.length < MAX_PER_FILE) {
        entries.push({ kind: 'provider', name: provider, detail: null });
        totals.provider += 1;
      }
    }
  }
  if (entries.length < MAX_PER_FILE) {
    HMAC_CREATE_RE.lastIndex = 0;
    while ((m = HMAC_CREATE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('hmacAlgo', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    HMAC_UPDATE_RE.lastIndex = 0;
    while ((m = HMAC_UPDATE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('digestEncoding', m[1], null);
    }
  }

  let timingCount = 0;
  TIMING_SAFE_RE.lastIndex = 0;
  while (TIMING_SAFE_RE.exec(body) && timingCount < 10) timingCount += 1;
  totals.timingSafe = timingCount;
  if (timingCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'timingSafe', name: 'crypto.timingSafeEqual', detail: `${timingCount}` });
  }

  if (entries.length < MAX_PER_FILE) {
    VERIFIER_FN_RE.lastIndex = 0;
    while ((m = VERIFIER_FN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('verifierFn', m[1], null);
    }
  }

  let stripeConstructCount = 0;
  STRIPE_CONSTRUCT_RE.lastIndex = 0;
  while (STRIPE_CONSTRUCT_RE.exec(body) && stripeConstructCount < 10) stripeConstructCount += 1;
  if (stripeConstructCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'providerSdk', name: 'stripe.webhooks.constructEvent', detail: `${stripeConstructCount}` });
    totals.providerSdk += 1;
  }
  let octokitCount = 0;
  OCTOKIT_RE.lastIndex = 0;
  while (OCTOKIT_RE.exec(body) && octokitCount < 5) octokitCount += 1;
  if (octokitCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'providerSdk', name: 'Octokit Webhooks', detail: `${octokitCount}` });
    totals.providerSdk += 1;
  }

  let naclCount = 0;
  NACL_RE.lastIndex = 0;
  while (NACL_RE.exec(body) && naclCount < 5) naclCount += 1;
  totals.edSig = naclCount;
  if (naclCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'edSig', name: 'nacl.sign.detached.verify', detail: `${naclCount}` });
  }

  let subtleCount = 0;
  SUBTLE_VERIFY_RE.lastIndex = 0;
  while (SUBTLE_VERIFY_RE.exec(body) && subtleCount < 5) subtleCount += 1;
  totals.subtleVerify = subtleCount;
  if (subtleCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'subtleVerify', name: 'crypto.subtle.verify', detail: `${subtleCount}` });
  }

  return { entries, totals, total: entries.length };
}

function buildWebhookSigsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    header: 0, provider: 0, hmacAlgo: 0, digestEncoding: 0,
    timingSafe: 0, verifierFn: 0, providerSdk: 0, edSig: 0, subtleVerify: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractWebhookSigs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
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

function renderWebhookSigsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## WEBHOOK SIGNATURE VERIFICATION'];
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
  extractWebhookSigs,
  buildWebhookSigsForFiles,
  renderWebhookSigsBlock,
  _internal: { isWebhookSigLike, PROVIDER_HEADERS },
};
