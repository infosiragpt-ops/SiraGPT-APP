'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { tokenizeSearchQuery } = require('../src/services/chat-scope');

describe('chat-scope tokenizeSearchQuery', () => {
  test('splits multi-word queries into tokens', () => {
    assert.deepEqual(tokenizeSearchQuery('  tesis metodologia  '), ['tesis', 'metodologia']);
  });

  test('ignores single-character tokens', () => {
    assert.deepEqual(tokenizeSearchQuery('a b cd'), ['cd']);
  });

  test('caps at 8 tokens', () => {
    const tokens = tokenizeSearchQuery('one two three four five six seven eight nine ten');
    assert.equal(tokens.length, 8);
  });
});
