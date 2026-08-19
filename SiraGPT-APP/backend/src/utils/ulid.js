'use strict';

/**
 * ulid — Universally Unique Lexicographically Sortable Identifier.
 * 26-character Crockford-base32 string: 10 chars of millisecond
 * timestamp (sortable) + 16 chars of randomness. Pairs with the
 * structured logger (#43, request-id binding), trace context (#20,
 * spanId), and audit log (#14, requestId).
 *
 * Spec: https://github.com/ulid/spec
 *
 * Why ULID over UUIDv4:
 *   - Lexicographically sortable by creation time (great for keys
 *     in BTree / DynamoDB / Cassandra).
 *   - Same 128 bits of entropy as a UUID without dashes.
 *   - Monotonic mode (default in this module) guarantees IDs created
 *     within the same millisecond are also strictly increasing.
 *
 * Public API:
 *   const gen = createUlidGenerator({ rng?, now? })
 *   gen.next()                  → 26-char ULID string
 *   gen.fromTimestamp(ms)       → ULID for that ms
 *   ulid()                      → convenience for default generator
 *   decodeTimestamp(ulidStr)    → ms epoch | null on bad input
 *   isValid(ulidStr)            → boolean
 */

const { randomBytes } = require('node:crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ALPHABET_LEN = 32n;
const TIME_LEN = 10;
const RAND_LEN = 16;
const TOTAL_LEN = TIME_LEN + RAND_LEN;
const MAX_TIME = (1n << 48n) - 1n;
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeFixed(intValue, length) {
  let n = typeof intValue === 'bigint' ? intValue : BigInt(intValue);
  const out = new Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = ALPHABET[Number(n % ALPHABET_LEN)];
    n /= ALPHABET_LEN;
  }
  return out.join('');
}

function randomBigInt(bits, rng) {
  const bytes = Math.ceil(bits / 8);
  const arr = rng(bytes);
  let n = 0n;
  for (let i = 0; i < arr.length; i++) n = (n << 8n) | BigInt(arr[i]);
  // Mask off any extra bits at the top.
  const overshoot = bytes * 8 - bits;
  if (overshoot > 0) n >>= BigInt(overshoot);
  return n;
}

function defaultRng(n) {
  return randomBytes(n);
}

function createUlidGenerator(opts = {}) {
  const rng = typeof opts.rng === 'function' ? opts.rng : defaultRng;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  let lastMs = -1n;
  let lastRand = 0n;

  function fromTimestamp(ms) {
    let t = typeof ms === 'bigint' ? ms : BigInt(Math.floor(ms));
    if (t < 0n) throw new RangeError('ulid: timestamp must be >= 0');
    if (t > MAX_TIME) throw new RangeError('ulid: timestamp exceeds 2^48 ms');
    const r = randomBigInt(80, rng);
    return encodeFixed(t, TIME_LEN) + encodeFixed(r, RAND_LEN);
  }

  function next() {
    const ms = BigInt(Math.floor(now()));
    let r;
    if (ms === lastMs) {
      // Same-ms call → bump last random monotonically.
      r = lastRand + 1n;
      // If we wrapped past 2^80, advance ms by 1 (extremely rare).
      if (r >= (1n << 80n)) {
        const nextMs = ms + 1n;
        return _emit(nextMs, randomBigInt(80, rng));
      }
    } else {
      r = randomBigInt(80, rng);
    }
    return _emit(ms, r);
  }

  function _emit(ms, r) {
    lastMs = ms;
    lastRand = r;
    return encodeFixed(ms, TIME_LEN) + encodeFixed(r, RAND_LEN);
  }

  return { next, fromTimestamp };
}

const _default = createUlidGenerator();
function ulid() { return _default.next(); }

function decodeTimestamp(s) {
  if (typeof s !== 'string' || s.length !== TOTAL_LEN || !ULID_REGEX.test(s)) return null;
  const head = s.slice(0, TIME_LEN);
  let n = 0n;
  for (const ch of head) {
    const v = ALPHABET.indexOf(ch);
    if (v === -1) return null;
    n = n * ALPHABET_LEN + BigInt(v);
  }
  return Number(n);
}

function isValid(s) {
  return typeof s === 'string' && s.length === TOTAL_LEN && ULID_REGEX.test(s);
}

module.exports = {
  createUlidGenerator,
  ulid,
  decodeTimestamp,
  isValid,
  ALPHABET,
  TIME_LEN,
  RAND_LEN,
  TOTAL_LEN,
};
