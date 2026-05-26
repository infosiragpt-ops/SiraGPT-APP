'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { parseContentType, formatContentType, charsetOf, isType } = require('../src/utils/content-type');

describe('parseContentType', () => {
  test('plain type/subtype', () => {
    assert.deepEqual(parseContentType('text/html'), { type: 'text', subtype: 'html', parameters: {} });
  });

  test('lowercases names', () => {
    const r = parseContentType('TEXT/HTML;CHARSET=UTF-8');
    assert.equal(r.type, 'text');
    assert.equal(r.subtype, 'html');
    assert.equal(r.parameters.charset, 'UTF-8'); // value preserved as-is
  });

  test('parses charset', () => {
    const r = parseContentType('text/html; charset=utf-8');
    assert.equal(r.parameters.charset, 'utf-8');
  });

  test('multipart boundary with quoted value', () => {
    const r = parseContentType('multipart/form-data; boundary="ab\\"c"');
    assert.equal(r.parameters.boundary, 'ab"c');
  });

  test('preserves semicolons inside quoted parameter values', () => {
    const r = parseContentType('multipart/form-data; boundary="part;still-boundary"; charset=utf-8');
    assert.equal(r.parameters.boundary, 'part;still-boundary');
    assert.equal(r.parameters.charset, 'utf-8');
  });

  test('rejects duplicate parameters', () => {
    assert.equal(parseContentType('text/plain; charset=utf-8; CHARSET=iso-8859-1'), null);
  });

  test('rejects malformed quoted parameters', () => {
    assert.equal(parseContentType('text/plain; charset="unterminated'), null);
    assert.equal(parseContentType('text/plain; charset=utf-8"'), null);
  });

  test('rejects malformed parameter names and empty values', () => {
    assert.equal(parseContentType('text/plain; bad name=utf-8'), null);
    assert.equal(parseContentType('text/plain; charset='), null);
  });

  test('rejects malformed', () => {
    assert.equal(parseContentType(''), null);
    assert.equal(parseContentType(null), null);
    assert.equal(parseContentType('no-slash'), null);
    assert.equal(parseContentType('text/'), null);
  });
});

describe('formatContentType', () => {
  test('emits canonical with sorted parameters', () => {
    const out = formatContentType({ type: 'text', subtype: 'html', parameters: { charset: 'utf-8', boundary: 'B' } });
    assert.equal(out, 'text/html; boundary=B; charset=utf-8');
  });

  test('quotes parameters with token-unsafe chars', () => {
    const out = formatContentType({ type: 'multipart', subtype: 'form-data', parameters: { boundary: 'with space' } });
    assert.match(out, /boundary="with space"/);
  });

  test('escapes backslash and quote inside quoted value', () => {
    const out = formatContentType({ type: 'a', subtype: 'b', parameters: { p: 'he said "hi"' } });
    assert.match(out, /p="he said \\"hi\\""/);
  });

  test('omits empty params', () => {
    const out = formatContentType({ type: 'a', subtype: 'b', parameters: { x: '', y: null } });
    assert.equal(out, 'a/b');
  });

  test('throws on missing type/subtype', () => {
    assert.throws(() => formatContentType({}), TypeError);
    assert.throws(() => formatContentType(null), TypeError);
  });
});

describe('round-trip', () => {
  test('parse → format produces canonical form', () => {
    const a = formatContentType(parseContentType('text/html;charset=utf-8;boundary=X'));
    const b = formatContentType(parseContentType('text/html; boundary=X; charset=utf-8'));
    assert.equal(a, b);
  });
});

describe('charsetOf', () => {
  test('extracts charset', () => {
    assert.equal(charsetOf('text/html; charset=utf-8'), 'utf-8');
  });
  test('returns fallback when missing', () => {
    assert.equal(charsetOf('text/html', 'utf-8'), 'utf-8');
    assert.equal(charsetOf(null, 'utf-8'), 'utf-8');
  });
});

describe('isType', () => {
  test('exact match', () => {
    assert.equal(isType('application/json', 'application/json'), true);
  });
  test('subtype wildcard', () => {
    assert.equal(isType('text/plain', 'text/*'), true);
  });
  test('type wildcard', () => {
    assert.equal(isType('image/png', '*/png'), true);
  });
  test('mismatch', () => {
    assert.equal(isType('image/png', 'text/*'), false);
  });
  test('bad inputs', () => {
    assert.equal(isType(null, 'text/*'), false);
    assert.equal(isType('text/html', 'no-slash'), false);
  });
});
