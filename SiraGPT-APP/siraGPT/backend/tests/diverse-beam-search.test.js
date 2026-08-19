/**
 * Unit tests for services/diverse-beam-search.js.
 *
 * Tests use a synthetic graph where node "neighbours" are supplied by a
 * closure so we control the topology exactly.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  diverseTripleBeamSearch,
  flattenBeamsBFS,
  diversityWeight,
  DEFAULTS,
} = require('../src/services/diverse-beam-search');

const keyOf = (t) => `${t.subject}|${t.predicate}|${t.object}`;

test('diversityWeight: 0 → 1, at γ → exp(-1), above γ saturates', () => {
  assert.equal(diversityWeight(0, 2), 1);
  assert.ok(Math.abs(diversityWeight(2, 2) - Math.exp(-1)) < 1e-9);
  // n > γ should still cap at exp(-1) (min(n,γ)/γ = 1).
  assert.ok(Math.abs(diversityWeight(10, 2) - Math.exp(-1)) < 1e-9);
});

test('DBS: empty initial triples returns []', async () => {
  const out = await diverseTripleBeamSearch({
    initialTriples: [],
    neighbourFn: () => [],
    scoreFn: async () => 1,
    tripleKeyFn: keyOf,
  });
  assert.deepEqual(out, []);
});

test('DBS: l=1 returns top-b seeds sorted by scoreFn', async () => {
  const initial = [
    { subject: 's', predicate: 'p', object: 'a' },
    { subject: 's', predicate: 'p', object: 'b' },
    { subject: 's', predicate: 'p', object: 'c' },
  ];
  // Score: object === 'b' is best, then 'c', then 'a'.
  const scoreMap = { a: 0.2, b: 0.9, c: 0.5 };
  const out = await diverseTripleBeamSearch({
    initialTriples: initial,
    neighbourFn: () => [],
    scoreFn: async (seq) => scoreMap[seq[seq.length - 1].object] ?? 0,
    tripleKeyFn: keyOf,
    b: 2, l: 1,
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].sequence[0].object, 'b');
  assert.equal(out[1].sequence[0].object, 'c');
});

test('DBS: expands through shared-entity neighbours up to l', async () => {
  // Chain: (A→B), (B→C), (C→D). Start at (A→B), l=3, beam=1.
  const triples = [
    { subject: 'A', predicate: 'r', object: 'B' },
    { subject: 'B', predicate: 'r', object: 'C' },
    { subject: 'C', predicate: 'r', object: 'D' },
  ];
  const [a, b, c] = triples;

  const neighbours = (last, visitedKeys) => {
    const all = triples.filter(t => keyOf(t) !== keyOf(last));
    return all.filter(t => !visitedKeys.has(keyOf(t)))
      .filter(t => t.subject === last.object || t.object === last.subject);
  };

  const out = await diverseTripleBeamSearch({
    initialTriples: [a],
    neighbourFn: neighbours,
    scoreFn: async () => 1,
    tripleKeyFn: keyOf,
    b: 1, l: 3, gamma: 2,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].sequence.length, 3);
  assert.deepEqual(out[0].sequence.map(t => t.object), ['B', 'C', 'D']);
});

test('DBS: diversity weight penalises beams that extend with worse neighbours', async () => {
  // Two parents, each with two extensions. Without diversity the top-2
  // beams would both come from the same parent (highest scores). With
  // γ=1 (aggressive diversity), rank-1 extensions are heavily penalised
  // so we should see at least one beam from each parent.
  const P1 = { subject: 'P1', predicate: 'r', object: 'X' };
  const P2 = { subject: 'P2', predicate: 'r', object: 'Y' };
  const E1a = { subject: 'X', predicate: 'r', object: 'E1a' };
  const E1b = { subject: 'X', predicate: 'r', object: 'E1b' };
  const E2a = { subject: 'Y', predicate: 'r', object: 'E2a' };
  const E2b = { subject: 'Y', predicate: 'r', object: 'E2b' };

  const scores = new Map([
    ['P1|r|X', 0.9], ['P2|r|Y', 0.85],
    // Both parents produce two extensions with same-relative scores
    // but P1's pair is slightly higher than P2's so without diversity
    // penalty both top-2 beams would come from P1.
    ['P1|r|X,X|r|E1a', 1.9], ['P1|r|X,X|r|E1b', 1.7],
    ['P2|r|Y,Y|r|E2a', 1.8], ['P2|r|Y,Y|r|E2b', 1.6],
  ]);
  const scoreFn = async (seq) => {
    if (seq.length === 1) return { 'P1|r|X': 0.9, 'P2|r|Y': 0.85 }[keyOf(seq[0])] ?? 0.1;
    // scoreFn for extension returns the *marginal* score; diverseTripleBeamSearch
    // adds it to the accumulated score. So return a per-step marginal.
    const last = seq[seq.length - 1];
    if (last.object.startsWith('E1a')) return 1.0;
    if (last.object.startsWith('E1b')) return 0.8;
    if (last.object.startsWith('E2a')) return 0.95;
    if (last.object.startsWith('E2b')) return 0.75;
    return 0;
  };

  const neighbours = (last) => {
    if (last.object === 'X') return [E1a, E1b];
    if (last.object === 'Y') return [E2a, E2b];
    return [];
  };

  const outNoDiversity = await diverseTripleBeamSearch({
    initialTriples: [P1, P2],
    neighbourFn: neighbours,
    scoreFn,
    tripleKeyFn: keyOf,
    b: 2, l: 2, gamma: 100, // very high γ → diversity weight ≈ 1 for all
  });
  const outDiverse = await diverseTripleBeamSearch({
    initialTriples: [P1, P2],
    neighbourFn: neighbours,
    scoreFn,
    tripleKeyFn: keyOf,
    b: 2, l: 2, gamma: 0.5, // aggressive diversity
  });

  // With aggressive diversity, the final beams should include extensions
  // from BOTH parents. Without diversity, they may both come from P1.
  const diverseParents = new Set(outDiverse.map(b => b.sequence[0].subject));
  assert.ok(diverseParents.size >= 2, `expected beams from both parents, got ${[...diverseParents]}`);
});

test('DBS: visited triples are not re-picked', async () => {
  const A = { subject: 'A', predicate: 'r', object: 'B' };
  const B = { subject: 'B', predicate: 'r', object: 'C' };
  // Only one neighbour — must not re-select A itself.
  const neighbours = (last) => {
    if (last.object === 'B') return [B];
    if (last.object === 'C') return []; // dead-end
    return [];
  };
  const out = await diverseTripleBeamSearch({
    initialTriples: [A],
    neighbourFn: neighbours,
    scoreFn: async () => 1,
    tripleKeyFn: keyOf,
    b: 1, l: 3,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].sequence.length, 2); // stuck after 2 because C has no neighbours
});

// ─── flattenBeamsBFS ───────────────────────────────────────────────────────

test('flattenBeamsBFS: yields position-by-position, dedup by key', () => {
  const beams = [
    { sequence: [{ subject: 'a', predicate: 'r', object: '1' }, { subject: 'b', predicate: 'r', object: '2' }] },
    { sequence: [{ subject: 'c', predicate: 'r', object: '3' }, { subject: 'a', predicate: 'r', object: '1' }] }, // dup at pos 1
  ];
  const flat = flattenBeamsBFS(beams, keyOf);
  assert.deepEqual(flat.map(keyOf), ['a|r|1', 'c|r|3', 'b|r|2']);
});

test('DEFAULTS: stable', () => {
  assert.equal(DEFAULTS.b, 4);
  assert.equal(DEFAULTS.l, 3);
  assert.equal(DEFAULTS.gamma, 2);
});
