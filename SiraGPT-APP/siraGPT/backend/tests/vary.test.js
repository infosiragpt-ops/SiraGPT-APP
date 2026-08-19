'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { parse, append, isWildcard, cacheKey } = require('../src/utils/vary');

describe('parse', () => {
  test('comma-separated, lower-cased, deduped', () => {
    assert.deepEqual(parse('Accept, Accept, Accept-Encoding'), ['accept', 'accept-encoding']);
  });
  test('* short-circuits', () => {
    assert.deepEqual(parse('Accept, *, Accept-Language'), ['*']);
  });
  test('empty / non-string → []', () => {
    assert.deepEqual(parse(''), []);
    assert.deepEqual(parse(null), []);
  });
});

describe('append', () => {
  test('adds new field', () => {
    assert.equal(append('Accept', 'Accept-Encoding'), 'accept, accept-encoding');
  });
  test('does not duplicate', () => {
    assert.equal(append('Accept', 'accept'), 'accept');
  });
  test('appending to * stays *', () => {
    assert.equal(append('*', 'Accept'), '*');
  });
  test('appending * to specific header collapses to *', () => {
    assert.equal(append('Accept', '*'), '*');
  });
  test('accepts array', () => {
    assert.equal(append('', ['A', 'B', 'A']), 'a, b');
  });
});

describe('isWildcard', () => {
  test('Vary: * is wildcard', () => {
    assert.equal(isWildcard('*'), true);
  });
  test('Vary: Accept is not', () => {
    assert.equal(isWildcard('Accept'), false);
  });
});

describe('cacheKey', () => {
  test('basic key structure', () => {
    const k = cacheKey('GET', '/x', 'Accept', { accept: 'text/html' });
    assert.match(k, /^GET \/x/);
    assert.match(k, /accept=text\/html/);
  });

  test('no Vary → URL-only key', () => {
    const k1 = cacheKey('GET', '/x', '', { accept: 'foo' });
    const k2 = cacheKey('GET', '/x', '', { accept: 'bar' });
    assert.equal(k1, k2);
  });

  test('different Vary value → different key', () => {
    const k1 = cacheKey('GET', '/x', 'Accept-Encoding', { 'accept-encoding': 'gzip' });
    const k2 = cacheKey('GET', '/x', 'Accept-Encoding', { 'accept-encoding': 'br' });
    assert.notEqual(k1, k2);
  });

  test('Accept ordering normalized → same key', () => {
    const k1 = cacheKey('GET', '/x', 'Accept', { accept: 'text/html, application/json' });
    const k2 = cacheKey('GET', '/x', 'Accept', { accept: 'application/json, text/html' });
    assert.equal(k1, k2);
  });

  test('case-insensitive header lookup', () => {
    const k1 = cacheKey('GET', '/x', 'Accept', { accept: 'a' });
    const k2 = cacheKey('GET', '/x', 'Accept', { Accept: 'a' });
    assert.equal(k1, k2);
  });

  test('method affects key', () => {
    const k1 = cacheKey('GET', '/x', '', {});
    const k2 = cacheKey('POST', '/x', '', {});
    assert.notEqual(k1, k2);
  });

  test('Vary: * → unique key per call', () => {
    const k1 = cacheKey('GET', '/x', '*', { a: 1 });
    const k2 = cacheKey('GET', '/x', '*', { a: 1 });
    assert.notEqual(k1, k2, 'wildcard means uncacheable across requests');
  });

  test('missing header gets empty string segment, still deterministic', () => {
    const k1 = cacheKey('GET', '/x', 'Authorization', {});
    const k2 = cacheKey('GET', '/x', 'Authorization', {});
    assert.equal(k1, k2);
  });
});
