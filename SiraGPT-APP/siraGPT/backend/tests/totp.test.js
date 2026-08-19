'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { generateTotp, verifyTotp, hotp, randomSecret, base32Encode, base32Decode } = require('../src/services/auth/totp');

// RFC 6238 test vectors (key = "12345678901234567890" → ASCII)
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');

describe('base32 encode/decode', () => {
  test('round-trip empty', () => {
    assert.equal(base32Encode(Buffer.alloc(0)), '');
    assert.equal(base32Decode('').length, 0);
  });

  test('round-trip arbitrary bytes', () => {
    const buf = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a]);
    const enc = base32Encode(buf);
    const dec = base32Decode(enc);
    assert.equal(dec.equals(buf), true);
  });

  test('decode tolerates lowercase + padding', () => {
    const buf = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a]);
    const upper = base32Encode(buf);
    const padded = upper.toLowerCase() + '====';
    assert.equal(base32Decode(padded).equals(buf), true);
  });

  test('decode silently strips invalid chars (tolerant of formatting)', () => {
    // Invalid chars are stripped before decoding, so '!@#$' → '' → empty buffer.
    assert.equal(base32Decode('!@#$').length, 0);
  });
});

describe('hotp / generateTotp — RFC 6238 vectors', () => {
  test('T=59 (sha1) → 94287082', () => {
    const code = generateTotp(RFC_KEY, { time: 59, step: 30, digits: 8 });
    assert.equal(code, '94287082');
  });

  test('T=1111111109 (sha1) → 07081804', () => {
    const code = generateTotp(RFC_KEY, { time: 1111111109, step: 30, digits: 8 });
    assert.equal(code, '07081804');
  });

  test('T=1234567890 (sha1) → 89005924', () => {
    const code = generateTotp(RFC_KEY, { time: 1234567890, step: 30, digits: 8 });
    assert.equal(code, '89005924');
  });

  test('default 6 digits', () => {
    const code = generateTotp(RFC_KEY, { time: 59 });
    assert.match(code, /^\d{6}$/);
  });
});

describe('verifyTotp', () => {
  test('correct code in current window verifies', () => {
    const t = 1700000000;
    const code = generateTotp(RFC_KEY, { time: t });
    assert.equal(verifyTotp(code, RFC_KEY, { time: t }), true);
  });

  test('code from previous step verifies within ±1 window', () => {
    const t = 1700000000;
    const prevCode = generateTotp(RFC_KEY, { time: t - 30 });
    assert.equal(verifyTotp(prevCode, RFC_KEY, { time: t, window: 1 }), true);
  });

  test('code from too-far past does NOT verify with window=0', () => {
    const t = 1700000000;
    const oldCode = generateTotp(RFC_KEY, { time: t - 90 });
    assert.equal(verifyTotp(oldCode, RFC_KEY, { time: t, window: 0 }), false);
  });

  test('non-numeric code returns false', () => {
    assert.equal(verifyTotp('abc', RFC_KEY), false);
    assert.equal(verifyTotp('', RFC_KEY), false);
  });

  test('different secret never matches', () => {
    const t = 1700000000;
    const code = generateTotp(RFC_KEY, { time: t });
    assert.equal(verifyTotp(code, Buffer.from('different-secret-bytes!'), { time: t }), false);
  });
});

describe('randomSecret', () => {
  test('returns base32 string of expected length', () => {
    const s = randomSecret({ bytes: 20 });
    // 20 bytes = 160 bits → ceil(160/5) = 32 base32 chars
    assert.equal(s.length, 32);
    assert.match(s, /^[A-Z2-7]+$/);
  });

  test('two secrets differ', () => {
    assert.notEqual(randomSecret(), randomSecret());
  });
});

describe('base32 secret round-trip with verifyTotp', () => {
  test('Google-Authenticator-style base32 secret works', () => {
    const secret = base32Encode(RFC_KEY);
    const t = 1700000000;
    const code = generateTotp(secret, { time: t });
    assert.equal(verifyTotp(code, secret, { time: t }), true);
  });
});
