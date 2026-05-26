'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { diffLines, unifiedDiff, splitLines } = require('../src/utils/text-diff');

describe('splitLines', () => {
  test('splits on \\n', () => {
    assert.deepEqual(splitLines('a\nb\nc'), ['a', 'b', 'c']);
  });
  test('empty / null → []', () => {
    assert.deepEqual(splitLines(''), []);
    assert.deepEqual(splitLines(null), []);
  });
});

describe('diffLines', () => {
  test('identical inputs → all eq', () => {
    const d = diffLines('a\nb\nc', 'a\nb\nc');
    assert.deepEqual(d.map((x) => x.kind), ['eq', 'eq', 'eq']);
  });

  test('one-line replacement = del + add', () => {
    const d = diffLines('a\nb\nc', 'a\nX\nc');
    assert.deepEqual(d.map((x) => `${x.kind}:${x.value}`), ['eq:a', 'del:b', 'add:X', 'eq:c']);
  });

  test('append-only diff', () => {
    const d = diffLines('a\nb', 'a\nb\nc');
    assert.deepEqual(d.map((x) => x.kind), ['eq', 'eq', 'add']);
  });

  test('delete-only diff', () => {
    const d = diffLines('a\nb\nc', 'a\nc');
    const seq = d.map((x) => `${x.kind}:${x.value}`);
    assert.deepEqual(seq, ['eq:a', 'del:b', 'eq:c']);
  });

  test('a empty → all add; b empty → all del', () => {
    assert.deepEqual(diffLines('', 'a\nb').map((x) => x.kind), ['add', 'add']);
    assert.deepEqual(diffLines('a\nb', '').map((x) => x.kind), ['del', 'del']);
  });

  test('both empty → []', () => {
    assert.deepEqual(diffLines('', ''), []);
  });

  test('accepts pre-split arrays', () => {
    const d = diffLines(['a', 'b'], ['a', 'c']);
    assert.deepEqual(d.map((x) => x.kind), ['eq', 'del', 'add']);
  });
});

describe('unifiedDiff', () => {
  test('identical → empty string', () => {
    assert.equal(unifiedDiff('a\nb', 'a\nb'), '');
  });

  test('headers + hunk + +/- lines', () => {
    const out = unifiedDiff('a\nb\nc', 'a\nX\nc', { aLabel: 'old.txt', bLabel: 'new.txt' });
    assert.match(out, /^--- old\.txt\n\+\+\+ new\.txt\n@@ /);
    assert.match(out, /-b/);
    assert.match(out, /\+X/);
    assert.match(out, / a\n/);
    assert.match(out, / c/);
  });

  test('contextLines:0 emits only changed lines', () => {
    const out = unifiedDiff('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne', { contextLines: 0 });
    // Should show -c and +X, no surrounding context.
    assert.match(out, /-c/);
    assert.match(out, /\+X/);
    // Match a context line precisely (newline + space + content),
    // not the file header where ' a' / ' e' could appear inside '--- a'.
    assert.equal(/\n a\n/.test(out), false);
    assert.equal(/\n e\n/.test(out), false);
  });

  test('multi-hunk far-apart changes produce two hunks', () => {
    const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n');
    const b = ['X', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'Z'].join('\n');
    const out = unifiedDiff(a, b, { contextLines: 1 });
    // Two @@ headers expected.
    const headers = out.match(/^@@ /gm) || [];
    assert.equal(headers.length, 2);
  });
});
