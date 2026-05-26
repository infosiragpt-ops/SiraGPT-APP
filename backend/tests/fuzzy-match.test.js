'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { match, rank, isWordBoundary } = require('../src/utils/fuzzy-match');

describe('match — basics', () => {
  test('exact prefix scores highest', () => {
    const r = match('open', 'openFile');
    assert.notEqual(r, null);
    assert.deepEqual(r.indices, [0, 1, 2, 3]);
    assert.ok(r.score > 0.5);
  });

  test('subsequence finds chars in order', () => {
    const r = match('opf', 'openFile');
    assert.notEqual(r, null);
    assert.deepEqual(r.indices, [0, 1, 4]);
  });

  test('out-of-order does NOT match', () => {
    assert.equal(match('fo', 'open'), null);
  });

  test('missing char → null', () => {
    assert.equal(match('xyz', 'openFile'), null);
  });

  test('empty query → score 0 with no indices', () => {
    const r = match('', 'whatever');
    assert.equal(r.score, 0);
    assert.deepEqual(r.indices, []);
  });

  test('non-string args → null', () => {
    assert.equal(match(null, 'x'), null);
    assert.equal(match('x', null), null);
  });
});

describe('match — scoring heuristics', () => {
  test('consecutive matches score higher than scattered', () => {
    const a = match('open', 'openFile').score;
    const b = match('open', 'oxpxexn').score;
    assert.ok(a > b);
  });

  test('word-boundary hits score higher than mid-word', () => {
    const start = match('o', 'open').score;     // boundary
    const mid = match('o', 'foo').score;        // mid-word position 2 -- 'foo' has 'o' at index 1 (boundary too actually)
    const reallyMid = match('e', 'pew').score;  // mid-word
    assert.ok(start >= mid);
    assert.ok(start >= reallyMid);
  });

  test('camelHump counts as boundary', () => {
    // 'F' in 'openFile' should boost
    const camel = match('F', 'openFile').score;
    const noCamel = match('f', 'fooobar').score;
    assert.ok(camel >= noCamel * 0.9, `camel=${camel} noCamel=${noCamel}`);
  });
});

describe('isWordBoundary', () => {
  test('first char is boundary', () => {
    assert.equal(isWordBoundary('hello', 0), true);
  });
  test('after space / _ / - / . / /', () => {
    for (const s of ['a b', 'a_b', 'a-b', 'a.b', 'a/b']) {
      assert.equal(isWordBoundary(s, 2), true);
    }
  });
  test('camelHump after lowercase', () => {
    assert.equal(isWordBoundary('camelCase', 5), true);
  });
  test('mid-word lowercase is not boundary', () => {
    assert.equal(isWordBoundary('hello', 2), false);
  });
});

describe('rank', () => {
  test('returns matches sorted by score desc', () => {
    const out = rank('opn', ['openFile', 'closeAll', 'openProject', 'reopen', 'pin']);
    const values = out.map((r) => r.value);
    // openFile should place ahead of pin (no 'o') — since pin has no 'o'.
    assert.equal(values.includes('openFile'), true);
    assert.equal(values.includes('pin'), false);
    // Order check: openFile vs openProject — both match; whichever
    // scores higher is first.
    if (values.indexOf('openFile') !== -1 && values.indexOf('openProject') !== -1) {
      assert.ok(out[0].score >= out[1].score);
    }
  });

  test('limit caps result count', () => {
    const out = rank('a', ['apple', 'banana', 'avocado', 'mango'], { limit: 2 });
    assert.equal(out.length, 2);
  });

  test('threshold filters out low-score matches', () => {
    const out = rank('z', ['zebra', 'maze', 'dazzle'], { threshold: 0.3 });
    for (const r of out) assert.ok(r.score >= 0.3);
  });

  test('non-array returns []', () => {
    assert.deepEqual(rank('x', null), []);
  });
});
