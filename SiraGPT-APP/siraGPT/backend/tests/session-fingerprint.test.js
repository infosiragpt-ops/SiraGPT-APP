/**
 * session-fingerprint — IP-class + UA hash binding for issued
 * sessions. Tests pin the drift tolerance for mobile networks (IP /24
 * collapsed before hashing) and the mismatch detection when network
 * or browser swaps.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeFingerprint,
  compareFingerprints,
  reduceIp,
  extractIp,
  extractUa,
  normalizeIpInput,
  normalizeUserAgent,
  MAX_UA_LENGTH,
} = require('../src/utils/session-fingerprint');

describe('reduceIp', () => {
  test('IPv4 collapses to /24 (drift tolerance for mobile networks)', () => {
    assert.equal(reduceIp('203.0.113.7'), '203.0.113.0/24');
    assert.equal(reduceIp('203.0.113.250'), '203.0.113.0/24');
    // Different /24 must differ.
    assert.notEqual(reduceIp('203.0.114.1'), reduceIp('203.0.113.1'));
  });

  test('IPv6 collapses to /64', () => {
    assert.equal(
      reduceIp('2001:db8:abcd:1234:5678:9abc:def0:1'),
      '2001:db8:abcd:1234::/64',
    );
  });

  test('compressed IPv6 collapses to deterministic /64', () => {
    assert.equal(reduceIp('2001:db8::1'), '2001:db8:0:0::/64');
  });

  test('strips IPv4-mapped IPv6 prefix', () => {
    assert.equal(reduceIp('::ffff:203.0.113.1'), '203.0.113.0/24');
  });

  test('empty / invalid input falls back gracefully', () => {
    assert.equal(reduceIp(''), '');
    assert.equal(reduceIp(null), '');
    assert.equal(reduceIp('not-an-ip'), 'not-an-ip');
    assert.equal(reduceIp('999.999.999.999'), '999.999.999.999');
    assert.equal(reduceIp('1.2.3.4\r\nx: y'), '');
  });
});

describe('input normalization', () => {
  test('normalizeIpInput takes first forwarded value and rejects controls/oversize', () => {
    assert.equal(normalizeIpInput('203.0.113.1, 198.51.100.2'), '203.0.113.1');
    assert.equal(normalizeIpInput(['203.0.113.3']), '203.0.113.3');
    assert.equal(normalizeIpInput('203.0.113.1\r\nx: y'), '');
    assert.equal(normalizeIpInput('1'.repeat(200)), '');
  });

  test('normalizeUserAgent strips controls and caps length', () => {
    const ua = normalizeUserAgent(` Agent\r\nInjected ${'x'.repeat(MAX_UA_LENGTH + 50)}`);
    assert.equal(ua.includes('\n'), false);
    assert.equal(ua.length, MAX_UA_LENGTH);
  });

  test('extractIp prefers safe X-Forwarded-For and falls back to socket', () => {
    assert.equal(extractIp({
      headers: { 'x-forwarded-for': '203.0.113.5, 198.51.100.1' },
      ip: '10.0.0.1',
    }), '203.0.113.5');
    assert.equal(extractIp({
      headers: { 'x-forwarded-for': '203.0.113.5\r\nbad' },
      socket: { remoteAddress: '10.0.0.9' },
    }), '10.0.0.9');
  });

  test('extractUa normalizes request header arrays', () => {
    assert.equal(extractUa({ headers: { 'user-agent': ['  Mozilla/5.0  '] } }), 'Mozilla/5.0');
  });
});

describe('computeFingerprint', () => {
  test('same IP /24 + UA → identical fingerprint (mobile drift OK)', () => {
    const a = computeFingerprint({ ip: '203.0.113.5', ua: 'Mozilla/5.0' });
    const b = computeFingerprint({ ip: '203.0.113.99', ua: 'Mozilla/5.0' });
    assert.equal(a, b);
  });

  test('different /24 → different fingerprint (foreign network)', () => {
    const a = computeFingerprint({ ip: '203.0.113.5', ua: 'Mozilla/5.0' });
    const b = computeFingerprint({ ip: '198.51.100.5', ua: 'Mozilla/5.0' });
    assert.notEqual(a, b);
  });

  test('different UA → different fingerprint (browser swap)', () => {
    const a = computeFingerprint({ ip: '203.0.113.5', ua: 'Chrome/120' });
    const b = computeFingerprint({ ip: '203.0.113.5', ua: 'Firefox/121' });
    assert.notEqual(a, b);
  });

  test('UA case + whitespace normalised', () => {
    const a = computeFingerprint({ ip: '1.2.3.4', ua: '  Mozilla/5.0  ' });
    const b = computeFingerprint({ ip: '1.2.3.4', ua: 'mozilla/5.0' });
    assert.equal(a, b);
  });

  test('reads headers + socket from an Express req shape', () => {
    const req = {
      headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '203.0.113.5' },
      socket: { remoteAddress: '10.0.0.1' },
    };
    const fp = computeFingerprint(req);
    assert.equal(typeof fp, 'string');
    assert.equal(fp.length, 64); // sha256 hex
  });
});

describe('compareFingerprints', () => {
  test('timing-safe equality returns true for identical digests', () => {
    const fp = computeFingerprint({ ip: '1.2.3.4', ua: 'x' });
    assert.equal(compareFingerprints(fp, fp), true);
  });
  test('returns false for differing lengths / values', () => {
    assert.equal(compareFingerprints('abc', 'abcd'), false);
    assert.equal(compareFingerprints('aaaa', 'bbbb'), false);
    assert.equal(compareFingerprints(null, 'x'), false);
  });
});
