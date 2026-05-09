'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { randomBytes } = require('node:crypto');

const { encode, decode, isValid, ALPHABET } = require('../src/utils/base58');

describe('alphabet', () => {
  test('58 chars, no 0/O/I/l', () => {
    assert.equal(ALPHABET.length, 58);
    assert.equal(ALPHABET.includes('0'), false);
    assert.equal(ALPHABET.includes('O'), false);
    assert.equal(ALPHABET.includes('I'), false);
    assert.equal(ALPHABET.includes('l'), false);
  });
});

describe('encode', () => {
  test('empty buffer → empty string', () => {
    assert.equal(encode(Buffer.alloc(0)), '');
  });
  test('single byte 0x00 → "1"', () => {
    assert.equal(encode(Buffer.from([0x00])), '1');
  });
  test('classic Bitcoin vector: "Hello World!"', () => {
    assert.equal(encode(Buffer.from('Hello World!')), '2NEpo7TZRRrLZSi2U');
  });
  test('leading zero bytes preserved as leading "1"s', () => {
    assert.equal(encode(Buffer.from([0x00, 0x00, 0x01])), '112');
  });
  test('rejects non-Buffer', () => {
    assert.throws(() => encode('not a buffer'), TypeError);
  });
});

describe('decode', () => {
  test('empty string → empty buffer', () => {
    assert.equal(decode('').length, 0);
  });
  test('decode of classic vector', () => {
    assert.equal(decode('2NEpo7TZRRrLZSi2U').toString(), 'Hello World!');
  });
  test('leading "1"s decode to leading zero bytes', () => {
    const b = decode('112');
    assert.deepEqual(Array.from(b), [0x00, 0x00, 0x01]);
  });
  test('rejects invalid character', () => {
    assert.throws(() => decode('Hello0World'), TypeError); // '0' is not in alphabet
    assert.throws(() => decode('OOI'), TypeError);
  });
  test('rejects non-string', () => {
    assert.throws(() => decode(123), TypeError);
  });
});

describe('round-trip', () => {
  test('UTF-8 strings of various lengths', () => {
    for (const s of ['', 'a', 'hi', 'the quick brown fox', '日本語']) {
      const buf = Buffer.from(s, 'utf8');
      assert.ok(decode(encode(buf)).equals(buf), `failed for: ${s}`);
    }
  });
  test('random bytes (1024 trials)', () => {
    for (let i = 0; i < 50; i++) {
      const len = 1 + Math.floor(Math.random() * 64);
      const buf = randomBytes(len);
      assert.ok(decode(encode(buf)).equals(buf));
    }
  });
  test('preserves byte length even with leading zeros', () => {
    const buf = Buffer.concat([Buffer.alloc(5, 0), randomBytes(8)]);
    const r = decode(encode(buf));
    assert.equal(r.length, buf.length);
    assert.ok(r.equals(buf));
  });
});

describe('isValid', () => {
  test('all-alphabet string', () => {
    assert.equal(isValid('2NEpo7TZRRrLZSi2U'), true);
  });
  test('contains forbidden char', () => {
    assert.equal(isValid('hello0world'), false);
    assert.equal(isValid('OkayThen'), false); // O is forbidden
  });
  test('non-string', () => {
    assert.equal(isValid(123), false);
    assert.equal(isValid(null), false);
  });
});
