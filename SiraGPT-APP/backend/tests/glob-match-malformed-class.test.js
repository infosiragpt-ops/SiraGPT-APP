'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { match, anyMatch, _resetCache } = require('../src/utils/glob-match');

/**
 * compileToRegex() interpolated a glob [set] straight into `new RegExp`
 * with no try/catch, so a malformed character class (reversed range like
 * [z-a], or a class ending in a backslash) threw a SyntaxError that
 * propagated out of match()/anyMatch() — and poisoned an entire pattern
 * list even when other patterns would have matched. A bad class must now
 * degrade to "matches nothing".
 */

test('a reversed-range character class does not throw and matches nothing', () => {
  _resetCache?.();
  assert.doesNotThrow(() => match('[z-a]', 'x'));
  assert.equal(match('[z-a]', 'x'), false);
});

test('a class ending in a backslash does not throw', () => {
  assert.doesNotThrow(() => match('[\\]', 'x'));
});

test('a malformed pattern does not poison the rest of the list', () => {
  assert.equal(
    anyMatch(['docs/[z-a].md', 'src/**'], 'src/index.js'),
    true,
    'a valid sibling pattern must still match despite a malformed one',
  );
});

test('well-formed character classes and globs are unaffected', () => {
  assert.equal(match('[a-z]', 'q'), true);
  assert.equal(match('[!abc]', 'd'), true);
  assert.equal(match('[!abc]', 'a'), false);
  assert.equal(match('src/**', 'src/index.js'), true);
});
