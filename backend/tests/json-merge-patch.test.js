'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { apply, diff } = require('../src/utils/json-merge-patch');

describe('apply — RFC 7396 §2 examples', () => {
  test('replaces existing key', () => {
    assert.deepEqual(apply({ a: 'b' }, { a: 'c' }), { a: 'c' });
  });
  test('adds new key', () => {
    assert.deepEqual(apply({ a: 'b' }, { b: 'c' }), { a: 'b', b: 'c' });
  });
  test('null deletes key', () => {
    assert.deepEqual(apply({ a: 'b' }, { a: null }), {});
  });
  test('deletion preserves siblings', () => {
    assert.deepEqual(apply({ a: 'b', b: 'c' }, { a: null }), { b: 'c' });
  });
  test('arrays are wholesale replaced', () => {
    assert.deepEqual(apply({ a: ['b'] }, { a: 'c' }), { a: 'c' });
    assert.deepEqual(apply({ a: 'c' }, { a: ['b'] }), { a: ['b'] });
  });
  test('nested object merge', () => {
    assert.deepEqual(
      apply({ a: { b: 'c' } }, { a: { b: 'd', c: null } }),
      { a: { b: 'd' } }
    );
  });
  test('deep nested deletion', () => {
    assert.deepEqual(
      apply({ a: { b: 'c' }, x: 1 }, { a: { b: null }, x: 2 }),
      { a: {}, x: 2 }
    );
  });
  test('non-object target replaced when patch is object', () => {
    assert.deepEqual(apply(null, { a: 1 }), { a: 1 });
    assert.deepEqual(apply([1, 2], { a: 1 }), { a: 1 });
  });
  test('non-object patch returned as-is', () => {
    assert.equal(apply({ a: 1 }, 'replaced'), 'replaced');
    assert.equal(apply({ a: 1 }, 5), 5);
    assert.equal(apply({ a: 1 }, null), null);
  });
});

describe('apply — does not mutate inputs', () => {
  test('original target unchanged', () => {
    const target = { a: 1, b: { c: 2 } };
    apply(target, { b: { c: 99 } });
    assert.deepEqual(target, { a: 1, b: { c: 2 } });
  });
});

describe('diff', () => {
  test('empty diff for equal objects', () => {
    assert.deepEqual(diff({ a: 1 }, { a: 1 }), {});
  });
  test('changed value', () => {
    assert.deepEqual(diff({ a: 1 }, { a: 2 }), { a: 2 });
  });
  test('added key', () => {
    assert.deepEqual(diff({ a: 1 }, { a: 1, b: 2 }), { b: 2 });
  });
  test('removed key → null', () => {
    assert.deepEqual(diff({ a: 1, b: 2 }, { a: 1 }), { b: null });
  });
  test('nested diff is minimal', () => {
    assert.deepEqual(
      diff({ a: { x: 1, y: 2 } }, { a: { x: 1, y: 99 } }),
      { a: { y: 99 } }
    );
  });
  test('non-object target → patch is the target verbatim', () => {
    assert.equal(diff({ a: 1 }, 'string'), 'string');
    assert.deepEqual(diff({ a: 1 }, [1, 2, 3]), [1, 2, 3]);
  });
});

describe('round-trip property: apply(s, diff(s, t)) === t', () => {
  const cases = [
    [{ a: 1 }, { a: 2, b: 3 }],
    [{ a: { b: 1, c: 2 } }, { a: { b: 1, c: 99, d: 4 } }],
    [{ a: [1, 2, 3] }, { a: [4, 5] }],
    [{ a: 1, b: 2, c: 3 }, { a: 1 }], // deletes b and c
    [{}, { x: 'y' }],
    [{ deep: { nested: { value: 'old' } } }, { deep: { nested: { value: 'new' } } }],
  ];
  for (const [src, tgt] of cases) {
    test(`${JSON.stringify(src)} → ${JSON.stringify(tgt)}`, () => {
      const patch = diff(src, tgt);
      assert.deepEqual(apply(src, patch), tgt);
    });
  }
});

describe('apply — prototype-pollution guard', () => {
  test('drops __proto__ / constructor / prototype keys instead of merging them', () => {
    const out = apply({ a: 1 }, JSON.parse('{"__proto__":{"polluted":"x"},"constructor":{"y":1},"b":2}'));
    assert.equal(out.a, 1);
    assert.equal(out.b, 2);
    assert.equal({}.polluted, undefined, 'global prototype untouched');
    assert.ok(!Object.prototype.hasOwnProperty.call(out, 'polluted'));
  });
});
