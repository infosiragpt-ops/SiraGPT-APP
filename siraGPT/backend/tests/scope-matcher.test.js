'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  matchScope,
  anyMatch,
  filterAllowed,
  compilePatterns,
  isValidPattern,
  isValidScope,
} = require('../src/services/auth/scope-matcher');

describe('isValidPattern / isValidScope', () => {
  test('valid scopes', () => {
    assert.equal(isValidScope('read:users:42'), true);
    assert.equal(isValidScope('a.b-c_d'), true);
  });

  test('invalid scopes', () => {
    assert.equal(isValidScope(''), false);
    assert.equal(isValidScope(':a'), false);
    assert.equal(isValidScope('a:'), false);
    assert.equal(isValidScope('a/b'), false);
    assert.equal(isValidScope(null), false);
  });

  test('valid patterns include * and ** at tail', () => {
    assert.equal(isValidPattern('read:*:42'), true);
    assert.equal(isValidPattern('read:users:*'), true);
    assert.equal(isValidPattern('read:**'), true);
    assert.equal(isValidPattern('**'), true);
  });

  test('** in non-tail position is invalid', () => {
    assert.equal(isValidPattern('read:**:users'), false);
  });
});

describe('matchScope — exact + wildcards', () => {
  test('exact match', () => {
    assert.equal(matchScope('read:users:42', 'read:users:42'), true);
    assert.equal(matchScope('read:users:42', 'read:users:43'), false);
  });

  test('* matches one segment', () => {
    assert.equal(matchScope('read:users:*', 'read:users:42'), true);
    assert.equal(matchScope('read:users:*', 'read:users:42:extra'), false);
    assert.equal(matchScope('*:users:42', 'read:users:42'), true);
    assert.equal(matchScope('*:users:42', 'admin:users:42'), true);
  });

  test('** matches one or more trailing segments', () => {
    assert.equal(matchScope('read:**', 'read:users:42'), true);
    assert.equal(matchScope('read:**', 'read'), false); // ** requires at least one tail segment
    assert.equal(matchScope('**', 'anything:goes:here'), true);
  });

  test('mismatched length without wildcard fails', () => {
    assert.equal(matchScope('read:users', 'read:users:42'), false);
    assert.equal(matchScope('read:users:42', 'read:users'), false);
  });

  test('invalid pattern or scope returns false (no throw)', () => {
    assert.equal(matchScope('bad pattern', 'read:users'), false);
    assert.equal(matchScope('read:**', null), false);
  });
});

describe('anyMatch / filterAllowed', () => {
  test('anyMatch true when ANY pattern matches', () => {
    const patterns = ['read:posts:*', 'admin:**'];
    assert.equal(anyMatch(patterns, 'admin:users:42'), true);
    assert.equal(anyMatch(patterns, 'write:posts:1'), false);
  });

  test('anyMatch false on non-array', () => {
    assert.equal(anyMatch(null, 'x:y'), false);
  });

  test('filterAllowed returns subset matched by any pattern', () => {
    const patterns = ['read:**'];
    const scopes = ['read:users:1', 'write:users:1', 'read:posts:9'];
    assert.deepEqual(filterAllowed(patterns, scopes), ['read:users:1', 'read:posts:9']);
  });

  test('filterAllowed handles non-array scopes', () => {
    assert.deepEqual(filterAllowed(['*'], 'nope'), []);
  });
});

describe('compilePatterns', () => {
  test('returns a fast matcher fn', () => {
    const m = compilePatterns(['read:**', 'admin:*']);
    assert.equal(m('read:users:42'), true);
    assert.equal(m('admin:foo'), true);
    assert.equal(m('write:users:42'), false);
  });

  test('drops invalid patterns silently', () => {
    const m = compilePatterns(['valid:**', 'bad pattern']);
    assert.equal(m('valid:x:y'), true);
    assert.equal(m('bad pattern'), false);
  });

  test('non-array throws', () => {
    assert.throws(() => compilePatterns('nope'), TypeError);
  });
});
