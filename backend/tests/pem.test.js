'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { encode, decode, decodeAll, isPem } = require('../src/utils/pem');

const SAMPLE_BODY = Buffer.from('the quick brown fox jumps over the lazy dog '.repeat(3));

describe('encode', () => {
  test('produces correct envelope', () => {
    const out = encode({ label: 'CERTIFICATE', body: Buffer.from('hi') });
    assert.match(out, /^-----BEGIN CERTIFICATE-----\n/);
    assert.match(out, /\n-----END CERTIFICATE-----\n$/);
  });
  test('wraps base64 at 64 columns', () => {
    const out = encode({ label: 'X', body: SAMPLE_BODY });
    const body = out.split('\n').slice(1, -2);
    for (const line of body) assert.ok(line.length <= 64);
  });
  test('rejects invalid label', () => {
    assert.throws(() => encode({ label: 'lower', body: Buffer.alloc(1) }), TypeError);
    assert.throws(() => encode({ label: 'A_B', body: Buffer.alloc(1) }), TypeError);
  });
  test('rejects non-Buffer body', () => {
    assert.throws(() => encode({ label: 'X', body: 'not a buffer' }), TypeError);
  });
  test('handles allowed multi-word label', () => {
    const out = encode({ label: 'RSA PRIVATE KEY', body: Buffer.from([0]) });
    assert.match(out, /BEGIN RSA PRIVATE KEY/);
  });
});

describe('decode', () => {
  test('round-trip recovers body', () => {
    const pem = encode({ label: 'CERTIFICATE', body: SAMPLE_BODY });
    const r = decode(pem);
    assert.equal(r.label, 'CERTIFICATE');
    assert.ok(r.body.equals(SAMPLE_BODY));
  });

  test('expectedLabel mismatch throws', () => {
    const pem = encode({ label: 'CERTIFICATE', body: Buffer.from('x') });
    assert.throws(() => decode(pem, { expectedLabel: 'PUBLIC KEY' }), TypeError);
  });

  test('strict mode rejects multi-block bundle', () => {
    const a = encode({ label: 'CERTIFICATE', body: Buffer.from('a') });
    const b = encode({ label: 'CERTIFICATE', body: Buffer.from('b') });
    assert.throws(() => decode(a + b, { strict: true }), TypeError);
  });

  test('throws when no PEM found', () => {
    assert.throws(() => decode('not a pem block'), TypeError);
  });

  test('tolerates leading/trailing whitespace', () => {
    const pem = encode({ label: 'X', body: Buffer.from('hi') });
    const wrapped = '\n\n  ' + pem + '\n';
    const r = decode(wrapped);
    assert.equal(r.label, 'X');
  });

  test('tolerates whitespace within base64 body', () => {
    // Manually inject extra whitespace inside body (still valid PEM)
    const pem = encode({ label: 'X', body: SAMPLE_BODY });
    const munged = pem.replace(/\n/g, '\n   '); // pad lines with spaces
    const r = decode(munged);
    assert.ok(r.body.equals(SAMPLE_BODY));
  });
});

describe('decodeAll — bundles', () => {
  test('extracts every block in order', () => {
    const a = encode({ label: 'CERTIFICATE', body: Buffer.from('a') });
    const b = encode({ label: 'CERTIFICATE', body: Buffer.from('b') });
    const c = encode({ label: 'CERTIFICATE', body: Buffer.from('c') });
    const all = decodeAll(a + b + c);
    assert.equal(all.length, 3);
    assert.equal(all[0].body.toString(), 'a');
    assert.equal(all[2].body.toString(), 'c');
  });

  test('mixed labels in a chain', () => {
    const cert = encode({ label: 'CERTIFICATE', body: Buffer.from('cert') });
    const key = encode({ label: 'PRIVATE KEY', body: Buffer.from('key') });
    const all = decodeAll(cert + key);
    assert.equal(all.length, 2);
    assert.equal(all[0].label, 'CERTIFICATE');
    assert.equal(all[1].label, 'PRIVATE KEY');
  });

  test('empty / non-string returns []', () => {
    assert.deepEqual(decodeAll(''), []);
    assert.deepEqual(decodeAll(null), []);
  });

  test('mismatched BEGIN/END labels skipped', () => {
    const broken = '-----BEGIN A-----\nZGF0YQ==\n-----END B-----\n';
    assert.deepEqual(decodeAll(broken), []);
  });
});

describe('isPem', () => {
  test('detects valid PEM', () => {
    const pem = encode({ label: 'X', body: Buffer.from('hi') });
    assert.equal(isPem(pem), true);
  });
  test('rejects garbage', () => {
    assert.equal(isPem('hello world'), false);
    assert.equal(isPem(123), false);
  });
});
