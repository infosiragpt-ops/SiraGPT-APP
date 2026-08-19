'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const ph = require('../src/services/auth/password-hash');

// Use much smaller scrypt params for test speed.
const FAST = { N: 1024, r: 8, p: 1 };

describe('hash + verify — round-trip', () => {
  test('correct password verifies ok', async () => {
    const enc = await ph.hash('hunter2', FAST);
    const r = await ph.verify('hunter2', enc, { defaults: FAST });
    assert.equal(r.ok, true);
    assert.equal(r.needsRehash, false);
  });

  test('wrong password fails', async () => {
    const enc = await ph.hash('hunter2', FAST);
    const r = await ph.verify('wrong', enc, { defaults: FAST });
    assert.equal(r.ok, false);
  });

  test('unicode password round-trips', async () => {
    const enc = await ph.hash('contraseña con ñ y emoji 🔒', FAST);
    const r = await ph.verify('contraseña con ñ y emoji 🔒', enc, { defaults: FAST });
    assert.equal(r.ok, true);
  });
});

describe('hash output shape', () => {
  test('encoded record starts with $scrypt$ + has all params', async () => {
    const enc = await ph.hash('x', FAST);
    assert.match(enc, /^\$scrypt\$N=1024\$r=8\$p=1\$/);
    assert.equal(enc.split('$').length, 7);
  });

  test('two hashes of same password differ (random salt)', async () => {
    const a = await ph.hash('same', FAST);
    const b = await ph.hash('same', FAST);
    assert.notEqual(a, b);
  });

  test('non-string password throws', async () => {
    await assert.rejects(ph.hash(42), TypeError);
  });
});

describe('verify — robustness', () => {
  test('non-string password returns ok:false', async () => {
    const enc = await ph.hash('x', FAST);
    const r = await ph.verify(123, enc);
    assert.equal(r.ok, false);
  });

  test('malformed encoded record returns ok:false', async () => {
    const r = await ph.verify('x', 'not-a-record');
    assert.equal(r.ok, false);
  });
});

describe('needsRehash', () => {
  test('true when stored cost < desired cost', async () => {
    const oldEnc = await ph.hash('x', { N: 1024, r: 8, p: 1 });
    const r = await ph.verify('x', oldEnc, { defaults: { N: 16384, r: 8, p: 1 } });
    assert.equal(r.ok, true);
    assert.equal(r.needsRehash, true);
  });

  test('false when stored cost meets desired', async () => {
    const enc = await ph.hash('x', { N: 16384, r: 8, p: 1 });
    const r = await ph.verify('x', enc, { defaults: { N: 16384, r: 8, p: 1 } });
    assert.equal(r.needsRehash, false);
  });
});

describe('parseEncoded / formatEncoded', () => {
  test('round-trip preserves params + salt + hash', async () => {
    const enc = await ph.hash('y', FAST);
    const parsed = ph.parseEncoded(enc);
    const reformatted = ph.formatEncoded(parsed);
    assert.equal(reformatted, enc);
  });

  test('parse rejects bad input', () => {
    assert.equal(ph.parseEncoded('garbage'), null);
    assert.equal(ph.parseEncoded(null), null);
    assert.equal(ph.parseEncoded('$scrypt$only=one$x$y'), null);
  });
});
