/**
 * Property tests for services/rag/bm25.js — the Okapi BM25 lexical
 * reranker. Three invariants:
 *
 *   1. All emitted scores are strictly non-negative. BM25's smoothed
 *      IDF is guaranteed ≥ 0 in this implementation, and TF is always
 *      ≥ 1 when a term matches, so the per-term contribution can never
 *      be negative.
 *   2. Querying for a term that appears in exactly one document
 *      returns a single hit whose score is > 0.
 *   3. Score is monotonic in within-document term frequency: if doc B
 *      contains strictly more occurrences of a query term than doc A
 *      and nothing else differs, scoreB ≥ scoreA. (Equality is
 *      possible when the length normalisation cancels the TF gain in
 *      pathological edge cases; we assert ≥, not >.)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { createBm25Index } = require('../src/services/rag/bm25');

// Words guaranteed to survive the default tokenizer + Spanish/English
// stopword filter. Keep them short, lowercase, alphabetic, distinct.
const VOCAB = ['quantum', 'fusion', 'molecule', 'reactor', 'plasma', 'turbine'];

test('bm25.search: all scores are non-negative', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.array(fc.constantFrom(...VOCAB), { minLength: 1, maxLength: 8 }),
        { minLength: 1, maxLength: 6 },
      ),
      fc.constantFrom(...VOCAB),
      (docs, queryTerm) => {
        const idx = createBm25Index();
        docs.forEach((tokens, i) => idx.add(`d${i}`, tokens.join(' ')));
        const hits = idx.search(queryTerm, { topK: 10 });
        return hits.every((h) => Number.isFinite(h.score) && h.score >= 0);
      },
    ),
    { numRuns: 100 },
  );
});

test('bm25.search: single-doc match returns one hit with score > 0', () => {
  fc.assert(
    fc.property(fc.constantFrom(...VOCAB), (term) => {
      const idx = createBm25Index();
      idx.add('only', `${term} ${term}`);
      idx.add('other', 'unrelated body text here please');
      const hits = idx.search(term);
      if (hits.length !== 1) return false;
      return hits[0].id === 'only' && hits[0].score > 0;
    }),
    { numRuns: 50 },
  );
});

test('bm25.search: score is monotonic non-decreasing with term frequency', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...VOCAB),
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 1, max: 5 }),
      (term, baseTf, extraTf) => {
        // docA has baseTf copies of `term`; docB has baseTf + extraTf
        // copies + the same filler so length differences are minimal.
        const filler = 'reactor plasma turbine'; // stable across both
        const idx = createBm25Index();
        idx.add('A', `${(term + ' ').repeat(baseTf).trim()} ${filler}`);
        idx.add(
          'B',
          `${(term + ' ').repeat(baseTf + extraTf).trim()} ${filler}`,
        );
        const sA =
          idx.search(term).find((h) => h.id === 'A')?.score ?? 0;
        const sB =
          idx.search(term).find((h) => h.id === 'B')?.score ?? 0;
        // More occurrences should never lower the score (BM25 TF is
        // monotonically non-decreasing in f for k1 > 0).
        return sB + 1e-9 >= sA;
      },
    ),
    { numRuns: 100 },
  );
});
