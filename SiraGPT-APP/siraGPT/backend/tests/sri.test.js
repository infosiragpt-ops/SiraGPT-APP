'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { createHash } = require('node:crypto');

const { build, parse, verify, strongest } = require('../src/utils/sri');

const PAYLOAD = Buffer.from('alert("hi");');

function expectedDigestB64(alg, buf) {
  return createHash(alg).update(buf).digest('base64');
}

describe('build', () => {
  test('default sha384 token format', () => {
    const t = build(PAYLOAD);
    assert.match(t, /^sha384-/);
    const [, hash] = t.split('-');
    assert.equal(hash, expectedDigestB64('sha384', PAYLOAD));
  });
  test('sha256 / sha512', () => {
    assert.match(build(PAYLOAD, { algorithm: 'sha256' }), /^sha256-/);
    assert.match(build(PAYLOAD, { algorithm: 'sha512' }), /^sha512-/);
  });
  test('accepts string body (utf-8)', () => {
    const a = build('hello', { algorithm: 'sha256' });
    const b = build(Buffer.from('hello', 'utf8'), { algorithm: 'sha256' });
    assert.equal(a, b);
  });
  test('rejects unsupported algorithm', () => {
    assert.throws(() => build(PAYLOAD, { algorithm: 'md5' }), TypeError);
  });
  test('rejects non-buffer / non-string body', () => {
    assert.throws(() => build(123), TypeError);
  });
});

describe('parse', () => {
  test('single token', () => {
    const r = parse('sha256-abc');
    assert.deepEqual(r, [{ algorithm: 'sha256', hash: 'abc' }]);
  });
  test('multi-token whitespace-separated', () => {
    const r = parse('sha256-aaa sha384-bbb sha512-ccc');
    assert.equal(r.length, 3);
  });
  test('strips ?option suffix', () => {
    const r = parse('sha384-zzz?ct=text/plain');
    assert.equal(r[0].hash, 'zzz');
  });
  test('skips invalid algorithms', () => {
    const r = parse('md5-xxx sha256-yyy');
    assert.equal(r.length, 1);
    assert.equal(r[0].algorithm, 'sha256');
  });
  test('empty / non-string → []', () => {
    assert.deepEqual(parse(''), []);
    assert.deepEqual(parse(null), []);
  });
});

describe('verify', () => {
  test('matching SRI verifies', () => {
    const meta = build(PAYLOAD);
    assert.equal(verify(PAYLOAD, meta), true);
  });
  test('tampered payload fails', () => {
    const meta = build(PAYLOAD);
    assert.equal(verify(Buffer.from('alert("evil");'), meta), false);
  });
  test('any matching token in multi-token metadata wins', () => {
    const wrong = `sha256-${expectedDigestB64('sha256', Buffer.from('other'))}`;
    const right = build(PAYLOAD, { algorithm: 'sha384' });
    assert.equal(verify(PAYLOAD, `${wrong} ${right}`), true);
  });
  test('empty metadata returns false', () => {
    assert.equal(verify(PAYLOAD, ''), false);
  });
  test('mismatched length safely returns false', () => {
    assert.equal(verify(PAYLOAD, 'sha256-short'), false);
  });
});

describe('strongest', () => {
  test('picks sha512 over sha384 over sha256', () => {
    const meta = 'sha256-aaa sha512-ccc sha384-bbb';
    assert.equal(strongest(meta).algorithm, 'sha512');
  });
  test('returns null for empty', () => {
    assert.equal(strongest(''), null);
  });
});

describe('end-to-end plugin pinning scenario', () => {
  test('manifest hash blocks tampered artifact', () => {
    const original = Buffer.from('module.exports = function trusted() { return 42; }');
    const manifestSri = build(original);

    // Verifier accepts the original
    assert.equal(verify(original, manifestSri), true);

    // Tampered version is rejected
    const tampered = Buffer.from('module.exports = function trusted() { return 666; }');
    assert.equal(verify(tampered, manifestSri), false);
  });
});
