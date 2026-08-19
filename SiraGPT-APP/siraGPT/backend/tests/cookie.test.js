'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { parseCookieHeader, serializeCookie, parseSetCookie, isToken } = require('../src/utils/cookie');

describe('parseCookieHeader', () => {
  test('parses multiple cookies', () => {
    const r = parseCookieHeader('a=1; b=2; c=hello%20world');
    assert.deepEqual(r, { a: '1', b: '2', c: 'hello world' });
  });

  test('handles quoted values', () => {
    const r = parseCookieHeader('foo="bar baz"');
    assert.equal(r.foo, 'bar baz');
  });

  test('skips malformed entries', () => {
    const r = parseCookieHeader('=novalue; valid=ok; nokey;');
    assert.deepEqual(r, { valid: 'ok' });
  });

  test('non-string returns {}', () => {
    assert.deepEqual(parseCookieHeader(null), {});
  });
});

describe('serializeCookie', () => {
  test('basic name=value', () => {
    assert.equal(serializeCookie('sid', 'abc'), 'sid=abc');
  });

  test('URL-encodes the value', () => {
    assert.equal(serializeCookie('q', 'hello world'), 'q=hello%20world');
  });

  test('rejects bad cookie name', () => {
    assert.throws(() => serializeCookie('bad name', 'v'), TypeError);
    assert.throws(() => serializeCookie(';', 'v'), TypeError);
  });

  test('attributes append in standard order', () => {
    const out = serializeCookie('sid', 'abc', {
      domain: 'example.com',
      path: '/',
      maxAge: 3600,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      partitioned: true,
    });
    assert.match(out, /Domain=example\.com/);
    assert.match(out, /Path=\//);
    assert.match(out, /Max-Age=3600/);
    assert.match(out, /HttpOnly/);
    assert.match(out, /Secure/);
    assert.match(out, /SameSite=Lax/);
    assert.match(out, /Partitioned/);
  });

  test('Expires attribute formats UTC', () => {
    const out = serializeCookie('sid', 'x', { expires: new Date('2030-01-01T00:00:00Z') });
    assert.match(out, /Expires=Tue, 01 Jan 2030 00:00:00 GMT/);
  });

  test('SameSite normalizes case + rejects unknown value', () => {
    assert.match(serializeCookie('s', 'v', { sameSite: 'STRICT' }), /SameSite=Strict/);
    const out = serializeCookie('s', 'v', { sameSite: 'unknown' });
    assert.equal(/SameSite=/.test(out), false);
  });
});

describe('parseSetCookie', () => {
  test('extracts name + value + attrs', () => {
    const r = parseSetCookie('sid=abc; Domain=example.com; Path=/; HttpOnly; SameSite=Lax; Max-Age=60');
    assert.equal(r.name, 'sid');
    assert.equal(r.value, 'abc');
    assert.equal(r.attrs.domain, 'example.com');
    assert.equal(r.attrs.path, '/');
    assert.equal(r.attrs.httponly, true);
    assert.equal(r.attrs.samesite, 'lax');
    assert.equal(r.attrs['max-age'], 60);
  });

  test('Expires parsed to Date', () => {
    const r = parseSetCookie('sid=x; Expires=Tue, 01 Jan 2030 00:00:00 GMT');
    assert.ok(r.attrs.expires instanceof Date);
    assert.equal(r.attrs.expires.getUTCFullYear(), 2030);
  });

  test('null on malformed', () => {
    assert.equal(parseSetCookie(''), null);
    assert.equal(parseSetCookie(null), null);
    assert.equal(parseSetCookie('justAttribute'), null);
  });
});

describe('isToken', () => {
  test('valid cookie names', () => {
    for (const n of ['sid', 'session-id', 'a_b', 'A1.b']) assert.equal(isToken(n), true);
  });
  test('invalid names', () => {
    for (const n of ['has space', 'sep;', '', null]) assert.equal(isToken(n), false);
  });
});
