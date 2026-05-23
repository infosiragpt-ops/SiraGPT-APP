'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { parseAccept, negotiate, isMatch } = require('../src/utils/accept-negotiator');

describe('parseAccept', () => {
  test('default to */* when empty / null', () => {
    assert.deepEqual(parseAccept('').map((e) => `${e.type}/${e.subtype}`), ['*/*']);
    assert.deepEqual(parseAccept(null).map((e) => `${e.type}/${e.subtype}`), ['*/*']);
  });

  test('parses single concrete type', () => {
    const e = parseAccept('application/json');
    assert.equal(e[0].type, 'application');
    assert.equal(e[0].subtype, 'json');
    assert.equal(e[0].q, 1);
  });

  test('parses q-value', () => {
    const e = parseAccept('text/html;q=0.8');
    assert.equal(e[0].q, 0.8);
  });

  test('multiple comma-separated', () => {
    const e = parseAccept('text/html, application/json;q=0.9, */*;q=0.5');
    assert.equal(e.length, 3);
  });

  test('out-of-range q clamped to default', () => {
    assert.equal(parseAccept('text/html;q=2').at(0).q, 1);
    assert.equal(parseAccept('text/html;q=-0.1').at(0).q, 1);
  });
});

describe('isMatch', () => {
  test('exact match', () => {
    assert.equal(isMatch({ type: 'application', subtype: 'json' }, 'application/json'), true);
  });
  test('subtype wildcard', () => {
    assert.equal(isMatch({ type: 'text', subtype: '*' }, 'text/html'), true);
  });
  test('type wildcard', () => {
    assert.equal(isMatch({ type: '*', subtype: '*' }, 'whatever/foo'), true);
  });
  test('mismatch type', () => {
    assert.equal(isMatch({ type: 'image', subtype: '*' }, 'text/html'), false);
  });
});

describe('negotiate', () => {
  test('returns highest-q matching server type', () => {
    const r = negotiate(['application/json', 'text/html'], 'text/html;q=0.5, application/json;q=0.9');
    assert.equal(r, 'application/json');
  });

  test('exact subtype beats wildcard', () => {
    const r = negotiate(['application/json'], '*/*;q=0.5, application/json;q=0.5');
    assert.equal(r, 'application/json');
  });

  test('q=0 excludes a type', () => {
    const r = negotiate(['application/json', 'text/html'], 'application/json;q=0, text/html');
    assert.equal(r, 'text/html');
  });

  test('server preference weight breaks q-tie', () => {
    const r = negotiate([['text/html', 0.9], ['application/json', 1]], 'text/html, application/json');
    assert.equal(r, 'application/json');
  });

  test('no match → null', () => {
    const r = negotiate(['image/png'], 'application/json');
    assert.equal(r, null);
  });

  test('empty server list → null', () => {
    assert.equal(negotiate([], 'application/json'), null);
  });

  test('header absent → first server type wins (catch-all */*)', () => {
    const r = negotiate(['application/json', 'text/html'], '');
    assert.equal(r, 'application/json');
  });
});
