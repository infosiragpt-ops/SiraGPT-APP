/**
 * diverse-beam-search — Algorithm 1 from the GEAR paper
 * (Shen et al., ACL 2025, "Graph-enhanced Agent for Retrieval-augmented
 * Generation"). Ported verbatim from the pseudocode in §4.2.
 *
 * Purpose: given an initial set of triples (the "proximal" starting
 * nodes linked from LLM output) and a neighbour-lookup function, grow
 * b parallel chains of triples up to length l, scoring each extension
 * by its similarity to the query. Apply a position-based diversity
 * penalty per expansion step so the b beams don't collapse onto
 * near-identical prefixes.
 *
 * Algorithm (paper Alg. 1):
 *   B₀ ← top-b by score([t]) over initial triples
 *   for i in 1..l-1:
 *     B ← []
 *     for each ⟨s, T⟩ in Bᵢ₋₁:
 *       V ← []
 *       for t in neighbours(T.last()) \ seen(T):
 *         s' ← s + score(q, T ∘ t)
 *         V.add(⟨s', T ∘ t⟩)
 *       sort V descending
 *       for n in 0..|V|-1:
 *         ⟨s', T ∘ t⟩ ← V[n]
 *         s' ← s' × exp(−min(n, γ) / γ)       # diversity weight
 *         B.add(⟨s', T ∘ t⟩)
 *     Bᵢ ← top-b(B)
 *   return Bᵢ
 *
 * The diversity weight exp(-min(n,γ)/γ) starts at 1.0 for the top-
 * ranked extension within a beam, decays for worse-ranked ones, and
 * saturates at exp(-1) once n reaches γ. That nudges the next-iteration
 * top-b away from beams that all extend the same parent with the same
 * best neighbour — you get broader graph coverage instead of b very
 * similar chains.
 *
 * The caller supplies:
 *   - initialTriples: seed list (already linked to the stored graph)
 *   - neighbourFn(lastTriple, visitedKeys): returns neighbour triples
 *   - scoreFn(sequence): returns a [0,1]-ish relevance number for the
 *     full triple sequence (typically cosine against the query)
 *   - tripleKeyFn(triple): stable identity for the "visited" set
 *   - { b = 4, l = 3, gamma = 2 }
 *
 * Returns an array of `{ score, sequence }` objects, sorted descending.
 */

const DEFAULTS = {
  b: 4,       // beam width
  l: 3,       // chain length (paper tests 3 on MuSiQue)
  gamma: 2,   // diversity saturation point
};

/**
 * Apply the paper's diversity weight to a raw score based on its rank
 * within the candidate list (0 = best).
 */
function diversityWeight(rank, gamma) {
  const g = Math.max(1e-9, gamma);
  return Math.exp(-Math.min(rank, gamma) / g);
}

async function diverseTripleBeamSearch({
  initialTriples,
  neighbourFn,
  scoreFn,
  tripleKeyFn,
  b = DEFAULTS.b,
  l = DEFAULTS.l,
  gamma = DEFAULTS.gamma,
}) {
  if (!Array.isArray(initialTriples) || initialTriples.length === 0) return [];
  if (typeof neighbourFn !== 'function') throw new Error('neighbourFn required');
  if (typeof scoreFn !== 'function') throw new Error('scoreFn required');
  if (typeof tripleKeyFn !== 'function') throw new Error('tripleKeyFn required');

  // Initial beams: rank seed triples individually by score and keep top-b.
  let Bi = [];
  for (const t of initialTriples) {
    const score = await scoreFn([t]);
    Bi.push({ score, sequence: [t], keys: new Set([tripleKeyFn(t)]) });
  }
  Bi.sort((a, x) => x.score - a.score);
  Bi = Bi.slice(0, b);

  // Expand l-1 more times.
  for (let step = 1; step < l; step++) {
    const newBeams = [];

    for (const beam of Bi) {
      const last = beam.sequence[beam.sequence.length - 1];
      const neighbours = neighbourFn(last, beam.keys) || [];
      if (neighbours.length === 0) {
        // Dead-end beam: keep it, unmodified, so we don't lose the chain.
        // (The paper doesn't specify, but dropping it would shrink the
        // beam below b for subsequent steps and empty-return prematurely.)
        newBeams.push(beam);
        continue;
      }

      // Score every extension.
      const candidates = [];
      for (const t of neighbours) {
        const k = tripleKeyFn(t);
        if (beam.keys.has(k)) continue;
        const extended = beam.sequence.concat([t]);
        const extScore = await scoreFn(extended);
        candidates.push({
          rawScore: beam.score + extScore,
          triple: t,
          key: k,
          extended,
        });
      }

      // Sort descending by raw score, then apply rank-based diversity.
      candidates.sort((a, x) => x.rawScore - a.rawScore);
      for (let n = 0; n < candidates.length; n++) {
        const w = diversityWeight(n, gamma);
        const weightedScore = candidates[n].rawScore * w;
        newBeams.push({
          score: weightedScore,
          sequence: candidates[n].extended,
          keys: new Set([...beam.keys, candidates[n].key]),
        });
      }
    }

    if (newBeams.length === 0) break;
    newBeams.sort((a, x) => x.score - a.score);
    Bi = newBeams.slice(0, b);
  }

  // Return without the internal `keys` Set so callers get a clean shape.
  return Bi.map(({ score, sequence }) => ({ score, sequence }));
}

/**
 * Flatten beam output to a unique, rank-preserving list of triples.
 * The paper: "top-b returned sequences are flattened in a breadth-first
 * order" (§4.2 last paragraph). We interpret BFS-on-sequences as: take
 * position 0 of every beam, then position 1 of every beam, etc.
 */
function flattenBeamsBFS(beams, tripleKeyFn) {
  if (!Array.isArray(beams) || beams.length === 0) return [];
  const seen = new Set();
  const out = [];
  const maxLen = Math.max(...beams.map(b => b.sequence.length));
  for (let pos = 0; pos < maxLen; pos++) {
    for (const beam of beams) {
      const t = beam.sequence[pos];
      if (!t) continue;
      const k = tripleKeyFn(t);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

module.exports = {
  diverseTripleBeamSearch,
  flattenBeamsBFS,
  diversityWeight,
  DEFAULTS,
};
