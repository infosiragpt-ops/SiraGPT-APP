'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { deepMerge, isMergeOptions } = require('../src/utils/deep-merge');

describe('deepMerge — happy path', () => {
  test('flat objects merge with later wins', () => {
    assert.deepEqual(deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 }), { a: 1, b: 3, c: 4 });
  });

  test('nested objects merge recursively', () => {
    const r = deepMerge(
      { user: { name: 'a', age: 10 } },
      { user: { age: 20, city: 'CDMX' } },
    );
    assert.deepEqual(r, { user: { name: 'a', age: 20, city: 'CDMX' } });
  });

  test('inputs are not mutated', () => {
    const a = { x: 1, nested: { y: 2 } };
    const b = { nested: { z: 3 } };
    deepMerge(a, b);
    assert.deepEqual(a, { x: 1, nested: { y: 2 } });
    assert.deepEqual(b, { nested: { z: 3 } });
  });

  test('undefined values in later sources are skipped', () => {
    assert.deepEqual(deepMerge({ a: 1 }, { a: undefined, b: 2 }), { a: 1, b: 2 });
  });

  test('single source returned as-is', () => {
    const a = { x: 1 };
    assert.equal(deepMerge(a), a);
  });

  test('zero sources returns undefined', () => {
    assert.equal(deepMerge(), undefined);
  });
});

describe('deepMerge — array strategies', () => {
  test('default replace: later array wins', () => {
    assert.deepEqual(deepMerge({ tags: [1, 2] }, { tags: [3] }), { tags: [3] });
  });

  test('concat: element-wise concat', () => {
    assert.deepEqual(
      deepMerge({ tags: [1, 2] }, { tags: [3, 4] }, { arrayMerge: 'concat' }),
      { tags: [1, 2, 3, 4] },
    );
  });

  test('unique: concat then dedup, preserving first-seen order', () => {
    assert.deepEqual(
      deepMerge({ tags: [1, 2] }, { tags: [2, 3, 1] }, { arrayMerge: 'unique' }),
      { tags: [1, 2, 3] },
    );
  });

  test('custom function strategy', () => {
    const r = deepMerge(
      { xs: [1, 2] },
      { xs: [3, 4] },
      { arrayMerge: (a, b) => a.concat(b).map((n) => n * 10) },
    );
    assert.deepEqual(r.xs, [10, 20, 30, 40]);
  });

  test('unknown strategy throws', () => {
    assert.throws(() => deepMerge({}, {}, { arrayMerge: 'banana' }), TypeError);
  });
});

describe('deepMerge — type-mismatch behavior', () => {
  test('object replaced by primitive: primitive wins', () => {
    assert.deepEqual(deepMerge({ a: { x: 1 } }, { a: 'replaced' }), { a: 'replaced' });
  });

  test('array replaced by object: object wins (no-merge cross types)', () => {
    assert.deepEqual(deepMerge({ a: [1, 2] }, { a: { y: 1 } }), { a: { y: 1 } });
  });

  test('class instance treated as opaque (later wins)', () => {
    class Box { constructor(v) { this.v = v; } }
    const r = deepMerge({ x: new Box(1) }, { x: new Box(2) });
    assert.equal(r.x.v, 2);
  });
});

describe('deepMerge — multi-source', () => {
  test('three-way merge in order', () => {
    const r = deepMerge({ a: 1 }, { b: 2 }, { c: 3, a: 9 });
    assert.deepEqual(r, { a: 9, b: 2, c: 3 });
  });
});

describe('isMergeOptions', () => {
  test('only true for one-key {arrayMerge: …}', () => {
    assert.equal(isMergeOptions({ arrayMerge: 'replace' }), true);
    assert.equal(isMergeOptions({ arrayMerge: 'concat', other: 1 }), false);
    assert.equal(isMergeOptions({}), false);
    assert.equal(isMergeOptions(null), false);
    assert.equal(isMergeOptions([]), false);
  });
});
