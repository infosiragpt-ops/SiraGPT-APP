'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createUlidGenerator,
  ulid,
  decodeTimestamp,
  isValid,
  TOTAL_LEN,
} = require('../src/utils/ulid');

describe('ulid — basic shape', () => {
  test('default factory returns 26-char string', () => {
    const id = ulid();
    assert.equal(id.length, TOTAL_LEN);
    assert.equal(isValid(id), true);
  });

  test('characters are Crockford-base32 alphabet', () => {
    const id = ulid();
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('ulid — timestamp encoding', () => {
  test('decodeTimestamp recovers the input ms', () => {
    const gen = createUlidGenerator({ now: () => 1_700_000_000_000 });
    const id = gen.next();
    assert.equal(decodeTimestamp(id), 1_700_000_000_000);
  });

  test('fromTimestamp encodes a specific ms', () => {
    const gen = createUlidGenerator({});
    const id = gen.fromTimestamp(0);
    assert.equal(decodeTimestamp(id), 0);
  });

  test('rejects negative timestamps', () => {
    const gen = createUlidGenerator({});
    assert.throws(() => gen.fromTimestamp(-1), RangeError);
  });

  test('rejects timestamps > 2^48 ms', () => {
    const gen = createUlidGenerator({});
    assert.throws(() => gen.fromTimestamp((1 << 30) * (1 << 19)), RangeError);
  });
});

describe('ulid — sortability', () => {
  test('IDs from earlier timestamps sort before later', () => {
    const a = createUlidGenerator({ now: () => 1000 }).next();
    const b = createUlidGenerator({ now: () => 2000 }).next();
    assert.ok(a < b);
  });

  test('same-ms IDs are strictly increasing within one generator', () => {
    let t = 1_000_000;
    const gen = createUlidGenerator({ now: () => t });
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(gen.next());
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1]);
  });
});

describe('ulid — randomness', () => {
  test('two different generators with same ms produce different IDs', () => {
    const a = createUlidGenerator({ now: () => 5000 }).next();
    const b = createUlidGenerator({ now: () => 5000 }).next();
    assert.notEqual(a, b);
  });

  test('1000 IDs are all unique', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) seen.add(ulid());
    assert.equal(seen.size, 1000);
  });
});

describe('isValid / decodeTimestamp — robustness', () => {
  test('isValid rejects wrong length / invalid chars / non-strings', () => {
    assert.equal(isValid('SHORT'), false);
    assert.equal(isValid('A'.repeat(26).replace(/A/g, 'I')), false); // I excluded
    assert.equal(isValid(null), false);
    assert.equal(isValid(123), false);
  });

  test('decodeTimestamp returns null on bad input', () => {
    assert.equal(decodeTimestamp('not-a-ulid'), null);
    assert.equal(decodeTimestamp(null), null);
  });
});

describe('ulid — custom rng', () => {
  test('seeded rng produces deterministic ID at fixed ms', () => {
    const fakeRng = (n) => Buffer.alloc(n, 0xab);
    const a = createUlidGenerator({ now: () => 1234, rng: fakeRng }).next();
    const b = createUlidGenerator({ now: () => 1234, rng: fakeRng }).next();
    assert.equal(a, b);
  });
});
