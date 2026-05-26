'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  parseIp,
  parseCidr,
  cidrContains,
  anyContains,
  isValidIp,
  isValidCidr,
} = require('../src/utils/ip-cidr');

describe('parseIp', () => {
  test('IPv4 happy path', () => {
    const ip = parseIp('192.168.1.1');
    assert.equal(ip.version, 4);
    assert.equal(ip.value, 0xc0a80101n);
  });

  test('IPv4 rejects bad octets', () => {
    assert.equal(parseIp('300.1.1.1'), null);
    assert.equal(parseIp('1.1.1'), null);
    assert.equal(parseIp(''), null);
    assert.equal(parseIp(null), null);
  });

  test('IPv6 full form', () => {
    const ip = parseIp('2001:db8:85a3:0:0:8a2e:370:7334');
    assert.equal(ip.version, 6);
    assert.ok(ip.value > 0n);
  });

  test('IPv6 :: shorthand', () => {
    const a = parseIp('2001:db8::1');
    const b = parseIp('2001:db8:0:0:0:0:0:1');
    assert.equal(a.value, b.value);
  });

  test('IPv6 :: at start / end', () => {
    assert.ok(parseIp('::1'));
    assert.ok(parseIp('1::'));
    assert.ok(parseIp('::'));
  });

  test('IPv6 rejects two ::', () => {
    assert.equal(parseIp('2001::db8::1'), null);
  });

  test('IPv6 strips zone id', () => {
    assert.ok(parseIp('fe80::1%eth0'));
  });
});

describe('parseCidr', () => {
  test('IPv4 /24 normalizes base to network address', () => {
    const c = parseCidr('192.168.1.42/24');
    assert.equal(c.bits, 24);
    assert.equal(c.version, 4);
    // 192.168.1.0 = 0xc0a80100
    assert.equal(c.base, 0xc0a80100n);
  });

  test('IPv6 /64', () => {
    const c = parseCidr('2001:db8::/64');
    assert.equal(c.bits, 64);
    assert.equal(c.version, 6);
  });

  test('rejects bad format', () => {
    assert.equal(parseCidr('192.168.1.1'), null);
    assert.equal(parseCidr('192.168.1.1/33'), null);
    assert.equal(parseCidr('::1/129'), null);
    assert.equal(parseCidr('not-cidr'), null);
  });
});

describe('cidrContains', () => {
  test('IPv4 inclusion', () => {
    assert.equal(cidrContains('10.0.0.0/8', '10.5.5.5'), true);
    assert.equal(cidrContains('10.0.0.0/8', '11.0.0.1'), false);
  });

  test('IPv4 /32 single host', () => {
    assert.equal(cidrContains('1.2.3.4/32', '1.2.3.4'), true);
    assert.equal(cidrContains('1.2.3.4/32', '1.2.3.5'), false);
  });

  test('IPv4 /0 matches everything', () => {
    assert.equal(cidrContains('0.0.0.0/0', '8.8.8.8'), true);
  });

  test('IPv6 inclusion', () => {
    assert.equal(cidrContains('2001:db8::/32', '2001:db8:1234::1'), true);
    assert.equal(cidrContains('2001:db8::/32', '2001:db9::1'), false);
  });

  test('cross-version rejected', () => {
    assert.equal(cidrContains('10.0.0.0/8', '::1'), false);
    assert.equal(cidrContains('::/0', '10.0.0.1'), false);
  });

  test('bad inputs return false (no throw)', () => {
    assert.equal(cidrContains('garbage', '10.0.0.1'), false);
    assert.equal(cidrContains('10.0.0.0/8', null), false);
  });
});

describe('anyContains', () => {
  test('returns true if any list entry matches', () => {
    const list = ['10.0.0.0/8', '192.168.0.0/16'];
    assert.equal(anyContains(list, '192.168.5.5'), true);
    assert.equal(anyContains(list, '8.8.8.8'), false);
  });

  test('non-array → false', () => {
    assert.equal(anyContains(null, '10.0.0.1'), false);
  });
});

describe('isValid* helpers', () => {
  test('isValidIp / isValidCidr cover both versions', () => {
    assert.equal(isValidIp('1.2.3.4'), true);
    assert.equal(isValidIp('::1'), true);
    assert.equal(isValidIp('foo'), false);
    assert.equal(isValidCidr('10.0.0.0/24'), true);
    assert.equal(isValidCidr('foo'), false);
  });
});
