'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { pluralize, singularize, plural, singular, addIrregular, UNCOUNTABLE } = require('../src/utils/pluralize');

describe('plural', () => {
  test('regular -s', () => {
    assert.equal(plural('cat'), 'cats');
    assert.equal(plural('book'), 'books');
  });
  test('-y → -ies after consonant', () => {
    assert.equal(plural('city'), 'cities');
    assert.equal(plural('berry'), 'berries');
  });
  test('-y stays after vowel', () => {
    assert.equal(plural('boy'), 'boys');
  });
  test('-x/-ch/-sh/-ss → -es', () => {
    assert.equal(plural('box'), 'boxes');
    assert.equal(plural('match'), 'matches');
    assert.equal(plural('bush'), 'bushes');
    assert.equal(plural('class'), 'classes');
  });
  test('-fe/-f → -ves', () => {
    assert.equal(plural('knife'), 'knives');
    assert.equal(plural('wolf'), 'wolves');
  });
  test('irregulars', () => {
    assert.equal(plural('child'), 'children');
    assert.equal(plural('mouse'), 'mice');
    assert.equal(plural('person'), 'people');
    assert.equal(plural('analysis'), 'analyses');
  });
  test('uncountables identity', () => {
    assert.equal(plural('information'), 'information');
    assert.equal(plural('fish'), 'fish');
  });
  test('empty / non-string → ""', () => {
    assert.equal(plural(''), '');
    assert.equal(plural(null), '');
  });
});

describe('singular', () => {
  test('regular -s removed', () => {
    assert.equal(singular('cats'), 'cat');
  });
  test('-ies → -y', () => {
    assert.equal(singular('cities'), 'city');
    assert.equal(singular('berries'), 'berry');
  });
  test('-ves → -f/-fe', () => {
    assert.equal(singular('knives'), 'knife');
    assert.equal(singular('wolves'), 'wolf');
  });
  test('-es removed for x/ch/sh/ss', () => {
    assert.equal(singular('boxes'), 'box');
    assert.equal(singular('matches'), 'match');
  });
  test('irregulars (reverse map)', () => {
    assert.equal(singular('children'), 'child');
    assert.equal(singular('mice'), 'mouse');
    assert.equal(singular('people'), 'person');
  });
  test('uncountables identity', () => {
    assert.equal(singular('fish'), 'fish');
    assert.equal(singular('data'), 'data');
  });
});

describe('pluralize (count-aware)', () => {
  test('count=1 returns singular', () => {
    assert.equal(pluralize('apple', 1), 'apple');
  });
  test('count != 1 returns plural', () => {
    assert.equal(pluralize('apple', 2), 'apples');
    assert.equal(pluralize('apple', 0), 'apples');
  });
  test('singularize alias', () => {
    assert.equal(singularize('apples'), 'apple');
  });
});

describe('addIrregular', () => {
  test('extends both directions', () => {
    addIrregular('quokka', 'quokkas-special');
    assert.equal(plural('quokka'), 'quokkas-special');
    assert.equal(singular('quokkas-special'), 'quokka');
  });
  test('throws on bad input', () => {
    assert.throws(() => addIrregular(null, 'x'), TypeError);
    assert.throws(() => addIrregular('x', 42), TypeError);
  });
});

describe('UNCOUNTABLE export', () => {
  test('contains expected words', () => {
    for (const w of ['fish', 'sheep', 'information', 'data']) {
      assert.equal(UNCOUNTABLE.has(w), true);
    }
  });
});
