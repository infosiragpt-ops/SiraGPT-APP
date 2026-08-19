'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { build, parse, encodeRFC5987 } = require('../src/utils/content-disposition');

describe('build — ASCII filenames', () => {
  test('attachment by default', () => {
    assert.equal(build({ filename: 'a.pdf' }), 'attachment; filename="a.pdf"');
  });
  test('inline type', () => {
    assert.equal(build({ type: 'inline', filename: 'a.pdf' }), 'inline; filename="a.pdf"');
  });
  test('no filename → just type', () => {
    assert.equal(build({}), 'attachment');
  });
  test('escapes embedded quotes + backslash', () => {
    const out = build({ filename: 'he"llo\\.txt' });
    // ASCII fallback escapes " and \, AND because non-ASCII-safe, also emits filename*
    assert.match(out, /filename="he\\"llo\\\\\.txt"/);
    assert.match(out, /filename\*=UTF-8''/);
  });
});

describe('build — Unicode filenames', () => {
  test('non-ASCII triggers RFC 5987 form', () => {
    const out = build({ filename: 'résumé.pdf' });
    assert.match(out, /filename="r_sum_\.pdf"/);
    assert.match(out, /filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/);
  });
  test('CJK filename', () => {
    const out = build({ filename: '报告.pdf' });
    assert.match(out, /filename\*=UTF-8''/);
  });
});

describe('build — guards', () => {
  test('invalid type rejected', () => {
    assert.throws(() => build({ type: 'bad type', filename: 'a' }), TypeError);
  });
  test('empty filename rejected', () => {
    assert.throws(() => build({ filename: '' }), TypeError);
  });
});

describe('parse — basic', () => {
  test('simple attachment', () => {
    const r = parse('attachment; filename="a.pdf"');
    assert.equal(r.type, 'attachment');
    assert.equal(r.parameters.filename, 'a.pdf');
  });
  test('inline no params', () => {
    const r = parse('inline');
    assert.equal(r.type, 'inline');
    assert.deepEqual(r.parameters, {});
  });
  test('case-insensitive type + key', () => {
    const r = parse('ATTACHMENT; FileName="a.pdf"');
    assert.equal(r.type, 'attachment');
    assert.equal(r.parameters.filename, 'a.pdf');
  });
  test('semicolon inside quoted value preserved', () => {
    const r = parse('attachment; filename="weird; name.pdf"');
    assert.equal(r.parameters.filename, 'weird; name.pdf');
  });
  test('escaped quote in value', () => {
    const r = parse('attachment; filename="a\\"b.pdf"');
    assert.equal(r.parameters.filename, 'a"b.pdf');
  });
});

describe('parse — RFC 5987', () => {
  test('UTF-8 percent-encoded filename*', () => {
    const r = parse("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    assert.equal(r.parameters.filename, 'résumé.pdf');
  });
  test('extended form preferred over legacy filename when both present', () => {
    const r = parse(
      'attachment; filename="r_sum_.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf'
    );
    assert.equal(r.parameters.filename, 'résumé.pdf');
  });
});

describe('parse — guards', () => {
  test('non-string rejected', () => {
    assert.throws(() => parse(123), TypeError);
  });
  test('empty string rejected', () => {
    assert.throws(() => parse(''), TypeError);
  });
  test('invalid type token rejected', () => {
    assert.throws(() => parse('bad type'), TypeError);
  });
});

describe('encodeRFC5987', () => {
  test('encodes UTF-8 properly', () => {
    assert.equal(encodeRFC5987('résumé'), 'r%C3%A9sum%C3%A9');
  });
  test('encodes asterisk', () => {
    assert.equal(encodeRFC5987('a*b'), 'a%2Ab');
  });
});

describe('round-trip', () => {
  test('build then parse recovers filename', () => {
    const r = parse(build({ filename: 'café — naïve.pdf' }));
    assert.equal(r.parameters.filename, 'café — naïve.pdf');
  });
  test('round-trip preserves type', () => {
    const r = parse(build({ type: 'inline', filename: 'a.pdf' }));
    assert.equal(r.type, 'inline');
  });
});
