'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createHyperLogLog, murmur32 } = require('../src/services/observability/hyperloglog');

describe('murmur32', () => {
  test('deterministic', () => {
    assert.equal(murmur32('hello'), murmur32('hello'));
  });
  test('different inputs differ', () => {
    assert.notEqual(murmur32('a'), murmur32('b'));
  });
  test('handles non-string by JSON-stringifying', () => {
    assert.equal(murmur32({ a: 1 }), murmur32({ a: 1 }));
  });
});

describe('createHyperLogLog — construction', () => {
  test('rejects out-of-range precision', () => {
    assert.throws(() => createHyperLogLog({ precision: 3 }), RangeError);
    assert.throws(() => createHyperLogLog({ precision: 17 }), RangeError);
  });

  test('default precision is 12', () => {
    const h = createHyperLogLog({});
    assert.equal(h.snapshot().precision, 12);
    assert.equal(h.snapshot().m, 4096);
  });
});

describe('createHyperLogLog — accuracy', () => {
  test('count of 0 distinct values is 0', () => {
    const h = createHyperLogLog({});
    assert.equal(h.count(), 0);
  });

  test('count of 100 distinct values within ±15% (small-range LC)', () => {
    const h = createHyperLogLog({ precision: 12 });
    for (let i = 0; i < 100; i++) h.add(`item-${i}`);
    const c = h.count();
    assert.ok(c >= 85 && c <= 115, `count=${c} not within ±15% of 100`);
  });

  test('count of 10k distinct values within ±5%', () => {
    const h = createHyperLogLog({ precision: 12 });
    for (let i = 0; i < 10_000; i++) h.add(`user:${i}`);
    const c = h.count();
    const rel = Math.abs(c - 10_000) / 10_000;
    assert.ok(rel < 0.05, `relative error ${rel.toFixed(3)} too high (count=${c})`);
  });

  test('count of 100k distinct values within ±5%', () => {
    const h = createHyperLogLog({ precision: 12 });
    for (let i = 0; i < 100_000; i++) h.add(`session:${i}`);
    const c = h.count();
    const rel = Math.abs(c - 100_000) / 100_000;
    assert.ok(rel < 0.05, `relative error ${rel.toFixed(3)} too high (count=${c})`);
  });

  test('duplicates do not inflate count', () => {
    const h = createHyperLogLog({});
    for (let i = 0; i < 50; i++) h.add('same');
    assert.equal(h.count(), 1);
  });

  test('null is ignored', () => {
    const h = createHyperLogLog({});
    h.add(null); h.add(undefined);
    assert.equal(h.count(), 0);
  });
});

describe('createHyperLogLog — merge', () => {
  test('union of disjoint counters approximates sum', () => {
    const a = createHyperLogLog({ precision: 12 });
    const b = createHyperLogLog({ precision: 12 });
    for (let i = 0; i < 5000; i++) a.add(`a:${i}`);
    for (let i = 0; i < 5000; i++) b.add(`b:${i}`);
    a.merge(b);
    const c = a.count();
    const rel = Math.abs(c - 10_000) / 10_000;
    assert.ok(rel < 0.05, `merge cardinality ${c} not ~10k (rel ${rel.toFixed(3)})`);
  });

  test('merge of overlapping counters approximates union, not sum', () => {
    const a = createHyperLogLog({ precision: 12 });
    const b = createHyperLogLog({ precision: 12 });
    for (let i = 0; i < 5000; i++) a.add(`x:${i}`);
    for (let i = 2500; i < 7500; i++) b.add(`x:${i}`); // 2500 overlap
    a.merge(b);
    const c = a.count();
    // Union = 7500 distinct.
    assert.ok(Math.abs(c - 7500) / 7500 < 0.05);
  });

  test('merge with mismatched precision throws', () => {
    const a = createHyperLogLog({ precision: 12 });
    const b = createHyperLogLog({ precision: 10 });
    assert.throws(() => a.merge(b), TypeError);
  });

  test('merge with non-HLL throws', () => {
    const a = createHyperLogLog({});
    assert.throws(() => a.merge({}), TypeError);
  });
});

describe('createHyperLogLog — reset / snapshot', () => {
  test('reset clears all registers', () => {
    const h = createHyperLogLog({});
    for (let i = 0; i < 1000; i++) h.add(`x:${i}`);
    h.reset();
    assert.equal(h.count(), 0);
  });

  test('snapshot is a defensive copy of registers', () => {
    const h = createHyperLogLog({ precision: 4 }); // small for inspection
    h.add('hello');
    const s = h.snapshot();
    s.registers[0] = 99;
    const s2 = h.snapshot();
    assert.notEqual(s2.registers[0], 99);
  });
});
