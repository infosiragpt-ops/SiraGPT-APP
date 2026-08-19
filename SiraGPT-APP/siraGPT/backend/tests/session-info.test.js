/**
 * session-info — verifies the maskIp / parseUA helpers used by
 * /api/auth/sessions. Both must be total (no throws on weird input) and
 * must not leak full client IPs.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { maskIp, parseUA } = require('../src/utils/session-info');

describe('session-info — maskIp', () => {
  test('drops the last octet of IPv4', () => {
    assert.equal(maskIp('198.51.100.42'), '198.51.100.x');
  });

  test('strips port suffix before masking', () => {
    assert.equal(maskIp('198.51.100.42:54321'), '198.51.100.x');
  });

  test('handles IPv4-mapped IPv6 prefix', () => {
    assert.equal(maskIp('::ffff:198.51.100.42'), '198.51.100.x');
  });

  test('masks IPv6 to /48 with placeholder', () => {
    assert.equal(maskIp('2001:db8:1234:5678::1'), '2001:db8:1234::x');
  });

  test('returns null for empty / non-string', () => {
    assert.equal(maskIp(null), null);
    assert.equal(maskIp(undefined), null);
    assert.equal(maskIp(''), null);
    assert.equal(maskIp(42), null);
  });

  test('falls back to "unknown" for garbage', () => {
    assert.equal(maskIp('not-an-ip'), 'unknown');
  });
});

describe('session-info — parseUA', () => {
  test('returns stable shape for null/missing UA', () => {
    const r = parseUA(null);
    assert.equal(r.browser, 'Unknown');
    assert.equal(r.os, 'Unknown');
    assert.equal(r.device, 'desktop');
    assert.equal(r.raw, null);
  });

  test('detects Chrome on Windows 10', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
    const r = parseUA(ua);
    assert.equal(r.browser, 'Chrome');
    assert.equal(r.os, 'Windows 10');
    assert.equal(r.device, 'desktop');
  });

  test('detects Safari on iPhone as mobile', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Safari/604.1';
    const r = parseUA(ua);
    assert.equal(r.browser, 'Safari');
    assert.equal(r.os, 'iOS');
    assert.equal(r.device, 'mobile');
  });

  test('detects Firefox on Linux', () => {
    const r = parseUA('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0');
    assert.equal(r.browser, 'Firefox');
    assert.equal(r.os, 'Linux');
  });

  test('detects Edge over Chrome (precedence)', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
    assert.equal(parseUA(ua).browser, 'Edge');
  });

  test('caps overly long raw UA string', () => {
    const huge = 'X'.repeat(500);
    const r = parseUA(huge);
    assert.ok(r.raw.length <= 201);
    assert.ok(r.raw.endsWith('…'));
  });
});
