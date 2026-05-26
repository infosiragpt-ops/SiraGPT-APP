'use strict';

/**
 * hmac-webhook — HMAC-SHA256 sign + verify with timing-safe equal,
 * timestamp window enforcement, and a nonce-replay LRU. Standard
 * shape for receiving webhooks from third-parties (or signing
 * callbacks we send out).
 *
 * Signature format (canonical):
 *   v1=<hex>      — primary header value
 *   ts=<unixSec>  — timestamp header
 *   nonce=<rand>  — optional anti-replay token (defaults to ts only)
 *
 * The signed string is `${ts}.${nonce}.${rawBody}`. ts being part of
 * the signed string defeats "replay across time" attacks; nonce
 * defeats "replay within the same second"; the LRU defeats burst
 * replay against the same nonce.
 *
 * Public API:
 *   const w = createWebhookVerifier({
 *     secret,                     // string; required
 *     toleranceSec = 300,         // ±5min by default
 *     nonceCacheSize = 10_000,
 *     now,                        // clock injector (unix seconds)
 *   })
 *   w.sign({ body, ts?, nonce? }) → { v1, ts, nonce, header }
 *   w.verify({ body, header })    → { ok: true } | { ok: false, reason }
 *   w.parseHeader(headerStr)      → { v1, ts, nonce } | null
 */

const { createHmac, timingSafeEqual, randomBytes } = require('node:crypto');

const DEFAULT_TOLERANCE_SEC = 300;
const DEFAULT_NONCE_CACHE = 10_000;

function hmacHex(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); }
  catch { return false; }
}

function parseHeader(header) {
  if (typeof header !== 'string' || !header) return null;
  const parts = header.split(',').map((s) => s.trim()).filter(Boolean);
  const out = { v1: null, ts: null, nonce: null };
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (k === 'v1') out.v1 = v;
    else if (k === 'ts') out.ts = Number(v);
    else if (k === 'nonce') out.nonce = v;
  }
  if (!out.v1 || !Number.isFinite(out.ts)) return null;
  return out;
}

function formatHeader({ v1, ts, nonce }) {
  const parts = [`v1=${v1}`, `ts=${ts}`];
  if (nonce) parts.push(`nonce=${nonce}`);
  return parts.join(',');
}

function createWebhookVerifier(opts = {}) {
  if (typeof opts.secret !== 'string' || !opts.secret) {
    throw new TypeError('hmac-webhook: secret required');
  }
  const secret = opts.secret;
  const toleranceSec = Number.isFinite(opts.toleranceSec) && opts.toleranceSec > 0
    ? Math.floor(opts.toleranceSec)
    : DEFAULT_TOLERANCE_SEC;
  const nonceCacheSize = Number.isInteger(opts.nonceCacheSize) && opts.nonceCacheSize > 0
    ? opts.nonceCacheSize
    : DEFAULT_NONCE_CACHE;
  const now = typeof opts.now === 'function' ? opts.now : () => Math.floor(Date.now() / 1000);

  // LRU of recently-seen nonces. Map iteration-order trick.
  const seenNonces = new Map();

  function rememberNonce(nonce) {
    if (!nonce) return;
    seenNonces.delete(nonce);
    seenNonces.set(nonce, now());
    while (seenNonces.size > nonceCacheSize) {
      const oldest = seenNonces.keys().next().value;
      seenNonces.delete(oldest);
    }
  }

  function sawNonce(nonce) {
    return nonce ? seenNonces.has(nonce) : false;
  }

  function sign({ body, ts, nonce } = {}) {
    if (typeof body !== 'string') throw new TypeError('hmac-webhook.sign: body string required');
    const t = Number.isFinite(ts) ? Math.floor(ts) : now();
    const n = nonce || randomBytes(8).toString('hex');
    const v1 = hmacHex(secret, `${t}.${n}.${body}`);
    return { v1, ts: t, nonce: n, header: formatHeader({ v1, ts: t, nonce: n }) };
  }

  function verify({ body, header } = {}) {
    if (typeof body !== 'string') return { ok: false, reason: 'body_required' };
    const parsed = parseHeader(header);
    if (!parsed) return { ok: false, reason: 'malformed_header' };
    const t = now();
    if (Math.abs(t - parsed.ts) > toleranceSec) {
      return { ok: false, reason: 'timestamp_out_of_window', delta: t - parsed.ts };
    }
    const expected = hmacHex(secret, `${parsed.ts}.${parsed.nonce || ''}.${body}`);
    if (!safeEqualHex(expected, parsed.v1)) {
      return { ok: false, reason: 'signature_mismatch' };
    }
    if (parsed.nonce && sawNonce(parsed.nonce)) {
      return { ok: false, reason: 'replay' };
    }
    if (parsed.nonce) rememberNonce(parsed.nonce);
    return { ok: true };
  }

  function snapshot() {
    return { toleranceSec, nonceCacheSize, seenNonces: seenNonces.size };
  }

  return { sign, verify, parseHeader, snapshot };
}

module.exports = {
  createWebhookVerifier,
  parseHeader,
  formatHeader,
  hmacHex,
  safeEqualHex,
  DEFAULT_TOLERANCE_SEC,
  DEFAULT_NONCE_CACHE,
};
