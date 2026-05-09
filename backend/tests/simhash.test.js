'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  simhash,
  hammingDistance,
  similarity,
  tokenizeWords,
  tokenizeShingles,
} = require('../src/services/rag/simhash');

describe('tokenizers', () => {
  test('tokenizeWords lowercases and splits Unicode', () => {
    assert.deepEqual(tokenizeWords('Hola, mundo cruel'), ['hola', 'mundo', 'cruel']);
  });
  test('tokenizeWords on empty/null returns []', () => {
    assert.deepEqual(tokenizeWords(''), []);
    assert.deepEqual(tokenizeWords(null), []);
  });
  test('tokenizeShingles produces overlapping n-grams', () => {
    const s = tokenizeShingles('hello', 3);
    assert.deepEqual(s, ['hel', 'ell', 'llo']);
  });
  test('tokenizeShingles short string returns the whole text', () => {
    assert.deepEqual(tokenizeShingles('ab', 3), ['ab']);
  });
});

describe('simhash — determinism + identity', () => {
  test('same input → same fingerprint', () => {
    const a = simhash('the quick brown fox jumps over the lazy dog');
    const b = simhash('the quick brown fox jumps over the lazy dog');
    assert.equal(a, b);
  });

  test('empty input → 0n', () => {
    assert.equal(simhash(''), 0n);
    assert.equal(simhash(null), 0n);
  });

  test('fingerprint fits in 64 bits', () => {
    const fp = simhash('hello world');
    assert.ok(fp < (1n << 64n));
  });
});

describe('simhash — near-duplicate behavior', () => {
  test('one-word edit gives small Hamming distance', () => {
    const a = simhash('the quick brown fox jumps over the lazy dog');
    const b = simhash('the quick brown fox jumps over the lazy cat');
    const d = hammingDistance(a, b);
    assert.ok(d <= 16, `expected near-duplicate, got distance ${d}`);
  });

  test('totally different texts yield large Hamming distance', () => {
    const a = simhash('the quick brown fox jumps over the lazy dog');
    const b = simhash('renewable energy policy in the european union');
    const d = hammingDistance(a, b);
    assert.ok(d >= 16, `expected very different, got distance ${d}`);
  });

  test('similarity = 1 - hamming/64 within [0,1]', () => {
    const a = simhash('hello world');
    const b = simhash('hello world');
    assert.equal(similarity(a, b), 1);
    const c = simhash('completely different sentence here');
    const s = similarity(a, c);
    assert.ok(s >= 0 && s <= 1);
  });
});

describe('hammingDistance', () => {
  test('distance(x, x) === 0', () => {
    assert.equal(hammingDistance(0xabcdn, 0xabcdn), 0);
  });

  test('distance(0, 1) === 1', () => {
    assert.equal(hammingDistance(0n, 1n), 1);
  });

  test('distance(0, 0xff) === 8', () => {
    assert.equal(hammingDistance(0n, 0xffn), 8);
  });

  test('rejects non-bigint args', () => {
    assert.throws(() => hammingDistance(1, 2n), TypeError);
    assert.throws(() => hammingDistance(1n, 2), TypeError);
  });
});

describe('simhash — custom tokenizer', () => {
  test('shingle tokenizer surfaces typo-tolerance', () => {
    const a = simhash('information retrieval', { tokenize: (t) => tokenizeShingles(t, 3) });
    const b = simhash('infomation retrieval',  { tokenize: (t) => tokenizeShingles(t, 3) }); // typo
    const d = hammingDistance(a, b);
    // For short texts (~20 trigrams), one missing char cascades through
    // several shingles so we accept a generous bound vs. a fully
    // unrelated text (which lands at distance ~30+).
    assert.ok(d <= 22, `typo distance ${d} too large`);
  });
});
