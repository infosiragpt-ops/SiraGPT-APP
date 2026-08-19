'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { parseAuthorization, buildBasic, buildBearer } = require('../src/services/auth/http-authorization');

describe('parseAuthorization — Basic', () => {
  test('decodes user:pass', () => {
    const header = 'Basic ' + Buffer.from('alice:secret', 'utf8').toString('base64');
    const r = parseAuthorization(header);
    assert.equal(r.scheme, 'Basic');
    assert.equal(r.user, 'alice');
    assert.equal(r.password, 'secret');
  });

  test('handles empty password', () => {
    const header = 'Basic ' + Buffer.from('alice:', 'utf8').toString('base64');
    const r = parseAuthorization(header);
    assert.equal(r.user, 'alice');
    assert.equal(r.password, '');
  });

  test('case-insensitive scheme', () => {
    const header = 'basic ' + Buffer.from('a:b', 'utf8').toString('base64');
    assert.equal(parseAuthorization(header).scheme, 'Basic');
  });

  test('null when missing colon after decode', () => {
    const header = 'Basic ' + Buffer.from('nocolon', 'utf8').toString('base64');
    assert.equal(parseAuthorization(header), null);
  });
});

describe('parseAuthorization — Bearer', () => {
  test('extracts token', () => {
    const r = parseAuthorization('Bearer abc.def.ghi');
    assert.equal(r.scheme, 'Bearer');
    assert.equal(r.token, 'abc.def.ghi');
  });
  test('case-insensitive scheme', () => {
    assert.equal(parseAuthorization('bearer xyz').scheme, 'Bearer');
  });
});

describe('parseAuthorization — generic (Digest-like)', () => {
  test('parses key=value pairs', () => {
    const r = parseAuthorization('Digest username="alice", realm="x", nonce=abc');
    assert.equal(r.scheme, 'Digest');
    assert.equal(r.params.username, 'alice');
    assert.equal(r.params.realm, 'x');
    assert.equal(r.params.nonce, 'abc');
  });
});

describe('parseAuthorization — degenerate', () => {
  test('non-string → null', () => {
    assert.equal(parseAuthorization(null), null);
  });
  test('empty / no space → null', () => {
    assert.equal(parseAuthorization(''), null);
    assert.equal(parseAuthorization('OnlyScheme'), null);
  });
});

describe('buildBasic', () => {
  test('round-trips through parse', () => {
    const h = buildBasic('alice', 's3cret');
    const back = parseAuthorization(h);
    assert.equal(back.user, 'alice');
    assert.equal(back.password, 's3cret');
  });
  test('rejects user with colon', () => {
    assert.throws(() => buildBasic('a:b', 'x'), TypeError);
  });
  test('rejects non-string args', () => {
    assert.throws(() => buildBasic(null, 'x'), TypeError);
    assert.throws(() => buildBasic('a', 42), TypeError);
  });
});

describe('buildBearer', () => {
  test('formats Bearer <token>', () => {
    assert.equal(buildBearer('abc'), 'Bearer abc');
  });
  test('rejects empty / non-string', () => {
    assert.throws(() => buildBearer(''), TypeError);
    assert.throws(() => buildBearer(null), TypeError);
  });
  test('rejects token with newline (header injection guard)', () => {
    assert.throws(() => buildBearer('abc\r\nX-Inject: x'), TypeError);
  });
});
