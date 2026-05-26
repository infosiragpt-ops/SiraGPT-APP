'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { applyPatch, diffPatch } = require('../src/utils/json-patch');
const { deepEqual } = require('../src/utils/deep-equal');

describe('applyPatch — add', () => {
  test('add into object', () => {
    const r = applyPatch({ a: 1 }, [{ op: 'add', path: '/b', value: 2 }]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.doc, { a: 1, b: 2 });
  });
  test('add inserts into array (does not replace)', () => {
    const r = applyPatch({ xs: [1, 3] }, [{ op: 'add', path: '/xs/1', value: 2 }]);
    assert.deepEqual(r.doc.xs, [1, 2, 3]);
  });
  test('"-" appends', () => {
    const r = applyPatch({ xs: [1] }, [{ op: 'add', path: '/xs/-', value: 2 }]);
    assert.deepEqual(r.doc.xs, [1, 2]);
  });
});

describe('applyPatch — remove / replace', () => {
  test('remove on missing path fails atomically', () => {
    const doc = { a: 1 };
    const r = applyPatch(doc, [
      { op: 'replace', path: '/a', value: 99 },
      { op: 'remove', path: '/missing' },
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.opIndex, 1);
    // Original doc unchanged.
    assert.deepEqual(doc, { a: 1 });
  });

  test('replace requires existence', () => {
    const r = applyPatch({}, [{ op: 'replace', path: '/x', value: 1 }]);
    assert.equal(r.ok, false);
  });
});

describe('applyPatch — move / copy', () => {
  test('move shifts value across paths', () => {
    const r = applyPatch({ a: 1, b: 2 }, [{ op: 'move', from: '/a', path: '/c' }]);
    assert.deepEqual(r.doc, { b: 2, c: 1 });
  });
  test('copy duplicates the value (deep-cloned)', () => {
    const doc = { src: { x: 1 } };
    const r = applyPatch(doc, [{ op: 'copy', from: '/src', path: '/dst' }]);
    assert.notEqual(r.doc.dst, r.doc.src);
    assert.equal(deepEqual(r.doc.dst, r.doc.src), true);
  });
});

describe('applyPatch — test', () => {
  test('passes when value matches', () => {
    const r = applyPatch({ a: { b: [1] } }, [{ op: 'test', path: '/a/b/0', value: 1 }]);
    assert.equal(r.ok, true);
  });
  test('fails on mismatch and aborts subsequent ops', () => {
    const doc = { a: 1, b: 2 };
    const r = applyPatch(doc, [
      { op: 'test', path: '/a', value: 99 },
      { op: 'replace', path: '/b', value: 200 },
    ]);
    assert.equal(r.ok, false);
    assert.deepEqual(doc, { a: 1, b: 2 });
  });
});

describe('applyPatch — guards', () => {
  test('rejects non-array ops', () => {
    const r = applyPatch({}, 'nope');
    assert.equal(r.ok, false);
  });
  test('unknown op fails opIndex', () => {
    const r = applyPatch({}, [{ op: 'whoami', path: '' }]);
    assert.equal(r.ok, false);
    assert.equal(r.opIndex, 0);
  });
});

describe('diffPatch', () => {
  test('identical → []', () => {
    assert.deepEqual(diffPatch({ a: 1 }, { a: 1 }), []);
  });
  test('added key', () => {
    const ops = diffPatch({ a: 1 }, { a: 1, b: 2 });
    assert.deepEqual(ops, [{ op: 'add', path: '/b', value: 2 }]);
  });
  test('removed key', () => {
    const ops = diffPatch({ a: 1, b: 2 }, { a: 1 });
    assert.deepEqual(ops, [{ op: 'remove', path: '/b' }]);
  });
  test('replaced primitive', () => {
    const ops = diffPatch({ a: 1 }, { a: 2 });
    assert.deepEqual(ops, [{ op: 'replace', path: '/a', value: 2 }]);
  });
  test('round-trips through applyPatch', () => {
    const a = { name: 'alice', tags: ['x', 'y'], age: 30 };
    const b = { name: 'alice', tags: ['x', 'z', 'q'], city: 'CDMX' };
    const ops = diffPatch(a, b);
    const r = applyPatch(a, ops);
    assert.equal(r.ok, true);
    assert.equal(deepEqual(r.doc, b), true);
  });
  test('escape special characters in keys', () => {
    const ops = diffPatch({}, { 'a/b': 1, 'c~d': 2 });
    const paths = ops.map((o) => o.path).sort();
    assert.deepEqual(paths, ['/a~1b', '/c~0d']);
  });
});
