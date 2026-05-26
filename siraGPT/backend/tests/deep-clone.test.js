'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { deepClone, deepCloneMany } = require('../src/utils/deep-clone');
const { deepEqual } = require('../src/utils/deep-equal');

describe('deepClone — primitives + null', () => {
  test('passthrough', () => {
    assert.equal(deepClone(1), 1);
    assert.equal(deepClone('x'), 'x');
    assert.equal(deepClone(true), true);
    assert.equal(deepClone(null), null);
    assert.equal(deepClone(undefined), undefined);
  });
});

describe('deepClone — plain objects + arrays', () => {
  test('clone is structurally equal but not the same reference', () => {
    const o = { a: 1, b: { c: [1, 2, 3] } };
    const c = deepClone(o);
    assert.notEqual(c, o);
    assert.notEqual(c.b, o.b);
    assert.notEqual(c.b.c, o.b.c);
    assert.equal(deepEqual(c, o), true);
  });

  test('mutating clone does not affect original', () => {
    const o = { x: { y: 1 } };
    const c = deepClone(o);
    c.x.y = 99;
    assert.equal(o.x.y, 1);
  });

  test('Object.create(null) is honored', () => {
    const o = Object.create(null);
    o.a = 1;
    const c = deepClone(o);
    assert.equal(Object.getPrototypeOf(c), null);
    assert.equal(c.a, 1);
  });
});

describe('deepClone — special objects', () => {
  test('Date is cloned to a new Date', () => {
    const d = new Date(123456);
    const c = deepClone(d);
    assert.notEqual(c, d);
    assert.equal(c.getTime(), d.getTime());
  });

  test('RegExp source + flags + lastIndex preserved', () => {
    const r = /foo/gi;
    r.lastIndex = 5;
    const c = deepClone(r);
    assert.notEqual(c, r);
    assert.equal(c.source, 'foo');
    assert.equal(c.flags, 'gi');
    assert.equal(c.lastIndex, 5);
  });

  test('Map is cloned by key+value', () => {
    const m = new Map([[{ k: 1 }, [1, 2]]]);
    const c = deepClone(m);
    assert.notEqual(c, m);
    const [k, v] = [...c][0];
    const [origK, origV] = [...m][0];
    assert.notEqual(k, origK);
    assert.notEqual(v, origV);
    assert.equal(deepEqual(k, origK), true);
    assert.equal(deepEqual(v, origV), true);
  });

  test('Set elements are cloned (deep)', () => {
    const s = new Set([{ a: 1 }, { b: 2 }]);
    const c = deepClone(s);
    assert.notEqual(c, s);
    const arrOrig = [...s];
    const arrClone = [...c];
    for (let i = 0; i < arrOrig.length; i++) {
      assert.notEqual(arrClone[i], arrOrig[i]);
      assert.equal(deepEqual(arrClone[i], arrOrig[i]), true);
    }
  });

  test('Buffer cloned to new Buffer', () => {
    const b = Buffer.from('abc');
    const c = deepClone(b);
    assert.notEqual(c, b);
    assert.equal(c.toString(), 'abc');
  });

  test('Uint8Array cloned with same content', () => {
    const a = new Uint8Array([1, 2, 3]);
    const c = deepClone(a);
    assert.notEqual(c, a);
    assert.deepEqual([...c], [1, 2, 3]);
  });
});

describe('deepClone — circular references', () => {
  test('self-reference cloned without infinite loop', () => {
    const o = { x: 1 };
    o.self = o;
    const c = deepClone(o);
    assert.notEqual(c, o);
    assert.equal(c.self, c, 'self-ref should point to clone, not original');
  });

  test('two objects mutually referring each other', () => {
    const a = { name: 'a' };
    const b = { name: 'b', a };
    a.b = b;
    const aClone = deepClone(a);
    assert.notEqual(aClone, a);
    assert.equal(aClone.b.a, aClone);
  });
});

describe('deepClone — function/symbol shallow passthrough', () => {
  test('functions are passed through (not cloned)', () => {
    const fn = () => 42;
    const c = deepClone({ f: fn });
    assert.equal(c.f, fn);
  });
});

describe('deepCloneMany', () => {
  test('clones a tuple sharing the cycle map', () => {
    const shared = { x: 1 };
    const [a, b] = deepCloneMany({ ref: shared }, { ref: shared });
    assert.equal(a.ref, b.ref); // shared reference preserved across the tuple
    assert.notEqual(a.ref, shared);
  });
});
