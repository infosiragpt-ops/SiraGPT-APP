'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { slugify, isSlug, defaultMap } = require('../src/utils/slugify');

describe('slugify — basic', () => {
  test('lowercases and replaces spaces', () => {
    assert.equal(slugify('Hello World'), 'hello-world');
  });
  test('strips punctuation', () => {
    assert.equal(slugify('Hello, World!'), 'hello-world');
  });
  test('collapses runs of separators', () => {
    assert.equal(slugify('a   b---c'), 'a-b-c');
  });
  test('trims leading/trailing separator', () => {
    assert.equal(slugify('---hello---'), 'hello');
  });
  test('empty / non-string → ""', () => {
    assert.equal(slugify(''), '');
    assert.equal(slugify(null), '');
  });
});

describe('slugify — Unicode normalization', () => {
  test('strips accents (NFD + drop marks)', () => {
    assert.equal(slugify('résumé'), 'resume');
    assert.equal(slugify('niño'), 'nino');
    assert.equal(slugify('über'), 'uber');
  });

  test('default map handles ß / æ / ø / ł', () => {
    assert.equal(slugify('straße'), 'strasse');
    assert.equal(slugify('æthelred'), 'aethelred');
    assert.equal(slugify('Søren'), 'soren');
  });

  test('& becomes "and"', () => {
    assert.equal(slugify('R&B Music'), 'r-and-b-music');
  });

  test('emoji and other unmappable chars drop', () => {
    assert.equal(slugify('Hello 🎉 World'), 'hello-world');
  });
});

describe('slugify — options', () => {
  test('custom separator', () => {
    assert.equal(slugify('hello world', { separator: '_' }), 'hello_world');
  });

  test('custom map overlay', () => {
    const custom = new Map([['*', 'star']]);
    assert.equal(slugify('5*', { custom }), '5-star');
  });

  test('maxLength truncates without trailing sep', () => {
    const r = slugify('hello-world-foo-bar', { maxLength: 11 });
    assert.equal(r, 'hello-world');
  });

  test('falsy separator falls back to "-"', () => {
    assert.equal(slugify('hello world', { separator: '' }), 'hello-world');
  });
});

describe('isSlug', () => {
  test('positive examples', () => {
    assert.equal(isSlug('hello-world'), true);
    assert.equal(isSlug('a1-b2-c3'), true);
    assert.equal(isSlug('single'), true);
  });
  test('negative examples', () => {
    assert.equal(isSlug('Hello'), false);          // uppercase
    assert.equal(isSlug('-hello'), false);         // leading sep
    assert.equal(isSlug('hello-'), false);         // trailing sep
    assert.equal(isSlug('hello--world'), false);   // double sep
    assert.equal(isSlug(''), false);
    assert.equal(isSlug(null), false);
  });
  test('custom separator respected', () => {
    assert.equal(isSlug('hello_world', { separator: '_' }), true);
    assert.equal(isSlug('hello-world', { separator: '_' }), false);
  });
});

describe('defaultMap export', () => {
  test('contains the documented entries', () => {
    for (const k of ['ß', 'æ', 'ø', '&']) assert.ok(defaultMap.has(k));
  });
});
