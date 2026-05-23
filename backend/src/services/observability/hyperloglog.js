'use strict';

/**
 * hyperloglog — HLL cardinality estimator. Counts distinct values in
 * O(2^precision) memory (default precision=12 → 4096 registers ≈ 4KB)
 * with ~1.04 / sqrt(2^precision) standard error (~1.6% at p=12).
 *
 * Reference: Flajolet et al., "HyperLogLog: the analysis of a near-
 * optimal cardinality estimation algorithm", DMTCS 2007. We
 * implement the HLL++ small-range bias correction from Heule et al.
 * (linear counting when many registers are still zero).
 *
 * Pairs with p2-quantile (#28) and prompt-cache-metrics (#12): those
 * track magnitudes; this answers "how many distinct things" cheaply.
 *
 * Public API:
 *   const hll = createHyperLogLog({ precision = 12 })
 *   hll.add(value)                — value: string | number | object
 *   hll.count()                   — current cardinality estimate
 *   hll.merge(other)              — union with another HLL of same precision
 *   hll.snapshot()                — { precision, registers, count }
 *   hll.reset()
 *
 * Hash: 32-bit murmur3-style; sufficient quality for HLL register
 * indexing on populations up to ~10⁸.
 */

const DEFAULT_PRECISION = 12;
const MIN_PRECISION = 4;
const MAX_PRECISION = 16;

function murmur32(input, seed = 0) {
  // Simple MurmurHash3-x86-32 over a UTF-8 byte view of the input.
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  const buf = Buffer.from(str, 'utf8');
  let h1 = seed >>> 0;
  const c1 = 0xcc9e2d51, c2 = 0x1b873593;
  const len = buf.length;
  const blocks = Math.floor(len / 4);
  for (let i = 0; i < blocks; i++) {
    let k1 = buf.readUInt32LE(i * 4);
    k1 = Math.imul(k1, c1) >>> 0;
    k1 = ((k1 << 15) | (k1 >>> 17)) >>> 0;
    k1 = Math.imul(k1, c2) >>> 0;
    h1 = (h1 ^ k1) >>> 0;
    h1 = ((h1 << 13) | (h1 >>> 19)) >>> 0;
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }
  let k1 = 0;
  const tail = len & 3;
  if (tail >= 3) k1 ^= buf[blocks * 4 + 2] << 16;
  if (tail >= 2) k1 ^= buf[blocks * 4 + 1] << 8;
  if (tail >= 1) {
    k1 ^= buf[blocks * 4 + 0];
    k1 = Math.imul(k1, c1) >>> 0;
    k1 = ((k1 << 15) | (k1 >>> 17)) >>> 0;
    k1 = Math.imul(k1, c2) >>> 0;
    h1 = (h1 ^ k1) >>> 0;
  }
  h1 = (h1 ^ len) >>> 0;
  h1 = (h1 ^ (h1 >>> 16)) >>> 0;
  h1 = Math.imul(h1, 0x85ebca6b) >>> 0;
  h1 = (h1 ^ (h1 >>> 13)) >>> 0;
  h1 = Math.imul(h1, 0xc2b2ae35) >>> 0;
  h1 = (h1 ^ (h1 >>> 16)) >>> 0;
  return h1 >>> 0;
}

function alphaFor(m) {
  // Standard HLL bias-correction constants per registers count.
  if (m === 16) return 0.673;
  if (m === 32) return 0.697;
  if (m === 64) return 0.709;
  return 0.7213 / (1 + 1.079 / m);
}

function leadingZerosPlus1(value, bits) {
  if (value === 0) return bits + 1;
  let n = 1;
  let mask = 1 << (bits - 1);
  while ((value & mask) === 0 && n <= bits) {
    n += 1;
    mask >>>= 1;
  }
  return n;
}

function createHyperLogLog(opts = {}) {
  const precision = Number.isInteger(opts.precision) ? opts.precision : DEFAULT_PRECISION;
  if (precision < MIN_PRECISION || precision > MAX_PRECISION) {
    throw new RangeError(`hyperloglog: precision must be in [${MIN_PRECISION}, ${MAX_PRECISION}]`);
  }
  const m = 1 << precision;
  const registers = new Uint8Array(m);
  const alpha = alphaFor(m);
  const wBits = 32 - precision;

  function add(value) {
    if (value == null) return;
    const h = murmur32(value);
    const idx = h >>> wBits;                    // top `precision` bits
    const w = (h << precision) >>> precision;   // bottom wBits bits
    const rank = leadingZerosPlus1(w, wBits);
    if (rank > registers[idx]) registers[idx] = rank;
  }

  function rawEstimate() {
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < m; i++) {
      sum += 1 / Math.pow(2, registers[i]);
      if (registers[i] === 0) zeros += 1;
    }
    const E = (alpha * m * m) / sum;
    if (E <= 2.5 * m && zeros > 0) {
      // Linear counting for small-range bias correction.
      return Math.round(m * Math.log(m / zeros));
    }
    return Math.round(E);
  }

  function merge(other) {
    if (!other || typeof other.snapshot !== 'function') {
      throw new TypeError('hll.merge: another HyperLogLog required');
    }
    const snap = other.snapshot();
    if (snap.precision !== precision) {
      throw new TypeError(`hll.merge: precision mismatch (${snap.precision} vs ${precision})`);
    }
    for (let i = 0; i < m; i++) {
      if (snap.registers[i] > registers[i]) registers[i] = snap.registers[i];
    }
  }

  function snapshot() {
    return {
      precision,
      m,
      registers: Uint8Array.from(registers),
      count: rawEstimate(),
    };
  }

  function reset() {
    registers.fill(0);
  }

  return { add, count: rawEstimate, merge, snapshot, reset };
}

module.exports = {
  createHyperLogLog,
  murmur32,
  DEFAULT_PRECISION,
};
