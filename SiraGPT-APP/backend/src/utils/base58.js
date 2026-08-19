'use strict';

/**
 * base58 — Bitcoin-style base58 codec.
 *
 * The alphabet drops 0/O/I/l so a code dictated over the phone or
 * embedded in a URL never has the "is that a one or an ell?" problem
 * that base32/base64 inherit. We reach for it for human-shareable
 * resource IDs (invite codes, short trace IDs) — base64url is fine
 * for opaque tokens but unfriendly when a human has to type it.
 *
 * Implementation: bigint-driven so it handles arbitrary-length input
 * without the off-by-one errors that plague divmod-on-byte-array
 * implementations. Leading zero bytes encode as leading '1' chars
 * (Bitcoin convention) so round-trip preserves byte-length.
 *
 * Public API:
 *   encode(buffer) → string
 *   decode(string) → Buffer
 *   isValid(string) → boolean
 *   ALPHABET (constant)
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE = BigInt(58);

const INDEX = new Map();
for (let i = 0; i < ALPHABET.length; i++) INDEX.set(ALPHABET[i], i);

function encode(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('base58: encode expects a Buffer');
  }
  if (buffer.length === 0) return '';

  // Count leading zero bytes — they map to leading '1' chars.
  let leadingZeros = 0;
  while (leadingZeros < buffer.length && buffer[leadingZeros] === 0) leadingZeros++;

  // Convert remaining bytes to bigint.
  let n = 0n;
  for (let i = 0; i < buffer.length; i++) {
    n = (n << 8n) + BigInt(buffer[i]);
  }

  let out = '';
  while (n > 0n) {
    const r = Number(n % BASE);
    n = n / BASE;
    out = ALPHABET[r] + out;
  }

  return ALPHABET[0].repeat(leadingZeros) + out;
}

function decode(str) {
  if (typeof str !== 'string') {
    throw new TypeError('base58: decode expects a string');
  }
  if (str.length === 0) return Buffer.alloc(0);

  let leadingOnes = 0;
  while (leadingOnes < str.length && str[leadingOnes] === ALPHABET[0]) leadingOnes++;

  let n = 0n;
  for (let i = 0; i < str.length; i++) {
    const idx = INDEX.get(str[i]);
    if (idx === undefined) {
      throw new TypeError(`base58: invalid character "${str[i]}" at index ${i}`);
    }
    n = n * BASE + BigInt(idx);
  }

  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Buffer.concat([Buffer.alloc(leadingOnes, 0), Buffer.from(bytes)]);
}

function isValid(str) {
  if (typeof str !== 'string') return false;
  for (let i = 0; i < str.length; i++) {
    if (!INDEX.has(str[i])) return false;
  }
  return true;
}

module.exports = {
  encode,
  decode,
  isValid,
  ALPHABET,
};
