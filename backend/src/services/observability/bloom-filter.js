'use strict';

/**
 * bloom-filter — probabilistic set membership. Pairs with HyperLogLog
 * (#30, distinct count) and Count-Min sketch (#32, frequency): HLL
 * answers "how many distinct", CMS "how often each", Bloom answers
 * "have we seen *this exact one* before". Use cases: dedup of
 * already-processed prompt hashes, request-id replay protection,
 * cheap pre-check before hitting a slower exact-membership store.
 *
 * Sizing rule (per Bloom 1970):
 *   m = -(n * ln p) / (ln 2)²       — bits required for n items, false-positive p
 *   k = (m / n) * ln 2               — optimal hash count
 *
 * Public API:
 *   const bf = createBloomFilter({ size, hashes, expectedItems, falsePositive })
 *     pass either {size, hashes} directly OR {expectedItems, falsePositive}.
 *   bf.add(value)
 *   bf.has(value)              → boolean (false negative impossible; FP rate=p)
 *   bf.merge(other)            → union (must match size+hashes)
 *   bf.snapshot()              → { size, hashes, bitsSet, fillRatio,
 *                                   estimatedItems, estimatedFalsePositive }
 *   bf.reset()
 */

const { createHash } = require('node:crypto');

const DEFAULT_SIZE = 8192;        // bits
const DEFAULT_HASHES = 4;
const DEFAULT_FP = 0.01;

function sizeForExpected(expectedItems, falsePositive) {
  const n = Math.max(1, expectedItems);
  const p = Math.min(0.5, Math.max(1e-9, falsePositive));
  const m = Math.ceil(-(n * Math.log(p)) / (Math.LN2 * Math.LN2));
  return Math.max(8, m);
}

function hashesForOptimal(size, expectedItems) {
  const k = Math.round((size / Math.max(1, expectedItems)) * Math.LN2);
  return Math.max(1, Math.min(16, k));
}

function indicesFor(value, size, hashes) {
  // Two SHA-256 derived 32-bit words → k indices via double-hashing
  // (Kirsch & Mitzenmacher 2006). Cheap, well-distributed.
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  const buf = createHash('sha256').update(str).digest();
  const h1 = buf.readUInt32BE(0);
  const h2 = buf.readUInt32BE(4);
  const out = new Array(hashes);
  for (let i = 0; i < hashes; i++) out[i] = ((h1 + i * h2) >>> 0) % size;
  return out;
}

function createBloomFilter(opts = {}) {
  let size, hashes;
  if (Number.isFinite(opts.size) && opts.size >= 8 && Number.isFinite(opts.hashes) && opts.hashes >= 1) {
    size = Math.floor(opts.size);
    hashes = Math.floor(opts.hashes);
  } else {
    const n = Number.isFinite(opts.expectedItems) && opts.expectedItems > 0 ? opts.expectedItems : 1024;
    const p = Number.isFinite(opts.falsePositive) && opts.falsePositive > 0 ? opts.falsePositive : DEFAULT_FP;
    size = opts.size || sizeForExpected(n, p);
    hashes = opts.hashes || hashesForOptimal(size, n);
  }
  const bits = new Uint8Array(Math.ceil(size / 8));
  let totalAdds = 0;

  function setBit(idx) {
    bits[idx >>> 3] |= 1 << (idx & 7);
  }
  function getBit(idx) {
    return (bits[idx >>> 3] >>> (idx & 7)) & 1;
  }

  function add(value) {
    if (value == null) return;
    const idx = indicesFor(value, size, hashes);
    for (const i of idx) setBit(i);
    totalAdds += 1;
  }

  function has(value) {
    if (value == null) return false;
    const idx = indicesFor(value, size, hashes);
    for (const i of idx) if (!getBit(i)) return false;
    return true;
  }

  function bitsSet() {
    let n = 0;
    for (let i = 0; i < bits.length; i++) {
      let v = bits[i];
      while (v) { v &= (v - 1); n += 1; }
    }
    return n;
  }

  function snapshot() {
    const set = bitsSet();
    const ratio = set / size;
    // n̂ = -(m / k) * ln(1 - X / m)   estimated cardinality
    const n = ratio === 0
      ? 0
      : ratio >= 1 ? Infinity
      : Math.round((-size / hashes) * Math.log(1 - ratio));
    // p̂ = (1 - e^(-k * n̂ / m))^k
    const p = Math.pow(1 - Math.exp(-hashes * (n || 0) / size), hashes);
    return {
      size,
      hashes,
      bitsSet: set,
      fillRatio: ratio,
      estimatedItems: n,
      estimatedFalsePositive: p,
      totalAdds,
    };
  }

  function merge(other) {
    if (!other || typeof other.snapshot !== 'function') {
      throw new TypeError('bloom.merge: another BloomFilter required');
    }
    const snap = other.snapshot();
    if (snap.size !== size || snap.hashes !== hashes) {
      throw new TypeError(`bloom.merge: dimension mismatch (size ${size} vs ${snap.size}, hashes ${hashes} vs ${snap.hashes})`);
    }
    if (typeof other._bytes !== 'function') {
      throw new TypeError('bloom.merge: peer must expose _bytes() helper');
    }
    const peerBits = other._bytes();
    for (let i = 0; i < bits.length; i++) bits[i] |= peerBits[i];
  }

  function reset() {
    bits.fill(0);
    totalAdds = 0;
  }

  return { add, has, snapshot, merge, reset, _bytes: () => Uint8Array.from(bits) };
}

module.exports = {
  createBloomFilter,
  sizeForExpected,
  hashesForOptimal,
  DEFAULT_SIZE,
  DEFAULT_HASHES,
  DEFAULT_FP,
};
