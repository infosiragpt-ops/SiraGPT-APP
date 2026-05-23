'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  reciprocalRankFusion,
  weightedRankFusion,
  DEFAULT_K,
} = require('../src/services/rag/rank-fusion');

describe('reciprocalRankFusion — basic', () => {
  test('single ranking: order preserved', () => {
    const r = reciprocalRankFusion([[
      { id: 'a' }, { id: 'b' }, { id: 'c' },
    ]]);
    assert.deepEqual(r.map((x) => x.id), ['a', 'b', 'c']);
  });

  test('two rankings: items in both score higher', () => {
    const cosine = [{ id: 'doc1' }, { id: 'doc2' }, { id: 'doc3' }];
    const bm25   = [{ id: 'doc4' }, { id: 'doc1' }, { id: 'doc5' }];
    const r = reciprocalRankFusion([cosine, bm25]);
    // doc1 appears in both, so it should win.
    assert.equal(r[0].id, 'doc1');
  });

  test('contributions track per-ranking rank + weighted score', () => {
    const r = reciprocalRankFusion([[{ id: 'a' }], [{ id: 'a' }]]);
    assert.equal(r[0].contributions[0].rank, 1);
    assert.equal(r[0].contributions[1].rank, 1);
    assert.equal(r[0].fusedScore, (1 / (DEFAULT_K + 1)) * 2);
  });
});

describe('reciprocalRankFusion — weights', () => {
  test('higher weight on a ranking shifts the winner toward it', () => {
    const a = [{ id: 'A' }, { id: 'B' }];
    const b = [{ id: 'B' }, { id: 'A' }];
    const equal = reciprocalRankFusion([a, b]);
    assert.equal(equal[0].id, 'A'); // tie-break by insertion order; A first in list a
    const heavyA = reciprocalRankFusion([a, b], { weights: [10, 1] });
    assert.equal(heavyA[0].id, 'A');
    const heavyB = reciprocalRankFusion([a, b], { weights: [1, 10] });
    assert.equal(heavyB[0].id, 'B');
  });

  test('zero weight skips a ranking entirely', () => {
    const a = [{ id: 'A' }];
    const b = [{ id: 'B' }];
    const r = reciprocalRankFusion([a, b], { weights: [1, 0] });
    assert.deepEqual(r.map((x) => x.id), ['A']);
  });

  test('weights length mismatch throws', () => {
    assert.throws(
      () => reciprocalRankFusion([[{ id: 'a' }], [{ id: 'b' }]], { weights: [1] }),
      TypeError,
    );
  });
});

describe('reciprocalRankFusion — k parameter', () => {
  test('larger k flattens score differences', () => {
    const ranking = [{ id: 'a' }, { id: 'b' }];
    const tight = reciprocalRankFusion([ranking], { k: 1 });
    const loose = reciprocalRankFusion([ranking], { k: 1000 });
    const tightDelta = tight[0].fusedScore - tight[1].fusedScore;
    const looseDelta = loose[0].fusedScore - loose[1].fusedScore;
    assert.ok(tightDelta > looseDelta);
  });
});

describe('reciprocalRankFusion — guards + edge cases', () => {
  test('non-array rankings throws', () => {
    assert.throws(() => reciprocalRankFusion('nope'), TypeError);
  });

  test('empty rankings returns []', () => {
    assert.deepEqual(reciprocalRankFusion([]), []);
  });

  test('rankings with non-array entries are tolerated (ignored)', () => {
    const r = reciprocalRankFusion([[{ id: 'a' }], 'not-array', null]);
    assert.equal(r[0].id, 'a');
  });

  test('items with null id are skipped', () => {
    const r = reciprocalRankFusion([[{ id: null }, { id: 'a' }]]);
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'a');
  });

  test('topK respected', () => {
    const list = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}` }));
    const r = reciprocalRankFusion([list], { topK: 3 });
    assert.equal(r.length, 3);
  });
});

describe('weightedRankFusion — accepts plain ids', () => {
  test('id strings work without {id: ...} wrapper', () => {
    const r = weightedRankFusion([['a', 'b'], ['b', 'a']]);
    // 'a' rank 1 in list 0 and rank 2 in list 1; 'b' rank 2 in list 0
    // and rank 1 in list 1. Symmetric → first-seen wins (a).
    assert.equal(r[0].id, 'a');
    assert.equal(r[1].id, 'b');
  });

  test('mixing object-form and id-form items works', () => {
    const r = weightedRankFusion([['a', { id: 'b' }], [{ id: 'a' }, 'b']]);
    assert.equal(r.length, 2);
  });
});
