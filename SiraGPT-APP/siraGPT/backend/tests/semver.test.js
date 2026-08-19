'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { parse, compare, satisfies, maxSatisfying } = require('../src/utils/semver');

describe('parse', () => {
  test('basic triplet', () => {
    assert.deepEqual(parse('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [], build: null });
  });
  test('prerelease', () => {
    const r = parse('1.2.3-alpha.1');
    assert.deepEqual(r.prerelease, ['alpha', '1']);
  });
  test('build metadata captured but ignored on compare', () => {
    const r = parse('1.2.3+sha.abc');
    assert.equal(r.build, 'sha.abc');
  });
  test('rejects garbage', () => {
    assert.equal(parse('not a version'), null);
    assert.equal(parse('1.2'), null);
    assert.equal(parse(null), null);
  });
});

describe('compare', () => {
  test('major / minor / patch ordering', () => {
    assert.equal(compare('1.0.0', '2.0.0'), -1);
    assert.equal(compare('1.2.0', '1.1.0'), 1);
    assert.equal(compare('1.0.5', '1.0.5'), 0);
  });
  test('prerelease < release', () => {
    assert.equal(compare('1.0.0-alpha', '1.0.0'), -1);
    assert.equal(compare('1.0.0', '1.0.0-rc.1'), 1);
  });
  test('numeric prerelease compared numerically', () => {
    assert.equal(compare('1.0.0-2', '1.0.0-10'), -1);
  });
  test('build metadata ignored', () => {
    assert.equal(compare('1.0.0+a', '1.0.0+b'), 0);
  });
  test('throws on bad version', () => {
    assert.throws(() => compare('garbage', '1.0.0'), TypeError);
  });
});

describe('satisfies — basic operators', () => {
  test('= and exact match', () => {
    assert.equal(satisfies('1.2.3', '1.2.3'), true);
    assert.equal(satisfies('1.2.3', '=1.2.3'), true);
    assert.equal(satisfies('1.2.4', '1.2.3'), false);
  });
  test('>=, >, <=, <', () => {
    assert.equal(satisfies('1.2.3', '>=1.2.0'), true);
    assert.equal(satisfies('1.1.0', '>=1.2.0'), false);
    assert.equal(satisfies('1.2.3', '>1.2.0'), true);
    assert.equal(satisfies('1.2.0', '<=1.2.0'), true);
    assert.equal(satisfies('1.2.1', '<1.2.5'), true);
  });
});

describe('satisfies — ^ caret', () => {
  test('^1.2.3 allows 1.x.y >= 1.2.3 but not 2.0.0', () => {
    assert.equal(satisfies('1.2.3', '^1.2.3'), true);
    assert.equal(satisfies('1.5.0', '^1.2.3'), true);
    assert.equal(satisfies('1.2.0', '^1.2.3'), false);
    assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  });
  test('^0.2.3 keeps minor stable', () => {
    assert.equal(satisfies('0.2.4', '^0.2.3'), true);
    assert.equal(satisfies('0.3.0', '^0.2.3'), false);
  });
});

describe('satisfies — ~ tilde', () => {
  test('~1.2.3 allows patch bumps only', () => {
    assert.equal(satisfies('1.2.5', '~1.2.3'), true);
    assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  });
});

describe('satisfies — combinations', () => {
  test('intersection (space = AND)', () => {
    assert.equal(satisfies('1.5.0', '>=1.2.0 <2.0.0'), true);
    assert.equal(satisfies('2.0.0', '>=1.2.0 <2.0.0'), false);
  });
  test('union (||)', () => {
    assert.equal(satisfies('1.0.0', '^1.0.0 || ^2.0.0'), true);
    assert.equal(satisfies('2.5.0', '^1.0.0 || ^2.0.0'), true);
    assert.equal(satisfies('3.0.0', '^1.0.0 || ^2.0.0'), false);
  });
});

describe('maxSatisfying', () => {
  test('returns highest version that satisfies range', () => {
    const versions = ['1.0.0', '1.2.3', '1.5.0', '2.0.0'];
    assert.equal(maxSatisfying(versions, '^1.0.0'), '1.5.0');
    assert.equal(maxSatisfying(versions, '^2.0.0'), '2.0.0');
    assert.equal(maxSatisfying(versions, '^9.0.0'), null);
  });
  test('non-array → null', () => {
    assert.equal(maxSatisfying(null, '^1.0.0'), null);
  });
});
