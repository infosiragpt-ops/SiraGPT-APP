'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  quantizeInt8,
  dequantizeInt8,
  quantizedDot,
  quantizedCosine,
  byteSize,
  QuantizedVectorStore,
  measureRecall,
} = require('../src/cache/embedding-quantizer');

// Deterministic PRNG so recall tests don't flake on a bad seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnitVec(rng, dim) {
  const v = new Float32Array(dim);
  let mag = 0;
  for (let i = 0; i < dim; i++) {
    // Box–Muller for ~N(0,1)
    const u1 = Math.max(rng(), 1e-9);
    const u2 = rng();
    v[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    mag += v[i] * v[i];
  }
  const inv = 1 / Math.sqrt(mag);
  for (let i = 0; i < dim; i++) v[i] *= inv;
  return v;
}

test('quantizeInt8: round-trip stays within scale of original', () => {
  const v = [0.1, -0.5, 0.999, -0.999, 0, 0.25];
  const qv = quantizeInt8(v);
  assert.ok(qv.q instanceof Int8Array);
  assert.equal(qv.q.length, v.length);
  assert.ok(qv.scale > 0);
  const back = dequantizeInt8(qv);
  for (let i = 0; i < v.length; i++) {
    assert.ok(Math.abs(back[i] - v[i]) <= qv.scale + 1e-6, `idx ${i}: ${back[i]} vs ${v[i]}`);
  }
});

test('quantizeInt8: extreme values are clamped to ±127', () => {
  const v = [1, -1, 0.5, -0.5];
  const { q } = quantizeInt8(v);
  assert.equal(q[0], 127);
  assert.equal(q[1], -127);
  assert.ok(Math.abs(q[2]) <= 127);
});

test('quantizeInt8: all-zero vector yields scale 0 and zero ints', () => {
  const { q, scale } = quantizeInt8(new Float32Array(8));
  assert.equal(scale, 0);
  for (const x of q) assert.equal(x, 0);
});

test('quantizeInt8: empty vector', () => {
  const { q, scale } = quantizeInt8(new Float32Array(0));
  assert.equal(q.length, 0);
  assert.equal(scale, 0);
});

test('quantizeInt8: non-finite entries are coerced to zero, not poison scale', () => {
  const v = [0.5, NaN, -0.5, Infinity];
  const { q, scale } = quantizeInt8(v);
  // absMax should come from 0.5, not Infinity
  assert.ok(scale > 0 && scale < 0.01);
  assert.equal(q[1], 0);
  assert.equal(q[3], 0);
});

test('quantizedCosine: self-similarity is 1', () => {
  const v = randomUnitVec(mulberry32(1), 64);
  const qv = quantizeInt8(v);
  const sim = quantizedCosine(qv, qv);
  assert.ok(Math.abs(sim - 1) < 1e-9, `expected 1, got ${sim}`);
});

test('quantizedCosine: orthogonal vectors are near zero', () => {
  const dim = 128;
  const a = new Float32Array(dim);
  const b = new Float32Array(dim);
  for (let i = 0; i < dim; i++) { a[i] = i % 2 === 0 ? 1 : 0; b[i] = i % 2 === 0 ? 0 : 1; }
  const sim = quantizedCosine(quantizeInt8(a), quantizeInt8(b));
  assert.ok(Math.abs(sim) < 1e-6);
});

test('quantizedCosine: anti-parallel vectors are -1', () => {
  const v = randomUnitVec(mulberry32(7), 64);
  const neg = v.map((x) => -x);
  const sim = quantizedCosine(quantizeInt8(v), quantizeInt8(neg));
  assert.ok(Math.abs(sim + 1) < 1e-9, `expected -1, got ${sim}`);
});

test('quantizedDot: empty / zero-scale → 0', () => {
  const a = quantizeInt8(new Float32Array(0));
  const b = quantizeInt8(new Float32Array(0));
  assert.equal(quantizedDot(a, b), 0);
  const z = quantizeInt8(new Float32Array(8));
  const v = quantizeInt8([0.1, 0.2, 0.3, 0, 0, 0, 0, 0]);
  assert.equal(quantizedDot(z, v), 0);
});

test('byteSize: ~4× smaller than equivalent Float32', () => {
  const dim = 1024;
  const v = randomUnitVec(mulberry32(2), dim);
  const qv = quantizeInt8(v);
  const floatBytes = dim * 4;
  const quantBytes = byteSize(qv);
  // dim bytes + 8-byte scale → ratio approaches 4 as dim grows.
  assert.ok(quantBytes < floatBytes / 3.5, `expected ~4× compression, got ${floatBytes}/${quantBytes}`);
});

