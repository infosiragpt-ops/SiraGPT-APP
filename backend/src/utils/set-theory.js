'use strict';

/**
 * set-theory — small bag of set helpers. Pairs with SimHash (#41,
 * near-duplicate fingerprints) and BM25 (#33, ranked search): when
 * you need to compare *which* items overlap (tag intersection,
 * scope diff, RAG-hit dedup), these are the right primitive.
 *
 * Accepts native Set, Array, or any iterable. Returns native Set
 * unless noted. All helpers are pure / non-mutating.
 *
 * Public API:
 *   asSet(iterable)              → Set
 *   intersection(a, b)           → Set
 *   union(a, b)                  → Set
 *   difference(a, b)             → Set (a \ b)
 *   symmetricDifference(a, b)    → Set (a ⊕ b)
 *   isSubset(a, b)               → boolean (a ⊆ b)
 *   isSuperset(a, b)             → boolean (a ⊇ b)
 *   disjoint(a, b)               → boolean (a ∩ b = ∅)
 *   jaccard(a, b)                → 0..1   |a∩b| / |a∪b|
 *   sorensenDice(a, b)           → 0..1   2|a∩b| / (|a|+|b|)
 */

function asSet(iter) {
  if (iter instanceof Set) return iter;
  if (iter == null) return new Set();
  if (typeof iter[Symbol.iterator] === 'function') return new Set(iter);
  throw new TypeError('set-theory: iterable required');
}

function intersection(a, b) {
  const A = asSet(a); const B = asSet(b);
  // iterate the smaller for speed
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  const out = new Set();
  for (const x of small) if (big.has(x)) out.add(x);
  return out;
}

function union(a, b) {
  const out = new Set(asSet(a));
  for (const x of asSet(b)) out.add(x);
  return out;
}

function difference(a, b) {
  const A = asSet(a); const B = asSet(b);
  const out = new Set();
  for (const x of A) if (!B.has(x)) out.add(x);
  return out;
}

function symmetricDifference(a, b) {
  const A = asSet(a); const B = asSet(b);
  const out = new Set();
  for (const x of A) if (!B.has(x)) out.add(x);
  for (const x of B) if (!A.has(x)) out.add(x);
  return out;
}

function isSubset(a, b) {
  const A = asSet(a); const B = asSet(b);
  if (A.size > B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
}

function isSuperset(a, b) {
  return isSubset(b, a);
}

function disjoint(a, b) {
  const A = asSet(a); const B = asSet(b);
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const x of small) if (big.has(x)) return false;
  return true;
}

function jaccard(a, b) {
  const A = asSet(a); const B = asSet(b);
  if (A.size === 0 && B.size === 0) return 1;
  const inter = intersection(A, B).size;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 1 : inter / uni;
}

function sorensenDice(a, b) {
  const A = asSet(a); const B = asSet(b);
  if (A.size === 0 && B.size === 0) return 1;
  const inter = intersection(A, B).size;
  return (2 * inter) / (A.size + B.size);
}

module.exports = {
  asSet,
  intersection,
  union,
  difference,
  symmetricDifference,
  isSubset,
  isSuperset,
  disjoint,
  jaccard,
  sorensenDice,
};
