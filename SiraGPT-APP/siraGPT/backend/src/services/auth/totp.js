'use strict';

/**
 * totp — RFC 6238 Time-based One-Time Password generator + verifier.
 * Pairs with the password-hash module (#79) and JWT-HS256 (#80) to
 * round out a 2FA-capable auth toolkit. Compatible with Google
 * Authenticator / Authy by default (HMAC-SHA1, 6 digits, 30-second
 * step).
 *
 * Public API:
 *   generateTotp(secret, { algo, digits, step, t0, time })
 *     secret: Buffer | base32 string (Google Authenticator uses base32)
 *     → string  (zero-padded numeric code)
 *
 *   verifyTotp(code, secret, { window = 1, ...opts })
 *     → boolean (true if code matches within ±window steps)
 *
 *   randomSecret({ bytes = 20 }) → base32 string
 *   base32Encode(buf) / base32Decode(str)
 */

const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) throw new TypeError('base32Encode: Buffer required');
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let out = '';
  let bits = 0;
  let val = 0;
  for (const b of bytes) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHA[(val >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHA[(val << (5 - bits)) & 0x1f];
  return out;
}

function base32Decode(str) {
  if (typeof str !== 'string') throw new TypeError('base32Decode: string required');
  const cleaned = str.toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
  if (!cleaned) return Buffer.alloc(0);
  const out = [];
  let bits = 0;
  let val = 0;
  for (const ch of cleaned) {
    const idx = ALPHA.indexOf(ch);
    if (idx === -1) throw new TypeError(`base32Decode: invalid char "${ch}"`);
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function counterBuffer(counter) {
  // 8-byte big-endian counter for HOTP (RFC 4226).
  const buf = Buffer.alloc(8);
  let n = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return buf;
}

function hotp(secret, counter, { algo = 'sha1', digits = 6 } = {}) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  if (key.length === 0) throw new TypeError('totp: secret cannot be empty');
  const h = createHmac(algo, key).update(counterBuffer(counter)).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24)
    | ((h[offset + 1] & 0xff) << 16)
    | ((h[offset + 2] & 0xff) << 8)
    | (h[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(bin % mod).padStart(digits, '0');
}

function generateTotp(secret, opts = {}) {
  const time = Number.isFinite(opts.time) ? opts.time : Math.floor(Date.now() / 1000);
  const t0 = Number.isFinite(opts.t0) ? opts.t0 : 0;
  const step = Number.isFinite(opts.step) && opts.step > 0 ? opts.step : 30;
  const counter = Math.floor((time - t0) / step);
  return hotp(secret, counter, opts);
}

function verifyTotp(code, secret, opts = {}) {
  if (typeof code !== 'string' || !/^\d+$/.test(code)) return false;
  const window = Number.isInteger(opts.window) && opts.window >= 0 ? opts.window : 1;
  const time = Number.isFinite(opts.time) ? opts.time : Math.floor(Date.now() / 1000);
  const t0 = Number.isFinite(opts.t0) ? opts.t0 : 0;
  const step = Number.isFinite(opts.step) && opts.step > 0 ? opts.step : 30;
  const baseCounter = Math.floor((time - t0) / step);
  const codeBuf = Buffer.from(code, 'utf8');
  for (let drift = -window; drift <= window; drift++) {
    const candidate = hotp(secret, baseCounter + drift, opts);
    const candBuf = Buffer.from(candidate, 'utf8');
    if (candBuf.length !== codeBuf.length) continue;
    try { if (timingSafeEqual(candBuf, codeBuf)) return true; }
    catch { /* fall through */ }
  }
  return false;
}

function randomSecret({ bytes = 20 } = {}) {
  return base32Encode(randomBytes(bytes));
}

module.exports = {
  generateTotp,
  verifyTotp,
  hotp,
  randomSecret,
  base32Encode,
  base32Decode,
};
