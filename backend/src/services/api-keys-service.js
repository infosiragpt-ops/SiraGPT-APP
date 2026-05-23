'use strict';

/**
 * api-keys-service — pure helpers for the ApiKey model (ratchet 45).
 *
 * Bearer tokens are emitted as `sk_<prefix><secret>`:
 *   - `sk_` is the scheme tag the auth middleware uses to choose the
 *     API-key path over JWT.
 *   - `<prefix>` is 8 url-safe chars; stored in plaintext on the row
 *     so the UI can render a redacted hint like "sk_abcd1234…". The
 *     middleware looks up rows by `prefix` (indexed) before verifying
 *     the hash, which keeps the hot path to one DB seek.
 *   - `<secret>` is 32 random url-safe chars. Combined with the
 *     prefix it gives ~240 bits of entropy. We store only
 *     `sha256(prefix + secret)` (`tokenHash`); the plaintext is
 *     returned exactly once at creation.
 *
 * Exports:
 *   - TOKEN_SCHEME / PREFIX_LEN / SECRET_LEN
 *   - generateToken()   → { token, prefix, secret, tokenHash }
 *   - hashToken(token)  → sha256 hex of the body (after sk_)
 *   - parseToken(raw)   → { prefix, body } | null
 *   - redactKey(row)    → safe shape for list responses
 *   - presentNewKey(row, token) → creation response (token shown ONCE)
 *   - isExpired(row, now?)
 */

const crypto = require('crypto');

const TOKEN_SCHEME = 'sk_';
const PREFIX_LEN = 8;
const SECRET_LEN = 32;
const BODY_LEN = PREFIX_LEN + SECRET_LEN;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

// Use a url-safe base62 alphabet so tokens copy cleanly in shells and
// curl examples without needing quoting. crypto.randomBytes →
// 0..255 → mapped into the alphabet via rejection sampling for an
// unbiased distribution.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomString(len) {
  if (!Number.isInteger(len) || len <= 0) throw new Error('len must be a positive integer');
  const out = [];
  // Pull a few extra bytes per pass to amortise the syscall.
  while (out.length < len) {
    const buf = crypto.randomBytes(len * 2);
    for (let i = 0; i < buf.length && out.length < len; i++) {
      const b = buf[i];
      // Reject the upper tail so the modulo is unbiased
      // (256 % 62 == 8 ⇒ reject the top 8 byte values).
      if (b >= 248) continue;
      out.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return out.join('');
}

function hashToken(body) {
  if (typeof body !== 'string' || !body) throw new Error('body required');
  return crypto.createHash('sha256').update(body).digest('hex');
}

function compareTokenHash(a, b) {
  if (!SHA256_HEX_RE.test(String(a || '')) || !SHA256_HEX_RE.test(String(b || ''))) {
    return false;
  }
  const ab = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function generateToken() {
  const prefix = randomString(PREFIX_LEN);
  const secret = randomString(SECRET_LEN);
  const body = `${prefix}${secret}`;
  const tokenHash = hashToken(body);
  return {
    token: `${TOKEN_SCHEME}${body}`,
    prefix,
    secret,
    tokenHash,
  };
}

/**
 * Parse a raw Authorization value (the part after "Bearer ") into the
 * scheme prefix and the body. Returns null when the value doesn't
 * use our token scheme.
 */
function parseToken(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (!raw.startsWith(TOKEN_SCHEME)) return null;
  const body = raw.slice(TOKEN_SCHEME.length);
  if (body.length !== BODY_LEN) return null;
  const prefix = body.slice(0, PREFIX_LEN);
  // Cheap structural sanity check — reject anything that smells like
  // a JWT (contains `.`) or whitespace; lets the middleware skip the
  // DB lookup on obviously malformed inputs.
  if (/[\s.]/.test(body)) return null;
  return { prefix, body };
}

function hasTokenScheme(raw) {
  return typeof raw === 'string' && raw.startsWith(TOKEN_SCHEME);
}

function isExpired(row, now) {
  if (!row || !row.expiresAt) return false;
  const t = now instanceof Date ? now.getTime() : Date.now();
  const exp = row.expiresAt instanceof Date ? row.expiresAt.getTime() : new Date(row.expiresAt).getTime();
  return Number.isFinite(exp) && exp <= t;
}

/**
 * Convert a row into the redacted shape the list endpoint returns.
 * Never includes `tokenHash`; only the prefix is displayed so the UI
 * can hint "sk_abcd1234…" alongside the human-chosen name.
 */
function redactKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    redacted: `${TOKEN_SCHEME}${row.prefix}${'•'.repeat(8)}`,
    scopes: Array.isArray(row.scopes) ? [...row.scopes] : [],
    organizationId: row.organizationId || null,
    userId: row.userId,
    lastUsedAt: row.lastUsedAt instanceof Date ? row.lastUsedAt.toISOString() : row.lastUsedAt || null,
    expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt || null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

/**
 * Creation response — the ONLY time the full plaintext token is
 * disclosed. Callers must show it to the user and then drop it.
 */
function presentNewKey(row, token) {
  return {
    ...redactKey(row),
    token,
    warning: 'Store this token securely — it will not be shown again.',
  };
}

module.exports = {
  TOKEN_SCHEME,
  PREFIX_LEN,
  SECRET_LEN,
  BODY_LEN,
  generateToken,
  hashToken,
  compareTokenHash,
  parseToken,
  hasTokenScheme,
  isExpired,
  redactKey,
  presentNewKey,
};
