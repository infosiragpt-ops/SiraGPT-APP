// Cowork · /skills query-shape coercion — offline tests (no app boot, no DB).
// Express parses repeated/nested query keys as arrays/objects; the skills
// registry expects plain strings, so the route coerces them at the boundary.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../src/routes/cowork');
const { firstQueryString, clampQueryLimit } = _internals;

describe('cowork · firstQueryString', () => {
  test('passes plain strings through', () => {
    assert.equal(firstQueryString('summarize'), 'summarize');
    assert.equal(firstQueryString(''), '');
  });

  test('collapses arrays (?intent=a&intent=b) to the first element', () => {
    assert.equal(firstQueryString(['a', 'b']), 'a');
    assert.equal(firstQueryString(['only']), 'only');
  });

  test('returns empty string for objects, undefined, null, numbers', () => {
    assert.equal(firstQueryString({ malicious: 'shape' }), '');
    assert.equal(firstQueryString(undefined), '');
    assert.equal(firstQueryString(null), '');
    assert.equal(firstQueryString(42), '');
  });

  test('nested arrays resolve recursively without throwing', () => {
    assert.equal(firstQueryString([['deep']]), 'deep');
    assert.equal(firstQueryString([[]]), '');
  });

  test('the result is always .split-safe (regression for tags.split)', () => {
    for (const shape of [['a,b'], { x: 1 }, undefined, 7, null]) {
      const s = firstQueryString(shape);
      assert.equal(typeof s, 'string');
      assert.doesNotThrow(() => s.split(','));
    }
  });
});

describe('cowork · clampQueryLimit', () => {
  test('returns the fallback for missing / non-numeric / non-positive input', () => {
    assert.equal(clampQueryLimit(undefined, 5), 5);
    assert.equal(clampQueryLimit('abc', 5), 5);
    assert.equal(clampQueryLimit('0', 5), 5);
    assert.equal(clampQueryLimit('-3', 5), 5);
    assert.equal(clampQueryLimit(['x'], 5), 5);
  });

  test('floors and clamps to the max ceiling', () => {
    assert.equal(clampQueryLimit('3', 10), 3);
    assert.equal(clampQueryLimit('3.9', 10), 3);
    assert.equal(clampQueryLimit('999', 10, 100), 100);
    assert.equal(clampQueryLimit(['7'], 10), 7);
  });
});
