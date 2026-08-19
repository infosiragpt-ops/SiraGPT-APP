/**
 * ragas/context-precision — "of the retrieved chunks, how many are
 * actually relevant to the question, and are the relevant ones
 * ranked FIRST?"
 *
 * Es et al. 2024 (RAGAS §3.3): weighted by rank — a relevant chunk at
 * position 1 counts more than a relevant chunk at position 5. Uses
 * Mean Reciprocal-Rank-style weighting (actually the paper uses
 * mean of precision@k where k indicates the retrieval position).
 *
 * Algorithm:
 *   1. For each retrieved chunk at position k (1-indexed), LLM judge
 *      decides: "is this chunk relevant to answering the question?"
 *   2. Compute precision@k cumulatively: (# relevant ≤ k) / k.
 *   3. Weight: only count precision@k where the k-th chunk itself was
 *      relevant (so non-relevant positions don't pollute the average).
 *   4. Score = mean(weighted precision@k).
 *
 * If no chunks are relevant, score = 0. If every chunk is relevant,
 * score = 1. If relevant chunks are at the top, score stays high; if
 * they're scattered at the bottom, score drops.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

const RELEVANCE_SYSTEM = `Decide whether a retrieved PASSAGE contains information useful for answering the QUESTION.

Reply with STRICT JSON:
{"verdicts": [{"idx": <position 1..N>, "relevant": true|false, "reason": "<short>"}]}

Rules:
- One entry per input passage, IN ORDER.
- "relevant" = true when the passage contains information that would appear in a correct answer.
- "relevant" = false when the passage is tangential, about a different topic, or adds no support.`;

async function judgeRelevance({ openai, question, retrievedContexts, model = DEFAULT_MODEL }) {
  if (!openai || !Array.isArray(retrievedContexts) || retrievedContexts.length === 0) {
    return retrievedContexts.map(() => false);
  }
  const passages = retrievedContexts
    .map((c, i) => `[${i + 1}${c.source ? ' ' + c.source : ''}] ${String(c.text || c || '').slice(0, 600)}`)
    .join('\n\n');
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0, max_tokens: 800,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: RELEVANCE_SYSTEM },
        { role: 'user', content: `QUESTION: ${String(question).slice(0, 2000)}\n\nPASSAGES:\n${passages.slice(0, 10000)}` },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    const verdicts = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
    return retrievedContexts.map((_, i) => {
      const v = verdicts.find(x => x?.idx === i + 1) || verdicts[i];
      return !!v?.relevant;
    });
  } catch (err) {
    console.warn('[ragas/context-precision] judge failed:', err.message);
    return retrievedContexts.map(() => false);
  }
}

/**
 * Compute context precision.
 *
 * @param {object} args
 * @param {object} args.openai
 * @param {string} args.question
 * @param {Array} args.retrievedContexts — ordered by retrieval rank
 * @param {string} [args.model]
 *
 * @returns {Promise<{
 *   score: number,                   // ∈ [0, 1]
 *   relevances: boolean[],           // per-chunk relevance verdicts
 *   precision_at_k: number[],        // cumulative p@k
 * }>}
 */
async function compute({ openai, question, retrievedContexts, model = DEFAULT_MODEL }) {
  if (!Array.isArray(retrievedContexts) || retrievedContexts.length === 0) {
    return { score: 0, relevances: [], precision_at_k: [] };
  }
  const relevances = await judgeRelevance({ openai, question, retrievedContexts, model });

  // Cumulative precision@k for k = 1..N
  let cumRel = 0;
  const pAtK = relevances.map((rel, i) => {
    if (rel) cumRel++;
    return cumRel / (i + 1);
  });

  // RAGAS formula: weighted by the indicator of relevance at position k.
  // score = sum(p@k * rel[k]) / sum(rel[k])   when any relevant exists
  //       = 0                                  otherwise
  const nRelevant = relevances.filter(Boolean).length;
  if (nRelevant === 0) {
    return { score: 0, relevances, precision_at_k: pAtK };
  }
  let weightedSum = 0;
  for (let i = 0; i < relevances.length; i++) {
    if (relevances[i]) weightedSum += pAtK[i];
  }
  return {
    score: weightedSum / nRelevant,
    relevances,
    precision_at_k: pAtK,
  };
}

module.exports = {
  compute,
  judgeRelevance,
  RELEVANCE_SYSTEM,
};
