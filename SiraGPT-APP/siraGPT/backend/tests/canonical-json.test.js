'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  canonicalize,
  canonicalizeBuffer,
  sha256Hex,
  CanonicalJsonError,
} = require('../src/utils/canonical-json');

describe('canonicalize — primitives', () => {
  test('null / true / false / numbers / strings', () => {
    assert.equal(canonicalize(null), 'null');
    assert.equal(canonicalize(true), 'true');
    assert.equal(canonicalize(false), 'false');
    assert.equal(canonicalize(42), '42');
    assert.equal(canonicalize(0), '0');
    assert.equal(canonicalize(-0), '0');
    assert.equal(canonicalize(3.14), '3.14');
    assert.equal(canonicalize('hello'), '"hello"');
  });

  test('escaped strings', () => {
    assert.equal(canonicalize('a\nb'), '"a\\nb"');
    assert.equal(canonicalize('quote"inside'), '"quote\\"inside"');
    assert.equal(canonicalize('back\\slash'), '"back\\\\slash"');
  });

  test('control chars become \\uXXXX', () => {
    assert.equal(canonicalize(''), '"\\u0001"');
    assert.equal(canonicalize(''), '"\\u001f"');
  });

  test('NaN / Infinity throw', () => {
    assert.throws(() => canonicalize(NaN), CanonicalJsonError);
    assert.throws(() => canonicalize(Infinity), CanonicalJsonError);
    assert.throws(() => canonicalize(-Infinity), CanonicalJsonError);
  });

  test('BigInt / Symbol / undefined / function throw', () => {
    assert.throws(() => canonicalize(1n), CanonicalJsonError);
    assert.throws(() => canonicalize(Symbol('x')), CanonicalJsonError);
    assert.throws(() => canonicalize(undefined), CanonicalJsonError);
    assert.throws(() => canonicalize(() => 1), CanonicalJsonError);
  });
});

describe('canonicalize — objects', () => {
  test('keys sorted alphabetically', () => {
    assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');
  });

  test('nested objects keys sorted at every level', () => {
    const out = canonicalize({ z: { y: 1, x: 2 }, a: 1 });
    assert.equal(out, '{"a":1,"z":{"x":2,"y":1}}');
  });

  test('undefined-valued keys are skipped', () => {
    assert.equal(canonicalize({ a: 1, b: undefined, c: 3 }), '{"a":1,"c":3}');
  });

  test('empty object', () => {
    assert.equal(canonicalize({}), '{}');
  });

  test('two equal-shape objects in different declaration order canonicalize identically', () => {
    const a = { foo: 1, bar: { x: 1, y: 2 } };
    const b = { bar: { y: 2, x: 1 }, foo: 1 };
    assert.equal(canonicalize(a), canonicalize(b));
  });
});

describe('canonicalize — arrays', () => {
  test('preserves array order', () => {
    assert.equal(canonicalize([3, 1, 2]), '[3,1,2]');
  });

  test('empty array', () => {
    assert.equal(canonicalize([]), '[]');
  });

  test('mixed-type array', () => {
    assert.equal(canonicalize([1, 'a', null, true, { k: 1 }]), '[1,"a",null,true,{"k":1}]');
  });
});

describe('canonicalize — circular references', () => {
  test('circular object throws CIRCULAR', () => {
    const o = { a: 1 };
    o.self = o;
    try { canonicalize(o); assert.fail('should throw'); }
    catch (e) { assert.equal(e.code, 'CIRCULAR'); }
  });

  test('circular array throws CIRCULAR', () => {
    const a = [1];
    a.push(a);
    try { canonicalize(a); assert.fail('should throw'); }
    catch (e) { assert.equal(e.code, 'CIRCULAR'); }
  });
});

describe('canonicalizeBuffer + sha256Hex', () => {
  test('buffer round-trips through canonicalize', () => {
    const buf = canonicalizeBuffer({ b: 2, a: 1 });
    assert.equal(buf.toString('utf8'), '{"a":1,"b":2}');
  });

  test('sha256Hex is stable across key ordering', () => {
    const h1 = sha256Hex({ a: 1, b: 2 });
    const h2 = sha256Hex({ b: 2, a: 1 });
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });

  test('sha256Hex differs when content differs', () => {
    assert.notEqual(sha256Hex({ a: 1 }), sha256Hex({ a: 2 }));
  });
});