test('measureRecall: int8 preserves top-1 nearest neighbour at high rate', () => {
  const rng = mulberry32(42);
  const vecs = [];
  for (let i = 0; i < 50; i++) vecs.push(randomUnitVec(rng, 256));
  const r = measureRecall(vecs, { k: 1 });
  // For random unit vectors with reasonable spacing, int8 quantization
  // should preserve the exact nearest neighbour essentially perfectly.
  assert.ok(r.recallAtK >= 0.98, `top-1 recall too low: ${r.recallAtK}`);
  assert.ok(r.meanSimError < 0.005, `mean sim error too high: ${r.meanSimError}`);
  assert.ok(r.compression > 3.5, `compression ratio too low: ${r.compression}`);
});

test('measureRecall: top-5 recall stays high on a denser corpus', () => {
  const rng = mulberry32(123);
  const vecs = [];
  for (let i = 0; i < 100; i++) vecs.push(randomUnitVec(rng, 384));
  const r = measureRecall(vecs, { k: 5 });
  assert.ok(r.recallAtK >= 0.95, `top-5 recall too low: ${r.recallAtK}`);
  assert.ok(r.maxSimError < 0.05, `worst sim error too high: ${r.maxSimError}`);
});

test('QuantizedVectorStore: set / get round-trip retrieves exact match', () => {
  const store = new QuantizedVectorStore();
  const rng = mulberry32(9);
  const v1 = randomUnitVec(rng, 128);
  const v2 = randomUnitVec(rng, 128);
  store.set('scope-A', v1, { id: 1 });
  store.set('scope-A', v2, { id: 2 });
  const hit = store.get('scope-A', v1, { threshold: 0.99 });
  assert.ok(hit, 'expected a hit');
  assert.equal(hit.value.id, 1);
  assert.ok(hit.similarity > 0.99);
});

test('QuantizedVectorStore: scope isolation prevents cross-scope hits', () => {
  const store = new QuantizedVectorStore();
  const v = randomUnitVec(mulberry32(3), 64);
  store.set('A', v, { tag: 'a' });
  const miss = store.get('B', v, { threshold: 0.5 });
  assert.equal(miss, undefined);
});

test('QuantizedVectorStore: dimension mismatch returns undefined', () => {
  const store = new QuantizedVectorStore();
  store.set('A', randomUnitVec(mulberry32(1), 64), { id: 1 });
  const miss = store.get('A', randomUnitVec(mulberry32(2), 32), { threshold: 0.5 });
  assert.equal(miss, undefined);
});

test('QuantizedVectorStore: threshold filtering rejects weak matches', () => {
  const store = new QuantizedVectorStore();
  const rng = mulberry32(11);
  const v = randomUnitVec(rng, 64);
  // Build an approximately orthogonal vector via Gram–Schmidt-lite.
  const u = randomUnitVec(rng, 64);
  let dotUV = 0;
  for (let i = 0; i < 64; i++) dotUV += u[i] * v[i];
  const w = new Float32Array(64);
  let mag = 0;
  for (let i = 0; i < 64; i++) { w[i] = u[i] - dotUV * v[i]; mag += w[i] * w[i]; }
  const inv = 1 / Math.sqrt(mag);
  for (let i = 0; i < 64; i++) w[i] *= inv;

  store.set('A', v, { id: 'v' });
  const miss = store.get('A', w, { threshold: 0.5 });
  assert.equal(miss, undefined);
});

test('QuantizedVectorStore: byteSize roughly equals dim*N + small overhead', () => {
  const store = new QuantizedVectorStore();
  const dim = 512;
  const N = 20;
  const rng = mulberry32(5);
  for (let i = 0; i < N; i++) store.set('A', randomUnitVec(rng, dim), { i });
  const bytes = store.byteSize();
  // Expected: N * (dim + 8). Allow generous slack.
  const expected = N * (dim + 8);
  assert.ok(bytes >= expected * 0.95 && bytes <= expected * 1.2, `bytes=${bytes} expected~${expected}`);
});

test('QuantizedVectorStore: clear empties the store', () => {
  const store = new QuantizedVectorStore();
  store.set('A', randomUnitVec(mulberry32(1), 32), {});
  store.set('A', randomUnitVec(mulberry32(2), 32), {});
  assert.equal(store.size, 2);
  store.clear();
  assert.equal(store.size, 0);
  assert.equal(store.byteSize(), 0);
});
