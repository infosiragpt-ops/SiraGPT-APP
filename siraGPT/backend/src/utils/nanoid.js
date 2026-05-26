'use strict';

/**
 * nanoid — short, URL-safe, collision-resistant random ID generator.
 * Pairs with ULID (#51) — both are random IDs, but ULID is sortable
 * + 26 chars; nanoid is shorter (default 21) and accepts a custom
 * alphabet, useful for human-friendly tokens or domain-specific IDs.
 *
 * Bias-free via rejection sampling: for any alphabet size we compute
 * the smallest power-of-two mask ≥ size and discard random bytes
 * that fall outside that range, so each character is drawn uniformly.
 *
 * Public API:
 *   nanoid(size = 21)                        → string
 *   customAlphabet(alphabet, size)           → factory fn
 *   ALPHABET_DEFAULT export
 */

const { randomBytes } = require('node:crypto');

const ALPHABET_DEFAULT = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

function makeFactory(alphabet, size) {
  if (typeof alphabet !== 'string' || alphabet.length === 0 || alphabet.length > 256) {
    throw new TypeError('nanoid: alphabet must be 1..256 chars');
  }
  if (!Number.isInteger(size) || size <= 0) {
    throw new TypeError('nanoid: size must be a positive integer');
  }
  // Smallest mask covering the alphabet length.
  const mask = (2 << (Math.log2(alphabet.length - 1) | 0)) - 1;
  // Step: how many random bytes to draw per call. 1.6× is the sweet
  // spot for typical alphabets — enough to fill `size` chars in one
  // round even when we discard ~half the bytes to avoid bias.
  const step = Math.max(1, Math.ceil((1.6 * mask * size) / alphabet.length));

  return function () {
    let id = '';
    while (true) {
      const bytes = randomBytes(step);
      for (let i = 0; i < step; i++) {
        const v = bytes[i] & mask;
        if (v < alphabet.length) {
          id += alphabet[v];
          if (id.length === size) return id;
        }
      }
    }
  };
}

const defaultGenerator = makeFactory(ALPHABET_DEFAULT, 21);

function nanoid(size = 21) {
  if (size === 21) return defaultGenerator();
  return makeFactory(ALPHABET_DEFAULT, size)();
}

function customAlphabet(alphabet, size) {
  return makeFactory(alphabet, size);
}

module.exports = {
  nanoid,
  customAlphabet,
  ALPHABET_DEFAULT,
};
