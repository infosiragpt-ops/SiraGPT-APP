'use strict';

/**
 * signed-url — HMAC-signed URLs with expiry and optional nonce.
 * Pairs with the HMAC webhook helper (#48) — both layer signatures
 * over a payload + timestamp, but webhooks sign a *body* with header
 * metadata, while this signs *the URL itself* with query metadata
 * (so the link can travel as a single string).
 *
 * Query parameters added to the URL by sign():
 *   ?exp=<unixSec>            absolute expiry, after which verify denies
 *   &nonce=<rand>             optional anti-replay (8-byte hex)
 *   &sig=<hexHmac>            HMAC-SHA256 over canonical("path?query-without-sig")
 *
 * verify() recomputes the HMAC, timing-safe compares, then checks
 * the exp claim against `now`. Reasons returned: 'expired',
 * 'malformed', 'signature_mismatch'.
 *
 * Public API:
 *   const u = createSignedUrlSigner({ secret, defaultTtlSec, now })
 *   u.sign(url, { ttlSec?, nonce? })   → string  (url with sig added)
 *   u.verify(url)                      → { ok } | { ok:false, reason }
 *
 * The signer accepts URLs as either string or URL instance and
 * preserves the rest of the query string verbatim.
 */

const { createHmac, timingSafeEqual, randomBytes } = require('node:crypto');

const DEFAULT_TTL_SEC = 300;

function hmacHex(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); }
  catch { return false; }
}

/**
 * Build the canonical string to sign: path + sorted-query (excluding
 * the `sig` param). Hostname/scheme are intentionally excluded so a
 * link signed by us can be verified by us regardless of which load
 * balancer / cdn served it.
 */
function canonicalize(urlObj) {
  const params = [...urlObj.searchParams.entries()].filter(([k]) => k !== 'sig');
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return urlObj.pathname + (query ? `?${query}` : '');
}

function createSignedUrlSigner(opts = {}) {
  if (typeof opts.secret !== 'string' || !opts.secret) {
    throw new TypeError('signed-url: secret required');
  }
  const secret = opts.secret;
  const defaultTtlSec = Number.isFinite(opts.defaultTtlSec) && opts.defaultTtlSec > 0
    ? Math.floor(opts.defaultTtlSec)
    : DEFAULT_TTL_SEC;
  const now = typeof opts.now === 'function' ? opts.now : () => Math.floor(Date.now() / 1000);

  function toUrl(input) {
    if (input instanceof URL) return new URL(input.toString());
    if (typeof input !== 'string' || !input) throw new TypeError('signed-url: url required');
    // Tolerate path-only inputs by giving them a placeholder origin.
    if (input.startsWith('/')) return new URL(input, 'http://placeholder');
    return new URL(input);
  }

  function sign(url, { ttlSec, nonce } = {}) {
    const u = toUrl(url);
    const exp = now() + (Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec) : defaultTtlSec);
    u.searchParams.set('exp', String(exp));
    if (nonce !== false) {
      const n = typeof nonce === 'string' && nonce ? nonce : randomBytes(8).toString('hex');
      u.searchParams.set('nonce', n);
    }
    const sig = hmacHex(secret, canonicalize(u));
    u.searchParams.set('sig', sig);
    // Preserve user-style URLs: if input was path-only we strip our
    // placeholder origin on the way out.
    const out = u.toString();
    if (typeof url === 'string' && url.startsWith('/')) return out.slice('http://placeholder'.length);
    return out;
  }

  function verify(url) {
    let u;
    try { u = toUrl(url); }
    catch { return { ok: false, reason: 'malformed' }; }

    const sig = u.searchParams.get('sig');
    const expRaw = u.searchParams.get('exp');
    if (!sig || !expRaw) return { ok: false, reason: 'malformed' };
    const expected = hmacHex(secret, canonicalize(u));
    if (!safeEqualHex(expected, sig)) return { ok: false, reason: 'signature_mismatch' };
    const exp = Number(expRaw);
    if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed' };
    if (now() > exp) return { ok: false, reason: 'expired', exp };
    return { ok: true, exp };
  }

  return { sign, verify, canonicalize: (input) => canonicalize(toUrl(input)) };
}

module.exports = {
  createSignedUrlSigner,
  hmacHex,
  safeEqualHex,
  DEFAULT_TTL_SEC,
};
