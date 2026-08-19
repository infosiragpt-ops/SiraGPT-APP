'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { distance, ratio, closest } = require('../src/utils/levenshtein');

describe('distance', () => {
  test('identical strings: 0', () => {
    assert.equal(distance('hello', 'hello'), 0);
  });

  test('one insertion: 1', () => {
    assert.equal(distance('cat', 'cats'), 1);
  });

  test('one deletion: 1', () => {
    assert.equal(distance('hello', 'helo'), 1);
  });

  test('one substitution: 1', () => {
    assert.equal(distance('cat', 'bat'), 1);
  });

  test('classic kitten/sitting → 3', () => {
    assert.equal(distance('kitten', 'sitting'), 3);
  });

  test('empty + non-empty = length', () => {
    assert.equal(distance('', 'abc'), 3);
    assert.equal(distance('abc', ''), 3);
  });

  test('non-string inputs are coerced safely', () => {
    assert.equal(distance(null, ''), 0);
    assert.equal(distance(undefined, undefined), 0);
    assert.equal(distance(42, '42'), 0);
  });

  test('maxDist early-exit returns cap+1 when exceeded', () => {
    const d = distance('abcdef', 'zyxwvu', 2);
    assert.equal(d, 3);
  });

  test('maxDist still returns true distance when within cap', () => {
    assert.equal(distance('cat', 'bat', 5), 1);
  });

  test('long-vs-short length-gap exits fast', () => {
    const d = distance('a', 'a'.repeat(50), 10);
    assert.equal(d, 11);
  });
});

describe('ratio', () => {
  test('identical → 1', () => {
    assert.equal(ratio('hi', 'hi'), 1);
  });

  test('totally different short strings → 0 to small fraction', () => {
    const r = ratio('ab', 'cd');
    assert.ok(r >= 0 && r <= 0.5);
  });

  test('two empty strings → 1', () => {
    assert.equal(ratio('', ''), 1);
  });

  test('one-char typo on long string → high ratio', () => {
    const r = ratio('information', 'infomation');
    assert.ok(r > 0.9);
  });
});

describe('closest', () => {
  test('returns matching candidate + distance', () => {
    const r = closest('serch', ['search', 'create', 'list', 'info']);
    assert.equal(r.value, 'search');
    assert.equal(r.distance, 1);
  });

  test('exact match short-circuits with distance 0', () => {
    const r = closest('list', ['search', 'list']);
    assert.equal(r.value, 'list');
    assert.equal(r.distance, 0);
  });

  test('empty candidates returns null', () => {
    assert.equal(closest('x', []), null);
  });

  test('maxDist filter: best below cap returned, otherwise null', () => {
    const ok = closest('search', ['search'], { maxDist: 0 });
    assert.equal(ok.value, 'search');
    const none = closest('totallyDifferent', ['cat', 'dog'], { maxDist: 1 });
    assert.equal(none, null);
  });
});
