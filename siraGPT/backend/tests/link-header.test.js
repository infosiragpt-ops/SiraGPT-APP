'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { parse, build, findRel } = require('../src/utils/link-header');

describe('parse', () => {
  test('single link with rel', () => {
    const r = parse('</next>; rel="next"');
    assert.deepEqual(r, [{ uri: '/next', rel: 'next' }]);
  });

  test('multiple links comma-separated', () => {
    const r = parse('</a>; rel="next", </b>; rel="prev"');
    assert.equal(r.length, 2);
    assert.equal(r[0].uri, '/a'); assert.equal(r[0].rel, 'next');
    assert.equal(r[1].uri, '/b'); assert.equal(r[1].rel, 'prev');
  });

  test('extra parameters preserved (title, type)', () => {
    const r = parse('</p>; rel="next"; title="Page 2"; type="text/html"');
    assert.equal(r[0].title, 'Page 2');
    assert.equal(r[0].type, 'text/html');
  });

  test('multi-rel expands to multiple entries', () => {
    const r = parse('</x>; rel="next first"');
    assert.equal(r.length, 2);
    assert.equal(r[0].rel, 'next');
    assert.equal(r[1].rel, 'first');
    assert.equal(r[0].uri, r[1].uri);
  });

  test('comma inside angle brackets does not split', () => {
    const r = parse('<https://api/x?a=1,b=2>; rel="self"');
    assert.equal(r.length, 1);
    assert.equal(r[0].uri, 'https://api/x?a=1,b=2');
  });

  test('escaped quote inside quoted value', () => {
    const r = parse('</x>; rel="next"; title="he said \\"hi\\""');
    assert.equal(r[0].title, 'he said "hi"');
  });

  test('case-insensitive parameter names', () => {
    const r = parse('</x>; REL="next"; Title="P"');
    assert.equal(r[0].rel, 'next');
    assert.equal(r[0].title, 'P');
  });

  test('non-string / empty input → []', () => {
    assert.deepEqual(parse(''), []);
    assert.deepEqual(parse(null), []);
  });

  test('malformed entries skipped', () => {
    const r = parse('not-a-link, </ok>; rel="next"');
    assert.equal(r.length, 1);
    assert.equal(r[0].rel, 'next');
  });
});

describe('build', () => {
  test('single link', () => {
    const h = build([{ uri: '/next', rel: 'next' }]);
    assert.equal(h, '</next>; rel="next"');
  });

  test('multiple links joined with comma', () => {
    const h = build([
      { uri: '/a', rel: 'next' },
      { uri: '/b', rel: 'prev' },
    ]);
    assert.equal(h, '</a>; rel="next", </b>; rel="prev"');
  });

  test('rel as array joined by space', () => {
    const h = build([{ uri: '/x', rel: ['next', 'first'] }]);
    assert.equal(h, '</x>; rel="next first"');
  });

  test('escapes embedded quote and backslash', () => {
    const h = build([{ uri: '/x', rel: 'next', title: 'a"b\\c' }]);
    assert.match(h, /title="a\\"b\\\\c"/);
  });

  test('rejects non-array input', () => {
    assert.throws(() => build(null), TypeError);
  });

  test('rejects entry without uri', () => {
    assert.throws(() => build([{ rel: 'next' }]), TypeError);
  });
});

describe('findRel', () => {
  test('returns matching link', () => {
    const links = parse('</a>; rel="next", </b>; rel="prev"');
    assert.equal(findRel(links, 'next').uri, '/a');
    assert.equal(findRel(links, 'prev').uri, '/b');
  });

  test('returns undefined when not found', () => {
    assert.equal(findRel([], 'next'), undefined);
  });
});

describe('round-trip', () => {
  test('parse(build(x)) preserves uri + rel', () => {
    const original = [
      { uri: '/a', rel: 'next', title: 'Next page' },
      { uri: '/b', rel: 'prev' },
    ];
    const r = parse(build(original));
    assert.equal(r[0].uri, '/a');
    assert.equal(r[0].rel, 'next');
    assert.equal(r[0].title, 'Next page');
    assert.equal(r[1].uri, '/b');
    assert.equal(r[1].rel, 'prev');
  });
});
