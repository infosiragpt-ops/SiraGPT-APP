'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { match, compile, anyMatch, filterMatches } = require('../src/utils/glob-match');

describe('match — single-segment wildcards', () => {
  test('* matches anything except /', () => {
    assert.equal(match('*.js', 'foo.js'), true);
    assert.equal(match('*.js', 'a/b.js'), false);
  });

  test('? matches one char (not /)', () => {
    assert.equal(match('a?c', 'abc'), true);
    assert.equal(match('a?c', 'a/c'), false);
  });

  test('exact literal', () => {
    assert.equal(match('readme.md', 'readme.md'), true);
    assert.equal(match('readme.md', 'README.md'), false);
  });
});

describe('match — character classes', () => {
  test('[abc] matches one of the chars', () => {
    assert.equal(match('[abc].txt', 'a.txt'), true);
    assert.equal(match('[abc].txt', 'd.txt'), false);
  });

  test('range [a-z]', () => {
    assert.equal(match('[a-c].txt', 'b.txt'), true);
    assert.equal(match('[a-c].txt', 'd.txt'), false);
  });

  test('negation [!abc]', () => {
    assert.equal(match('[!abc].txt', 'd.txt'), true);
    assert.equal(match('[!abc].txt', 'a.txt'), false);
  });
});

describe('match — ** multi-segment', () => {
  test('**/*.js matches any-depth js', () => {
    assert.equal(match('**/*.js', 'foo.js'), true);
    assert.equal(match('**/*.js', 'a/b/c.js'), true);
    assert.equal(match('**/*.js', 'foo.ts'), false);
  });

  test('a/**/b matches any depth between a and b', () => {
    assert.equal(match('a/**/b', 'a/b'), true);
    assert.equal(match('a/**/b', 'a/x/y/b'), true);
    assert.equal(match('a/**/b', 'a/x/y/c'), false);
  });
});

describe('match — escapes', () => {
  test('\\* matches a literal *', () => {
    assert.equal(match('\\*foo', '*foo'), true);
    assert.equal(match('\\*foo', 'xfoo'), false);
  });
});

describe('match — type safety', () => {
  test('non-string path → false', () => {
    assert.equal(match('*', 42), false);
    assert.equal(match('*', null), false);
  });

  test('non-string pattern throws', () => {
    assert.throws(() => match(42, 'x'), TypeError);
  });
});

describe('compile — caching', () => {
  test('compiles to a stable matcher fn', () => {
    const fn1 = compile('*.js');
    const fn2 = compile('*.js');
    // Cache may or may not return identical fn but both must work.
    assert.equal(fn1('a.js'), true);
    assert.equal(fn2('a.js'), true);
  });
});

describe('anyMatch / filterMatches', () => {
  test('anyMatch true if any pattern matches', () => {
    const patterns = ['*.js', 'docs/**/*.md'];
    assert.equal(anyMatch(patterns, 'src/foo.js'), false); // segment-aware
    assert.equal(anyMatch(patterns, 'foo.js'), true);
    assert.equal(anyMatch(patterns, 'docs/a/b.md'), true);
  });

  test('filterMatches returns the matched subset', () => {
    const out = filterMatches(['*.js'], ['a.js', 'b.ts', 'c.js']);
    assert.deepEqual(out, ['a.js', 'c.js']);
  });

  test('filterMatches handles non-array safely', () => {
    assert.deepEqual(filterMatches(['*'], 'nope'), []);
  });
});
