'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { nanoid, customAlphabet, ALPHABET_DEFAULT } = require('../src/utils/nanoid');

describe('nanoid', () => {
  test('default size 21', () => {
    assert.equal(nanoid().length, 21);
  });

  test('custom size respected', () => {
    assert.equal(nanoid(8).length, 8);
    assert.equal(nanoid(64).length, 64);
  });

  test('characters from default alphabet only', () => {
    const id = nanoid(100);
    for (const ch of id) {
      assert.ok(ALPHABET_DEFAULT.includes(ch), `unexpected char "${ch}"`);
    }
  });

  test('1000 IDs are all unique', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) seen.add(nanoid());
    assert.equal(seen.size, 1000);
  });
});

describe('customAlphabet', () => {
  test('returned generator uses only the given alphabet', () => {
    const gen = customAlphabet('0123456789', 12);
    const id = gen();
    assert.equal(id.length, 12);
    assert.match(id, /^\d+$/);
  });

  test('different alphabets produce different distributions', () => {
    const hex = customAlphabet('0123456789abcdef', 16);
    for (let i = 0; i < 10; i++) {
      assert.match(hex(), /^[0-9a-f]{16}$/);
    }
  });

  test('rejects bad alphabet', () => {
    assert.throws(() => customAlphabet('', 5), TypeError);
    assert.throws(() => customAlphabet('a'.repeat(257), 5), TypeError);
  });

  test('rejects bad size', () => {
    assert.throws(() => customAlphabet('abc', 0), TypeError);
    assert.throws(() => customAlphabet('abc', -1), TypeError);
  });

  test('alphabet of length 1 yields a string of that char', () => {
    const gen = customAlphabet('x', 5);
    assert.equal(gen(), 'xxxxx');
  });
});

describe('bias check (sanity)', () => {
  test('character distribution roughly uniform on a small alphabet', () => {
    const gen = customAlphabet('AB', 1);
    const counts = { A: 0, B: 0 };
    for (let i = 0; i < 5000; i++) counts[gen()] += 1;
    // Each should be near 2500 ±300.
    assert.ok(Math.abs(counts.A - counts.B) < 600, JSON.stringify(counts));
  });
});

describe('ALPHABET_DEFAULT export', () => {
  test('is a non-empty string of unique chars', () => {
    assert.ok(ALPHABET_DEFAULT.length > 0);
    assert.equal(new Set(ALPHABET_DEFAULT).size, ALPHABET_DEFAULT.length);
  });
});
