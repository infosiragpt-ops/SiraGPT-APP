'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { compare, sort, sortBy, chunkify } = require('../src/utils/natural-sort');

describe('chunkify', () => {
  test('alternates digit / non-digit runs', () => {
    assert.deepEqual(chunkify('file10.txt'), ['file', '10', '.txt']);
    assert.deepEqual(chunkify('a1b2c3'), ['a', '1', 'b', '2', 'c', '3']);
  });
  test('pure number / pure text', () => {
    assert.deepEqual(chunkify('42'), ['42']);
    assert.deepEqual(chunkify('abc'), ['abc']);
  });
});

describe('compare — natural ordering', () => {
  test('file2 < file10 (the canonical case)', () => {
    assert.equal(compare('file2.txt', 'file10.txt'), -1);
    assert.equal(compare('file10.txt', 'file2.txt'), 1);
  });

  test('identical strings → 0', () => {
    assert.equal(compare('a1', 'a1'), 0);
  });

  test('lexicographic when no digits', () => {
    assert.equal(compare('apple', 'banana'), -1);
  });

  test('digits before letters at the same chunk position', () => {
    assert.equal(compare('1abc', 'abc'), -1);
  });

  test('handles leading zeros sanely', () => {
    assert.equal(compare('item09', 'item010'), -1);
    assert.equal(compare('item9', 'item010'), -1);
  });

  test('case-insensitive option', () => {
    assert.equal(compare('Apple', 'banana'), -1); // 'A' < 'b' uppercase
    assert.equal(compare('Apple', 'apple', { caseInsensitive: true }), 0);
  });

  test('coerces non-strings', () => {
    assert.equal(compare(2, 10), -1);
  });
});

describe('sort', () => {
  test('produces natural order', () => {
    const out = sort(['file10.txt', 'file2.txt', 'file1.txt']);
    assert.deepEqual(out, ['file1.txt', 'file2.txt', 'file10.txt']);
  });

  test('does not mutate the input', () => {
    const input = ['b', 'a'];
    const out = sort(input);
    assert.notEqual(out, input);
    assert.deepEqual(input, ['b', 'a']);
  });

  test('key fn extracts comparable value', () => {
    const out = sort([{ name: 'v10' }, { name: 'v2' }], { key: (x) => x.name });
    assert.deepEqual(out.map((x) => x.name), ['v2', 'v10']);
  });

  test('non-array throws', () => {
    assert.throws(() => sort('nope'), TypeError);
  });
});

describe('sortBy', () => {
  test('alias for sort with key', () => {
    const out = sortBy([{ v: 'release-2.txt' }, { v: 'release-10.txt' }], (x) => x.v);
    assert.equal(out[0].v, 'release-2.txt');
    assert.equal(out[1].v, 'release-10.txt');
  });
});
