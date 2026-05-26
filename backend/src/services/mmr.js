/**
 * mmr — Maximal Marginal Relevance re-ranking.
 *
 * The problem: top-K by pure cosine similarity tends to return chunks
 * that are near-duplicates of each other. Useful for finding *the*
 * passage; bad when the caller needs breadth ("give me everything the
 * doc says about X"). MMR fixes that by penalising candidates that are
 * too similar to items already selected.
 *
 * Score(candidate) = λ * relevance(candidate, query)
 *                  − (1 − λ) * max_similarity(candidate, alreadySelected)
 *
 * λ = 1 → pure relevance (same as cosine top-K).
 * λ = 0 → pure diversity (ignores the query entirely).
 * λ = 0.7 → good default — relevance-weighted with a diversity nudge.
 *
 * We use Jaccard over tokenised content for the candidate-vs-selected
 * similarity because it's cheap and doesn't require a second embedding
 * pass. The relevance score is the cosine we already computed in
 * rag-service.retrieve() — MMR just reshuffles the ranking.
 *
 * Pattern reference: Iliagpt.io server/memory/mmr.ts (TypeScript).
 * This is a straight port to CommonJS JavaScript.
 */

const DEFAULT_LAMBDA = 0.7;

/**
 * Tokenise text into a set of alphanumeric lowercase tokens. Accents
 * are kept as-is — Spanish content is common in siraGPT so stripping
 * them would merge distinct words ("si" / "sí").
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return new Set();
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  return new Set(tokens);
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let intersection = 0;
  for (const t of smaller) if (larger.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function maxSimilarityToSelected(itemTokens, selectedTokens) {
  let max = 0;
  for (const sel of selectedTokens) {
    const sim = jaccardSimilarity(itemTokens, sel);
    if (sim > max) max = sim;
  }
  return max;
}

function computeMMRScore(relevance, maxSimilarity, lambda) {
  return lambda * relevance - (1 - lambda) * maxSimilarity;
}

/**
 * Rerank a list of scored items for diversity.
 *
 * Input items must shape `{ text, score, ...meta }`. `score` is the
 * original relevance (e.g. cosine) and `text` is what we tokenise for
 * the diversity term. Any other fields pass through untouched.
 *
 * Returns a new array — does not mutate the input.
 */
function mmrRerank(items, { lambda = DEFAULT_LAMBDA, k = Infinity } = {}) {
  if (!Array.isArray(items) || items.length <= 1) return Array.isArray(items) ? [...items] : [];

  const clampedLambda = Math.max(0, Math.min(1, lambda));
  // λ=1 degenerates to pure relevance — skip the quadratic work.
  if (clampedLambda === 1) {
    return [...items].sort((a, b) => b.score - a.score).slice(0, k);
  }

  // Normalise scores to [0,1] so relevance and Jaccard are on the
  // same scale — otherwise a 0.03 cosine always loses to a 0.15
  // Jaccard even when the 0.03 is genuinely the best hit in the set.
  const scores = items.map(i => i.score);
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const range = maxScore - minScore;
  const normalize = s => (range === 0 ? 1 : (s - minScore) / range);

  const itemTokens = items.map(i => tokenize(i.text || ''));

  const selected = [];
  const selectedTokens = [];
  const remaining = new Set(items.map((_, i) => i));

  while (remaining.size > 0 && selected.length < k) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const i of remaining) {
      const rel = normalize(items[i].score);
      const maxSim = maxSimilarityToSelected(itemTokens[i], selectedTokens);
      const mmr = computeMMRScore(rel, maxSim, clampedLambda);
      // Tie-break on original score so the more relevant of two
      // equally-diverse candidates wins.
      if (mmr > bestScore || (mmr === bestScore && items[i].score > (items[bestIdx]?.score ?? -Infinity))) {
        bestScore = mmr;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;
    selected.push(items[bestIdx]);
    selectedTokens.push(itemTokens[bestIdx]);
    remaining.delete(bestIdx);
  }

  return selected;
}

module.exports = {
  mmrRerank,
  tokenize,
  jaccardSimilarity,
  computeMMRScore,
  DEFAULT_LAMBDA,
};
