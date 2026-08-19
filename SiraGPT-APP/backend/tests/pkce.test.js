'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { generateCodeVerifier, challengeFor, verifyChallenge, VERIFIER_RE } = require('../src/services/auth/pkce');

describe('generateCodeVerifier', () => {
  test('default length 64', () => {
    const v = generateCodeVerifier();
    assert.equal(v.length, 64);
    assert.match(v, VERIFIER_RE);
  });

  test('respects custom length within [43,128]', () => {
    assert.equal(generateCodeVerifier({ length: 43 }).length, 43);
    assert.equal(generateCodeVerifier({ length: 128 }).length, 128);
  });

  test('rejects out-of-range length', () => {
    assert.throws(() => generateCodeVerifier({ length: 42 }), RangeError);
    assert.throws(() => generateCodeVerifier({ length: 129 }), RangeError);
    assert.throws(() => generateCodeVerifier({ length: 0 }), RangeError);
  });

  test('two calls produce different verifiers', () => {
    assert.notEqual(generateCodeVerifier(), generateCodeVerifier());
  });
});

describe('challengeFor', () => {
  test('S256 produces base64url-safe SHA-256 hash', () => {
    const v = generateCodeVerifier();
    const c = challengeFor(v, 'S256');
    assert.match(c, /^[A-Za-z0-9_-]+$/);
    assert.equal(c.length, 43); // SHA-256 → 32 bytes → 43 chars unpadded base64url
  });

  test('S256 deterministic for same verifier', () => {
    const v = generateCodeVerifier();
    assert.equal(challengeFor(v, 'S256'), challengeFor(v, 'S256'));
  });

  test('plain method echoes verifier', () => {
    const v = generateCodeVerifier();
    assert.equal(challengeFor(v, 'plain'), v);
  });

  test('rejects bad verifier', () => {
    assert.throws(() => challengeFor('short'), TypeError);
    assert.throws(() => challengeFor(null), TypeError);
    assert.throws(() => challengeFor('a'.repeat(43) + '!'), TypeError);
  });

  test('rejects unknown method', () => {
    assert.throws(() => challengeFor(generateCodeVerifier(), 'banana'), TypeError);
  });
});

describe('verifyChallenge', () => {
  test('correct verifier+challenge → true', () => {
    const v = generateCodeVerifier();
    const c = challengeFor(v, 'S256');
    assert.equal(verifyChallenge(v, c, 'S256'), true);
  });

  test('wrong verifier → false', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    assert.equal(verifyChallenge(a, challengeFor(b, 'S256'), 'S256'), false);
  });

  test('mismatched method → false (because hash differs)', () => {
    const v = generateCodeVerifier();
    assert.equal(verifyChallenge(v, challengeFor(v, 'plain'), 'S256'), false);
  });

  test('non-string challenge → false', () => {
    assert.equal(verifyChallenge(generateCodeVerifier(), null), false);
  });

  test('plain method round-trip', () => {
    const v = generateCodeVerifier();
    assert.equal(verifyChallenge(v, v, 'plain'), true);
  });
});

describe('VERIFIER_RE', () => {
  test('matches expected character set + length range', () => {
    assert.equal(VERIFIER_RE.test('a'.repeat(43)), true);
    assert.equal(VERIFIER_RE.test('a'.repeat(128)), true);
    assert.equal(VERIFIER_RE.test('a'.repeat(42)), false);
    assert.equal(VERIFIER_RE.test('a'.repeat(129)), false);
    assert.equal(VERIFIER_RE.test('!'.repeat(43)), false);
  });
});
