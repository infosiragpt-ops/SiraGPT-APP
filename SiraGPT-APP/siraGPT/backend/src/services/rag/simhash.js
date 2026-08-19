'use strict';

/**
 * simhash — 64-bit SimHash (Charikar 2002) for near-duplicate
 * detection. Pairs with Bloom (#40, exact match) and cosine
 * similarity (#29, semantic): SimHash sits in between, catching
 * "same paragraph with one word changed" cheaply (≤ a few hundred
 * Hamming-distance comparisons per query) before we burn embeddings
 * on it.
 *
 * Algorithm (per the paper):
 *   1. Tokenize the input into shingles/words with weights.
 *   2. For each shingle, compute a 64-bit feature hash (we use the
 *      first 8 bytes of sha256).
 *   3. For each of the 64 bits: add `weight` if the bit is 1, subtract
 *      it if 0, into an accumulator vector V.
 *   4. The fingerprint bit i is sign(V[i]).
 *
 * Similarity = 1 - (hammingDistance / 64). Two documents at Hamming
 * distance ≤ 3 are typically near-duplicates of each other.
 *
 * Public API:
 *   simhash(text, { tokenize?, shingleSize? })   → bigint (64 bits)
 *   hammingDistance(aBig, bBig)                  → 0..64
 *   similarity(aBig, bBig)                       → 0..1
 *   tokenizeWords(text)                          — default tokenizer
 *   tokenizeShingles(text, n=3)                  — char-n-gram option
 */

const { createHash } = require('node:crypto');

function tokenizeWords(text) {
  if (typeof text !== 'string' || !text) return [];
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t);
}

function tokenizeShingles(text, n = 3) {
  if (typeof text !== 'string' || !text) return [];
  const t = text.toLowerCase();
  if (t.length < n) return [t];
  const out = [];
  for (let i = 0; i + n <= t.length; i++) out.push(t.slice(i, i + n));
  return out;
}

function feature64(token) {
  const h = createHash('sha256').update(String(token)).digest();
  // Build a BigInt from the first 8 bytes of the hash.
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(h[i]);
  return v;
}

function simhash(text, opts = {}) {
  const tokenize = typeof opts.tokenize === 'function'
    ? opts.tokenize
    : (txt) => tokenizeWords(txt);
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0n;

  // Weight = term frequency. Sum vector across 64 bit positions.
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

  const accum = new Array(64).fill(0);
  for (const [token, weight] of tf) {
    const h = feature64(token);
    for (let i = 0; i < 64; i++) {
      const bit = (h >> BigInt(i)) & 1n;
      accum[i] += bit === 1n ? weight : -weight;
    }
  }
  let fp = 0n;
  for (let i = 0; i < 64; i++) if (accum[i] > 0) fp |= (1n << BigInt(i));
  return fp;
}

function hammingDistance(a, b) {
  if (typeof a !== 'bigint' || typeof b !== 'bigint') {
    throw new TypeError('hammingDistance: both args must be bigint');
  }
  let x = a ^ b;
  let count = 0;
  while (x) {
    x &= x - 1n;
    count += 1;
  }
  return count;
}

function similarity(a, b) {
  return 1 - hammingDistance(a, b) / 64;
}

module.exports = {
  simhash,
  hammingDistance,
  similarity,
  tokenizeWords,
  tokenizeShingles,
  feature64,
};
