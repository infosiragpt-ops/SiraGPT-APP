'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { parseCsv, serializeCsv, escapeField } = require('../src/utils/csv');

describe('parseCsv — happy path', () => {
  test('headers default to first row', () => {
    const r = parseCsv('a,b\n1,2\n3,4');
    assert.deepEqual(r.headers, ['a', 'b']);
    assert.deepEqual(r.rows, [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  test('headers:false returns raw arrays', () => {
    const r = parseCsv('a,b\n1,2', { headers: false });
    assert.equal(r.headers, null);
    assert.deepEqual(r.rows, [['a', 'b'], ['1', '2']]);
  });

  test('caller-supplied headers override row 1', () => {
    const r = parseCsv('1,2\n3,4', { headers: ['x', 'y'] });
    assert.deepEqual(r.headers, ['x', 'y']);
    assert.deepEqual(r.rows, [{ x: '1', y: '2' }, { x: '3', y: '4' }]);
  });

  test('CRLF line endings handled', () => {
    const r = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    assert.equal(r.rows.length, 2);
  });

  test('trim:true strips field whitespace', () => {
    const r = parseCsv('a,b\n  1  ,  2  ', { trim: true });
    assert.deepEqual(r.rows[0], { a: '1', b: '2' });
  });
});

describe('parseCsv — quoted fields', () => {
  test('embedded comma in quoted field', () => {
    const r = parseCsv('a,b\n"hello, world",2');
    assert.equal(r.rows[0].a, 'hello, world');
  });

  test('escaped quote inside quoted field', () => {
    const r = parseCsv('a\n"she said ""hi"""');
    assert.equal(r.rows[0].a, 'she said "hi"');
  });

  test('embedded newline in quoted field', () => {
    const r = parseCsv('a,b\n"line1\nline2",2');
    assert.equal(r.rows[0].a, 'line1\nline2');
  });

  test('CRLF inside quoted field preserved', () => {
    const r = parseCsv('a,b\r\n"with\r\ncrlf",2\r\n');
    assert.equal(r.rows[0].a, 'with\r\ncrlf');
  });
});

describe('parseCsv — edge cases', () => {
  test('empty input → no rows', () => {
    assert.deepEqual(parseCsv('').rows, []);
  });

  test('non-string returns empty', () => {
    assert.deepEqual(parseCsv(null).rows, []);
  });

  test('TSV via custom delimiter', () => {
    const r = parseCsv('a\tb\n1\t2', { delimiter: '\t' });
    assert.deepEqual(r.rows[0], { a: '1', b: '2' });
  });

  test('trailing newline does not create an empty row', () => {
    const r = parseCsv('a,b\n1,2\n', { headers: false });
    assert.equal(r.rows.length, 2);
  });
});

describe('escapeField', () => {
  test('quotes when comma / quote / newline present', () => {
    assert.equal(escapeField('a,b', ','), '"a,b"');
    assert.equal(escapeField('a"b', ','), '"a""b"');
    assert.equal(escapeField('a\nb', ','), '"a\nb"');
  });
  test('plain text unchanged', () => {
    assert.equal(escapeField('hello', ','), 'hello');
  });
  test('null/undefined → empty', () => {
    assert.equal(escapeField(null, ','), '');
    assert.equal(escapeField(undefined, ','), '');
  });
});

describe('serializeCsv', () => {
  test('array of objects → header + rows with CRLF', () => {
    const out = serializeCsv([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
    assert.match(out, /^a,b\r\n1,2\r\n3,4\r\n$/);
  });

  test('caller headers override key discovery', () => {
    const out = serializeCsv([{ a: 1, b: 2, c: 3 }], { headers: ['c', 'a'] });
    assert.match(out, /^c,a\r\n3,1\r\n$/);
  });

  test('array of arrays: no header line', () => {
    const out = serializeCsv([[1, 2], [3, 4]]);
    assert.equal(out, '1,2\r\n3,4\r\n');
  });

  test('quotes fields when needed', () => {
    const out = serializeCsv([['a,b', 'c"d', 'plain']]);
    assert.equal(out, '"a,b","c""d",plain\r\n');
  });

  test('custom delimiter + eol', () => {
    const out = serializeCsv([['a', 'b']], { delimiter: '\t', eol: '\n' });
    assert.equal(out, 'a\tb\n');
  });

  test('empty rows → empty string', () => {
    assert.equal(serializeCsv([]), '');
  });
});

describe('round-trip', () => {
  test('parse → serialize → parse preserves data', () => {
    const original = 'name,note\nAlice,"Hello, world"\nBob,"with ""quotes"""\r\n';
    const a = parseCsv(original);
    const back = serializeCsv(a.rows, { headers: a.headers });
    const b = parseCsv(back);
    assert.deepEqual(b.rows, a.rows);
  });
});
