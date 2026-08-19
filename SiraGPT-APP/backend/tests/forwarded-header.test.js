'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { parse, parseXForwardedFor, resolveClient } = require('../src/utils/forwarded-header');

function mockReq({ headers = {}, socket = {}, ip } = {}) {
  return { headers, socket, ip };
}

describe('parse — RFC 7239', () => {
  test('single hop', () => {
    const r = parse('for=192.0.2.1;proto=https;host=example.com');
    assert.deepEqual(r, [{ for: '192.0.2.1', proto: 'https', host: 'example.com' }]);
  });

  test('multiple hops comma-separated', () => {
    const r = parse('for=10.0.0.1, for=10.0.0.2');
    assert.equal(r.length, 2);
    assert.equal(r[0].for, '10.0.0.1');
    assert.equal(r[1].for, '10.0.0.2');
  });

  test('quoted value with embedded characters', () => {
    const r = parse('for="[2001:db8::1]:443";proto=https');
    assert.equal(r[0].for, '[2001:db8::1]:443');
    assert.equal(r[0].proto, 'https');
  });

  test('escaped quote inside quoted value', () => {
    const r = parse('by="he\\"y"');
    assert.equal(r[0].by, 'he"y');
  });

  test('empty / non-string → []', () => {
    assert.deepEqual(parse(''), []);
    assert.deepEqual(parse(null), []);
  });

  test('case-insensitive parameter names', () => {
    const r = parse('FOR=1.2.3.4;Proto=HTTPS');
    assert.equal(r[0].for, '1.2.3.4');
    assert.equal(r[0].proto, 'HTTPS');
  });
});

describe('parseXForwardedFor', () => {
  test('comma list', () => {
    assert.deepEqual(parseXForwardedFor('1.1.1.1, 2.2.2.2 , 3.3.3.3'), ['1.1.1.1', '2.2.2.2', '3.3.3.3']);
  });
  test('empty / non-string', () => {
    assert.deepEqual(parseXForwardedFor(''), []);
    assert.deepEqual(parseXForwardedFor(null), []);
  });
});

describe('resolveClient — RFC 7239 path', () => {
  test('trustHops=0 picks rightmost (proxy itself)', () => {
    const req = mockReq({
      headers: { forwarded: 'for=1.1.1.1, for=2.2.2.2, for=3.3.3.3' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const r = resolveClient(req, { trustHops: 0 });
    assert.equal(r.ip, '3.3.3.3');
  });

  test('trustHops=1 skips one proxy', () => {
    const req = mockReq({
      headers: { forwarded: 'for=1.1.1.1, for=2.2.2.2, for=3.3.3.3' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const r = resolveClient(req, { trustHops: 1 });
    assert.equal(r.ip, '2.2.2.2');
  });

  test('trustHops far exceeds chain → clamps to leftmost', () => {
    const req = mockReq({
      headers: { forwarded: 'for=1.1.1.1, for=2.2.2.2' },
    });
    const r = resolveClient(req, { trustHops: 999 });
    assert.equal(r.ip, '1.1.1.1');
  });

  test('proto + host extracted from selected hop', () => {
    const req = mockReq({
      headers: { forwarded: 'for=1.1.1.1;proto=https;host=api.example.com' },
    });
    const r = resolveClient(req, { trustHops: 0 });
    assert.equal(r.proto, 'https');
    assert.equal(r.host, 'api.example.com');
  });

  test('strips port from for-value', () => {
    const req = mockReq({
      headers: { forwarded: 'for="1.2.3.4:5050"' },
    });
    const r = resolveClient(req, { trustHops: 0 });
    assert.equal(r.ip, '1.2.3.4');
  });

  test('strips port from IPv6 bracketed for-value', () => {
    const req = mockReq({
      headers: { forwarded: 'for="[2001:db8::1]:443"' },
    });
    const r = resolveClient(req, { trustHops: 0 });
    assert.equal(r.ip, '2001:db8::1');
  });
});

describe('resolveClient — fallback to X-Forwarded-*', () => {
  test('uses XFF when Forwarded absent', () => {
    const req = mockReq({
      headers: {
        'x-forwarded-for': '1.1.1.1, 2.2.2.2',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'public.example.com',
        host: 'internal:3000',
      },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const r = resolveClient(req, { trustHops: 0 });
    assert.equal(r.ip, '2.2.2.2');
    assert.equal(r.proto, 'https');
    assert.equal(r.host, 'public.example.com');
  });

  test('falls all the way back to socket + Host header', () => {
    const req = mockReq({
      headers: { host: 'internal:3000' },
      socket: { remoteAddress: '127.0.0.1', encrypted: true },
    });
    const r = resolveClient(req);
    assert.equal(r.ip, '127.0.0.1');
    assert.equal(r.proto, 'https');
    assert.equal(r.host, 'internal:3000');
  });

  test('Forwarded header wins over X-Forwarded-* if both present', () => {
    const req = mockReq({
      headers: {
        forwarded: 'for=9.9.9.9;proto=https;host=fwd.example',
        'x-forwarded-for': '1.1.1.1',
        'x-forwarded-host': 'xff.example',
      },
    });
    const r = resolveClient(req, { trustHops: 0 });
    assert.equal(r.ip, '9.9.9.9');
    assert.equal(r.host, 'fwd.example');
  });
});
