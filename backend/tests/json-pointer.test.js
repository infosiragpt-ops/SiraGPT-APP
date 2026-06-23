'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const jp = require('../src/utils/json-pointer');

describe('parsePointer / formatPointer / escapes', () => {
  test('empty pointer = root', () => {
    assert.deepEqual(jp.parsePointer(''), []);
    assert.equal(jp.formatPointer([]), '');
  });

  test('parse + escape round-trip', () => {
    const tokens = ['users', 'a/b', 'tilde~it', '0'];
    const ptr = jp.formatPointer(tokens);
    assert.deepEqual(jp.parsePointer(ptr), tokens);
  });

  test('escape rules: ~→~0, /→~1', () => {
    assert.equal(jp.escapeToken('a/b'), 'a~1b');
    assert.equal(jp.escapeToken('tilde~it'), 'tilde~0it');
    assert.equal(jp.unescapeToken('a~1b'), 'a/b');
    assert.equal(jp.unescapeToken('tilde~0it'), 'tilde~it');
  });

  test('parse rejects malformed pointers', () => {
    assert.throws(() => jp.parsePointer('no-slash'), TypeError);
    assert.throws(() => jp.parsePointer(42), TypeError);
  });
});

describe('get / has', () => {
  const doc = { a: 1, b: { c: 2, d: [10, 20, { e: 'x' }] }, 'a/b': 'slash' };

  test('returns nested values', () => {
    assert.equal(jp.get(doc, '/a'), 1);
    assert.equal(jp.get(doc, '/b/c'), 2);
    assert.equal(jp.get(doc, '/b/d/1'), 20);
    assert.equal(jp.get(doc, '/b/d/2/e'), 'x');
  });

  test('escapes are honored', () => {
    assert.equal(jp.get(doc, '/a~1b'), 'slash');
  });

  test('missing path returns undefined', () => {
    assert.equal(jp.get(doc, '/nope'), undefined);
    assert.equal(jp.get(doc, '/b/d/99'), undefined);
  });

  test('has() reflects existence', () => {
    assert.equal(jp.has(doc, '/a'), true);
    assert.equal(jp.has(doc, '/b/c'), true);
    assert.equal(jp.has(doc, '/b/x'), false);
    assert.equal(jp.has(doc, '/b/d/0'), true);
    assert.equal(jp.has(doc, '/b/d/9'), false);
  });

  test('root-pointer returns whole doc', () => {
    assert.equal(jp.get(doc, ''), doc);
  });
});

describe('set', () => {
  test('updates existing value', () => {
    const doc = { a: { b: 1 } };
    jp.set(doc, '/a/b', 99);
    assert.equal(doc.a.b, 99);
  });

  test('creates intermediate objects on demand', () => {
    const doc = {};
    jp.set(doc, '/x/y/z', 42);
    assert.equal(doc.x.y.z, 42);
  });

  test('numeric segment after missing path creates an array', () => {
    const doc = {};
    jp.set(doc, '/items/0/name', 'a');
    assert.ok(Array.isArray(doc.items));
    assert.equal(doc.items[0].name, 'a');
  });

  test('"-" appends to an array', () => {
    const doc = { xs: [1, 2] };
    jp.set(doc, '/xs/-', 3);
    assert.deepEqual(doc.xs, [1, 2, 3]);
  });

  test('rejects setting the root document', () => {
    assert.throws(() => jp.set({}, '', 1));
  });
});

describe('del', () => {
  test('removes object key', () => {
    const doc = { a: 1, b: 2 };
    assert.equal(jp.del(doc, '/a'), true);
    assert.deepEqual(doc, { b: 2 });
  });

  test('removes array element via splice', () => {
    const doc = { xs: [1, 2, 3] };
    assert.equal(jp.del(doc, '/xs/1'), true);
    assert.deepEqual(doc.xs, [1, 3]);
  });

  test('returns false on missing path', () => {
    assert.equal(jp.del({ a: 1 }, '/b'), false);
    assert.equal(jp.del({ a: 1 }, ''), false);
  });
});

describe('set — prototype-pollution guard', () => {
  test('refuses to write __proto__ / constructor / prototype keys', () => {
    for (const ptr of ['/__proto__/polluted', '/constructor/polluted', '/prototype/polluted']) {
      assert.throws(() => jp.set({}, ptr, 'PWNED'), /prototype-pollution guard|forbidden key/);
    }
    // The global prototype must be untouched.
    assert.equal({}.polluted, undefined);
  });

  test('refuses __proto__ as the final token too', () => {
    assert.throws(() => jp.set({ a: {} }, '/a/__proto__', { x: 1 }), /forbidden key/);
    assert.equal({}.x, undefined);
  });

  test('still writes ordinary nested keys', () => {
    const doc = {};
    jp.set(doc, '/a/b/c', 42);
    assert.equal(doc.a.b.c, 42);
  });
});
