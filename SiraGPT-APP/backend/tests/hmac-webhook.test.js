'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createWebhookVerifier,
  parseHeader,
  formatHeader,
  hmacHex,
  safeEqualHex,
} = require('../src/services/auth/hmac-webhook');

describe('helpers', () => {
  test('hmacHex deterministic for same secret + payload', () => {
    assert.equal(hmacHex('s', 'p'), hmacHex('s', 'p'));
    assert.notEqual(hmacHex('s', 'p'), hmacHex('s2', 'p'));
  });
  test('safeEqualHex rejects mismatched lengths and non-strings', () => {
    assert.equal(safeEqualHex('aa', 'aa'), true);
    assert.equal(safeEqualHex('aa', 'aaa'), false);
    assert.equal(safeEqualHex(null, 'aa'), false);
  });
  test('parseHeader handles canonical and tolerates whitespace', () => {
    const p = parseHeader(' v1=abc, ts=123, nonce=xyz ');
    assert.equal(p.v1, 'abc');
    assert.equal(p.ts, 123);
    assert.equal(p.nonce, 'xyz');
  });
  test('parseHeader returns null on missing v1 or ts', () => {
    assert.equal(parseHeader(''), null);
    assert.equal(parseHeader('ts=123'), null);
    assert.equal(parseHeader('v1=abc'), null);
    assert.equal(parseHeader('v1=abc,ts=NaN'), null);
  });
  test('formatHeader round-trips', () => {
    const h = formatHeader({ v1: 'X', ts: 9, nonce: 'n' });
    const p = parseHeader(h);
    assert.equal(p.v1, 'X');
    assert.equal(p.ts, 9);
    assert.equal(p.nonce, 'n');
  });
});

describe('createWebhookVerifier — construction', () => {
  test('rejects empty secret', () => {
    assert.throws(() => createWebhookVerifier({}), TypeError);
    assert.throws(() => createWebhookVerifier({ secret: '' }), TypeError);
  });
});

describe('createWebhookVerifier — sign / verify round-trip', () => {
  test('verify accepts freshly-signed payload', () => {
    const w = createWebhookVerifier({ secret: 'shh', now: () => 1000 });
    const sig = w.sign({ body: 'hello' });
    const r = w.verify({ body: 'hello', header: sig.header });
    assert.equal(r.ok, true);
  });

  test('different body fails signature_mismatch', () => {
    const w = createWebhookVerifier({ secret: 'shh' });
    const sig = w.sign({ body: 'hello' });
    const r = w.verify({ body: 'tampered', header: sig.header });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'signature_mismatch');
  });

  test('different secret fails signature_mismatch', () => {
    const a = createWebhookVerifier({ secret: 'A' });
    const b = createWebhookVerifier({ secret: 'B' });
    const sig = a.sign({ body: 'x' });
    assert.equal(b.verify({ body: 'x', header: sig.header }).ok, false);
  });
});

describe('createWebhookVerifier — timestamp window', () => {
  test('inside tolerance accepted', () => {
    let t = 1000;
    const w = createWebhookVerifier({ secret: 's', toleranceSec: 60, now: () => t });
    const sig = w.sign({ body: 'x' });
    t = 1030;
    assert.equal(w.verify({ body: 'x', header: sig.header }).ok, true);
  });

  test('outside tolerance rejected with timestamp_out_of_window', () => {
    let t = 1000;
    const w = createWebhookVerifier({ secret: 's', toleranceSec: 60, now: () => t });
    const sig = w.sign({ body: 'x' });
    t = 5000;
    const r = w.verify({ body: 'x', header: sig.header });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timestamp_out_of_window');
  });
});

describe('createWebhookVerifier — nonce replay', () => {
  test('same nonce verified twice is rejected as replay', () => {
    const w = createWebhookVerifier({ secret: 's', now: () => 1000 });
    const sig = w.sign({ body: 'x' });
    assert.equal(w.verify({ body: 'x', header: sig.header }).ok, true);
    const r = w.verify({ body: 'x', header: sig.header });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'replay');
  });

  test('absent nonce skips replay check', () => {
    const w = createWebhookVerifier({ secret: 's', now: () => 1000 });
    // Manually craft a header with no nonce.
    const ts = 1000;
    const v1 = hmacHex('s', `${ts}..body`);
    const header = formatHeader({ v1, ts });
    assert.equal(w.verify({ body: 'body', header }).ok, true);
    assert.equal(w.verify({ body: 'body', header }).ok, true);
  });
});

describe('createWebhookVerifier — robustness', () => {
  test('verify rejects missing body / malformed header', () => {
    const w = createWebhookVerifier({ secret: 's' });
    assert.equal(w.verify({}).reason, 'body_required');
    assert.equal(w.verify({ body: 'x', header: 'garbage' }).reason, 'malformed_header');
  });

  test('snapshot exposes config + nonce cache size', () => {
    const w = createWebhookVerifier({ secret: 's', toleranceSec: 60 });
    const sig = w.sign({ body: 'x' });
    w.verify({ body: 'x', header: sig.header });
    const s = w.snapshot();
    assert.equal(s.toleranceSec, 60);
    assert.ok(s.seenNonces >= 1);
  });
});
