'use strict';

/**
 * base64url — RFC 4648 §5 URL-safe base64. Different from Node's
 * default base64 in three places:
 *   - '+' → '-'
 *   - '/' → '_'
 *   - '=' padding stripped (callers can opt in via { pad: true })
 *
 * Pairs with the signed-URL helper (#70), HMAC webhook (#48), and
 * canonical-json (#50): when you need to ship arbitrary bytes inside
 * a URL or HTTP header, this is the canonical encoding.
 *
 * Public API:
 *   encode(input, { pad? })         input: string | Buffer | Uint8Array
 *   decode(str, { encoding? })      → Buffer (default) or string when
 *                                      encoding is 'utf8'
 *   encodeJson(value, { pad? })     → base64url(canonical bytes of JSON)
 *   decodeJson(str)                 → parsed JSON
 *   isBase64Url(str)                → boolean
 */

const RE_PAD = /=+$/g;

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (input == null) return Buffer.alloc(0);
  throw new TypeError('base64url: input must be string | Buffer | Uint8Array');
}

function encode(input, { pad = false } = {}) {
  const buf = toBuffer(input);
  let s = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  if (!pad) s = s.replace(RE_PAD, '');
  return s;
}

function decode(str, { encoding = null } = {}) {
  if (typeof str !== 'string') throw new TypeError('base64url.decode: string required');
  // Restore standard base64 alphabet + add missing padding.
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  const padCount = (4 - (s.length % 4)) % 4;
  if (padCount > 0) s += '='.repeat(padCount);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new TypeError('base64url.decode: malformed input');
  const buf = Buffer.from(s, 'base64');
  return encoding ? buf.toString(encoding) : buf;
}

function encodeJson(value, opts) {
  return encode(JSON.stringify(value), opts);
}

function decodeJson(str) {
  const txt = decode(str, { encoding: 'utf8' });
  return JSON.parse(txt);
}

function isBase64Url(str) {
  if (typeof str !== 'string' || !str) return false;
  return /^[A-Za-z0-9_-]+(={0,2})?$/.test(str);
}

module.exports = {
  encode,
  decode,
  encodeJson,
  decodeJson,
  isBase64Url,
};
