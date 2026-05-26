'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createCursorCodec } = require('../src/utils/pagination-cursor');

describe('createCursorCodec — construction', () => {
  test('rejects empty secret', () => {
    assert.throws(() => createCursorCodec({}), TypeError);
  });
});

describe('encode + decode round-trip', () => {
  test('payload survives the cursor', () => {
    const c = createCursorCodec({ secret: 'shh' });
    const t = c.encode({ lastId: 42, sortDir: 'desc' });
    const r = c.decode(t);
    assert.equal(r.ok, true);
    assert.deepEqual(r.payload, { lastId: 42, sortDir: 'desc' });
  });

  test('cursor starts with version prefix', () => {
    const c = createCursorCodec({ secret: 'shh', version: 'v2' });
    const t = c.encode({ x: 1 });
    assert.match(t, /^v2\./);
  });

  test('isValid mirrors decode().ok', () => {
    const c = createCursorCodec({ secret: 'shh' });
    const t = c.encode({ x: 1 });
    assert.equal(c.isValid(t), true);
    assert.equal(c.isValid('garbage'), false);
  });
});

describe('decode — failure modes', () => {
  test('non-string returns malformed', () => {
    const c = createCursorCodec({ secret: 'shh' });
    assert.equal(c.decode(null).reason, 'malformed');
    assert.equal(c.decode(42).reason, 'malformed');
  });

  test('wrong version → unknown_version', () => {
    const a = createCursorCodec({ secret: 'shh', version: 'v1' });
    const b = createCursorCodec({ secret: 'shh', version: 'v2' });
    const t = a.encode({ x: 1 });
    const r = b.decode(t);
    assert.equal(r.reason, 'unknown_version');
    assert.equal(r.version, 'v1');
  });

  test('acceptVersions allows old versions through', () => {
    const a = createCursorCodec({ secret: 'shh', version: 'v1' });
    const b = createCursorCodec({ secret: 'shh', version: 'v2', acceptVersions: ['v1'] });
    const t = a.encode({ x: 99 });
    const r = b.decode(t);
    assert.equal(r.ok, true);
    assert.equal(r.payload.x, 99);
  });

  test('tampered data → signature_mismatch', () => {
    const c = createCursorCodec({ secret: 'shh' });
    let t = c.encode({ x: 1 });
    // Replace the data segment with a different valid base64url.
    const [v, sig] = t.split('.');
    const tampered = `${v}.${sig}.YWJj`; // 'abc'
    assert.equal(c.decode(tampered).reason, 'signature_mismatch');
  });

  test('different secret → signature_mismatch', () => {
    const a = createCursorCodec({ secret: 'A' });
    const b = createCursorCodec({ secret: 'B' });
    const t = a.encode({ x: 1 });
    assert.equal(b.decode(t).reason, 'signature_mismatch');
  });

  test('wrong number of dot-segments → malformed', () => {
    const c = createCursorCodec({ secret: 'shh' });
    assert.equal(c.decode('only.two').reason, 'malformed');
    assert.equal(c.decode('a.b.c.d').reason, 'malformed');
  });
});

describe('canonical encoding', () => {
  test('two equivalent payloads produce identical cursors', () => {
    const c = createCursorCodec({ secret: 'shh' });
    const t1 = c.encode({ a: 1, b: 2 });
    const t2 = c.encode({ b: 2, a: 1 });
    assert.equal(t1, t2);
  });
});
