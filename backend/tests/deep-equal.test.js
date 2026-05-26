'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { deepEqual, deepDiff, isPlainObject } = require('../src/utils/deep-equal');

describe('deepEqual — primitives', () => {
  test('same primitives equal', () => {
    assert.equal(deepEqual(1, 1), true);
    assert.equal(deepEqual('a', 'a'), true);
    assert.equal(deepEqual(true, true), true);
    assert.equal(deepEqual(null, null), true);
    assert.equal(deepEqual(undefined, undefined), true);
  });
  test('NaN === NaN', () => {
    assert.equal(deepEqual(NaN, NaN), true);
  });
  test('-0 ≠ 0 (Object.is semantics)', () => {
    assert.equal(deepEqual(0, -0), false);
  });
  test('different primitive types not equal', () => {
    assert.equal(deepEqual(1, '1'), false);
    assert.equal(deepEqual(null, undefined), false);
  });
});

describe('deepEqual — plain objects + arrays', () => {
  test('same shape', () => {
    assert.equal(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  });
  test('different shape', () => {
    assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
    assert.equal(deepEqual({ a: 1 }, { a: 2 }), false);
  });
  test('arrays', () => {
    assert.equal(deepEqual([1, 2, 3], [1, 2, 3]), true);
    assert.equal(deepEqual([1, 2], [1, 2, 3]), false);
    assert.equal(deepEqual([1, 2], 'array'), false);
  });
  test('nested objects', () => {
    assert.equal(deepEqual({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } }), true);
    assert.equal(deepEqual({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 3 }] } }), false);
  });
});

describe('deepEqual — special objects', () => {
  test('Date', () => {
    assert.equal(deepEqual(new Date(0), new Date(0)), true);
    assert.equal(deepEqual(new Date(0), new Date(1)), false);
  });
  test('RegExp', () => {
    assert.equal(deepEqual(/^a/i, /^a/i), true);
    assert.equal(deepEqual(/^a/i, /^a/g), false);
  });
  test('Map', () => {
    const a = new Map([['x', 1], ['y', 2]]);
    const b = new Map([['y', 2], ['x', 1]]);
    assert.equal(deepEqual(a, b), true);
    const c = new Map([['x', 1]]);
    assert.equal(deepEqual(a, c), false);
  });
  test('Set', () => {
    assert.equal(deepEqual(new Set([1, 2, 3]), new Set([3, 2, 1])), true);
    assert.equal(deepEqual(new Set([1, 2]), new Set([1, 3])), false);
  });
  test('Buffer', () => {
    assert.equal(deepEqual(Buffer.from('abc'), Buffer.from('abc')), true);
    assert.equal(deepEqual(Buffer.from('abc'), Buffer.from('abd')), false);
  });
  test('Uint8Array', () => {
    assert.equal(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
    assert.equal(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  });
});

describe('deepEqual — circular references', () => {
  test('self-referencing object equal to its twin', () => {
    const a = { x: 1 }; a.self = a;
    const b = { x: 1 }; b.self = b;
    assert.equal(deepEqual(a, b), true);
  });
  test('cycle still detects shape difference', () => {
    const a = { x: 1 }; a.self = a;
    const b = { x: 2 }; b.self = b;
    assert.equal(deepEqual(a, b), false);
  });
});

describe('deepDiff', () => {
  test('returns [] when equal', () => {
    assert.deepEqual(deepDiff({ a: 1 }, { a: 1 }), []);
  });
  test('lists path of every divergence', () => {
    const diffs = deepDiff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 99 } });
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].path, '$.b.c');
  });
  test('multiple diffs reported', () => {
    const diffs = deepDiff({ a: 1, b: 2 }, { a: 9, b: 8 });
    assert.equal(diffs.length, 2);
  });
});

describe('isPlainObject', () => {
  test('plain object → true', () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject(Object.create(null)), true);
  });
  test('array / Date / null / primitive → false', () => {
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(new Date()), false);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject(42), false);
  });
});
