'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { expand, parseTemplate } = require('../src/utils/uri-template');

describe('expand — Level 1: simple variable', () => {
  test('basic substitution', () => {
    assert.equal(expand('/users/{id}', { id: 42 }), '/users/42');
  });

  test('reserved chars are percent-encoded', () => {
    assert.equal(expand('/{q}', { q: 'a b/c' }), '/a%20b%2Fc');
  });

  test('undefined var → expression dropped', () => {
    assert.equal(expand('/users/{id}', {}), '/users/');
  });
});

describe('expand — Level 2: reserved + fragment', () => {
  test('+ operator does NOT encode reserved chars', () => {
    assert.equal(expand('/{+path}', { path: '/a/b' }), '//a/b');
  });

  test('# fragment prefix', () => {
    assert.equal(expand('/x{#frag}', { frag: 'top' }), '/x#top');
  });
});

describe('expand — Level 3 operators', () => {
  test('. label expansion', () => {
    assert.equal(expand('img{.fmt}', { fmt: 'png' }), 'img.png');
  });

  test('/ path expansion', () => {
    assert.equal(expand('/a{/segs}', { segs: ['x', 'y'] }), '/a/x,y');
    assert.equal(expand('/a{/segs*}', { segs: ['x', 'y'] }), '/a/x/y');
  });

  test('; path-style param', () => {
    assert.equal(expand('/x{;k}', { k: 'v' }), '/x;k=v');
    assert.equal(expand('/x{;empty}', { empty: '' }), '/x;empty');
  });

  test('? form-style query', () => {
    assert.equal(expand('/x{?a,b}', { a: 1, b: 2 }), '/x?a=1&b=2');
  });

  test('& form-continuation', () => {
    assert.equal(expand('/x?fixed=1{&a}', { a: 'y' }), '/x?fixed=1&a=y');
  });
});

describe('expand — array + object explode', () => {
  test('array exploded into separate query params', () => {
    assert.equal(expand('/x{?tags*}', { tags: ['a', 'b', 'c'] }), '/x?tags=a&tags=b&tags=c');
  });

  test('object exploded into key=value pairs joined by separator', () => {
    const out = expand('/x{?p*}', { p: { foo: 1, bar: 2 } });
    // Order is object-key order; both ok.
    assert.ok(out === '/x?foo=1&bar=2' || out === '/x?bar=2&foo=1');
  });

  test('array without explode joins with comma', () => {
    assert.equal(expand('/x{?tags}', { tags: ['a', 'b'] }), '/x?tags=a,b');
  });
});

describe('expand — prefix modifier', () => {
  test('truncates string to N chars', () => {
    assert.equal(expand('/u/{name:3}', { name: 'alejandro' }), '/u/ale');
  });
});

describe('expand — robustness', () => {
  test('multiple expressions in one template', () => {
    const r = expand('/{a}/{b}', { a: 1, b: 2 });
    assert.equal(r, '/1/2');
  });

  test('empty array drops the expression', () => {
    assert.equal(expand('/x{?tags*}', { tags: [] }), '/x');
  });

  test('null value drops the expression', () => {
    assert.equal(expand('/x{?a,b}', { a: null, b: 2 }), '/x?b=2');
  });

  test('parseTemplate exposes structure', () => {
    const parts = parseTemplate('/a/{id}/b{?q}');
    assert.equal(parts.filter((p) => p.kind === 'expr').length, 2);
  });

  test('unterminated expression throws', () => {
    assert.throws(() => expand('/{noend', {}), TypeError);
  });
});
