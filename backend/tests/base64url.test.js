'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { encode, decode, encodeJson, decodeJson, isBase64Url } = require('../src/utils/base64url');

describe('encode', () => {
  test('utf8 string round-trips through decode', () => {
    const e = encode('hello world');
    assert.equal(decode(e, { encoding: 'utf8' }), 'hello world');
  });

  test('produces URL-safe alphabet (no + or /)', () => {
    const e = encode('?>?>?>?>?>?>'); // chosen to force +/ in standard b64
    assert.equal(/[+/=]/.test(e), false);
  });

  test('strips padding by default; pad:true keeps it', () => {
    const noPad = encode('a'); // 'YQ' (would be 'YQ==' with pad)
    const padded = encode('a', { pad: true });
    assert.equal(noPad, 'YQ');
    assert.equal(padded.endsWith('='), true);
  });

  test('Buffer + Uint8Array inputs work', () => {
    assert.equal(encode(Buffer.from('hi')), 'aGk');
    assert.equal(encode(new Uint8Array([1, 2, 3])), 'AQID');
  });

  test('null/undefined → empty string', () => {
    assert.equal(encode(null), '');
    assert.equal(encode(undefined), '');
  });

  test('rejects non-string/non-buffer input', () => {
    assert.throws(() => encode(42), TypeError);
  });
});

describe('decode', () => {
  test('returns Buffer by default', () => {
    const out = decode('aGVsbG8');
    assert.ok(Buffer.isBuffer(out));
    assert.equal(out.toString('utf8'), 'hello');
  });

  test('utf8 encoding option returns string', () => {
    assert.equal(decode('aGVsbG8', { encoding: 'utf8' }), 'hello');
  });

  test('accepts both padded and unpadded input', () => {
    assert.equal(decode('YQ==', { encoding: 'utf8' }), 'a');
    assert.equal(decode('YQ', { encoding: 'utf8' }), 'a');
  });

  test('non-string input throws', () => {
    assert.throws(() => decode(42), TypeError);
  });

  test('malformed input throws', () => {
    assert.throws(() => decode('not!valid'), TypeError);
  });
});

describe('encodeJson / decodeJson', () => {
  test('round-trips arbitrary JSON', () => {
    const value = { a: 1, b: [1, 2, 3], c: 'hello' };
    assert.deepEqual(decodeJson(encodeJson(value)), value);
  });

  test('output is URL-safe', () => {
    const e = encodeJson({ a: { b: { c: 'verylong'.repeat(50) } } });
    assert.equal(/[+/=]/.test(e), false);
  });
});

describe('isBase64Url', () => {
  test('true for URL-safe alphabet (with or without padding)', () => {
    assert.equal(isBase64Url('aGVsbG8'), true);
    assert.equal(isBase64Url('aGVsbG8='), true);
    assert.equal(isBase64Url('-_AB'), true);
  });

  test('false for standard-base64 chars + non-strings', () => {
    assert.equal(isBase64Url('a/b'), false);
    assert.equal(isBase64Url('a+b'), false);
    assert.equal(isBase64Url(''), false);
    assert.equal(isBase64Url(null), false);
  });
});

describe('round-trip with binary data', () => {
  test('all-byte values 0..255 round-trip', () => {
    const buf = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) buf[i] = i;
    const decoded = decode(encode(buf));
    assert.equal(decoded.equals(buf), true);
  });
});
