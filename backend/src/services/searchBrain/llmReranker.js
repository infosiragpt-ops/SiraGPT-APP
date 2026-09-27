/**
 * llmReranker — Phase 3 of WebGLM. Batched 0-10 relevance rubric over
 * the deduped candidate pool. Final score combines rerank + provider
 * rank + log-scaled citations + open-access boost.
 *
 * Falls back to heuristic sort when LLM is unavailable or batch fails.
 */

const { DEFAULT_WEIGHTS } = require("./types");

const RERANKER_SYSTEM = `You rerank academic search results for relevance to a user's query.

Output format — STRICT JSON:
{ "scores": [ { "idx": <1-indexed>, "score": <0..10>, "reason": "<≤ 15 words>" } ] }

Rubric:
  10 = directly answers the query with strong evidence
  7-9 = closely related, likely useful
  4-6 = same topic but tangential
  1-3 = loose topical overlap
  0   = off-topic

Rules:
- Score EVERY candidate.
- Use the full 0..10 range — don't cluster at 7.
- The central topic, population and context in the query are mandatory.
- A candidate missing a central concept cannot score above 3, even if its
  methodology, publication year or study type matches a preference.
- Use only the title + abstract snippet shown.`;

function parseJson(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function formatBatch(batch) {
  return batch
    .map((r, i) => {
      const snippet = (r.abstract || "").replace(/\s+/g, " ").slice(0, 500);
      const year = r.year ? ` (${r.year})` : "";
      const authors = Array.isArray(r.authors) ? r.authors.slice(0, 3).join(", ") : "";
      return `[${i + 1}] ${r.title}${year}\n    ${authors}\n    ${snippet}`;
    })
    .join("\n\n");
}

function validateScores(raw) {
  if (!raw || !Array.isArray(raw.scores)) return [];
  const out = [];
  for (const s of raw.scores) {
    if (!s || typeof s !== "object") continue;
    const idx = typeof s.idx === "number" ? s.idx : Number(s.idx);
    const score = typeof s.score === "number" ? s.score : Number(s.score);
    if (!Number.isFinite(idx) || !Number.isFinite(score)) continue;
    out.push({
      idx,
      score: Math.max(0, Math.min(10, score)),
      reason: typeof s.reason === "string" ? s.reason.slice(0, 200) : undefined,
    });
  }
  return out;
}

function combinedScore(result, rerankScore, weights) {
  const hasRerank = typeof rerankScore === "number";
  const rerank = hasRerank ? rerankScore / 10 : 0;
  const providerRankScore = 1 / (1 + (result.providerRank ?? 0));
  const citationScore = Math.min(1, Math.log1p(result.citationCount ?? 0) / Math.log1p(1000));
  const oaBoost = result.openAccess ? 1 : 0;
  const deterministicQuality = Math.max(0, Math.min(1,
    Number.isFinite(result.qualityScore)
      ? result.qualityScore
      : (Number.isFinite(result.retrievalScore) ? result.retrievalScore : 0)
  ));
  const corroboration = Math.min(1, Math.max(0, (Number(result.sourceCount) || 1) - 1) / 3);
  const hasTopicalScore = Number.isFinite(result.retrievalScore);
  const topicalAlignment = hasTopicalScore
    ? Math.max(0, Math.min(1, Number(result.retrievalScore)))
    : 1;
  // The LLM may correctly notice a requested methodology while overlooking
  // that the paper is about another subject. Relevance is therefore a gate on
  // every secondary signal: citations, authority and even the LLM score cannot
  // rescue a result that barely matches the user's central topic.
  const topicalFactor = hasTopicalScore ? (0.2 + topicalAlignment * 0.8) : 1;
  const supportingSignals = (
    corroboration * 0.15 +
    weights.providerRank * providerRankScore +
    weights.citations * citationScore +
    weights.openAccessBoost * oaBoost
  ) * topicalFactor;
  return (
    weights.rerank * rerank * topicalFactor +
    deterministicQuality * (hasRerank ? 1.25 : 1.5) +
    supportingSignals
  );
}

const RERANK_CONCURRENCY = 3;
// Whole re-ranking budget: batches not scored by then keep the deterministic
// order instead of holding the search open.
const RERANK_DEADLINE_MS = 45_000;

function rerankDeadlineMs() {
  const value = Math.floor(Number(process.env.SEARCH_BRAIN_RERANK_DEADLINE_MS));
  return Number.isFinite(value) && value >= 1000 ? value : RERANK_DEADLINE_MS;
}

/**
 * @param {object} args
 * @param {string} args.query
 * @param {import("./types").NormalisedResult[]} args.results
 * @param {Partial<import("./types").SearchBrainWeights>} [args.weights]
 * @param {number} [args.batchSize=10]
 * @param {(args:{system:string,user:string,temperature?:number,maxTokens?:number,signal?:AbortSignal})=>Promise<{content:string}>} [args.callLLM]
 * @param {AbortSignal} [args.signal]   stop launching batches (and cancel the in-flight calls) once aborted
 * @param {number} [args.concurrency=3] batches scored at the same time
 * @param {number} [args.deadlineMs=45000] stop scoring (and cancel in-flight calls) after this long
 * @returns {Promise<{results: import("./types").NormalisedResult[], reranked: boolean}>}
 */
async function rerankResults({ query, results, weights, batchSize = 10, callLLM, signal, concurrency = RERANK_CONCURRENCY, deadlineMs = rerankDeadlineMs() }) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const pool = Array.isArray(results) ? [...results] : [];
  if (pool.length === 0) return { results: [], reranked: false };

  if (!callLLM) {
    pool.sort((a, b) => combinedScore(b, undefined, w) - combinedScore(a, undefined, w));
    return { results: pool, reranked: false };
  }

  // Batches are independent: score a few at a time instead of one after
  // another (10 sequential calls kept the academic search silent for over a
  // minute), and stop as soon as the client is gone.
  const batches = [];
  for (let start = 0; start < pool.length; start += batchSize) batches.push(pool.slice(start, start + batchSize));
  let scoredCount = 0;
  let next = 0;
  const deadline = AbortSignal.timeout(Math.max(1, Math.floor(Number(deadlineMs)) || RERANK_DEADLINE_MS));
  const callSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const scoreBatches = async () => {
    while (next < batches.length && !callSignal.aborted) {
      const batch = batches[next++];
      try {
        const out = await callLLM({
          system: RERANKER_SYSTEM,
          user: `QUERY:\n${query}\n\nCANDIDATES:\n${formatBatch(batch)}`,
          temperature: 0,
          maxTokens: 700,
          signal: callSignal,
        });
        const parsed = parseJson((out && out.content) || "");
        const scores = validateScores(parsed);
        for (const s of scores) {
          const target = batch[s.idx - 1];
          if (target) {
            target.rerankScore = s.score;
            scoredCount += 1;
          }
        }
      } catch {
        // leave rerankScore undefined for this batch
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(Number(concurrency)) || 1, batches.length));
  await Promise.all(Array.from({ length: workers }, scoreBatches));

  pool.sort((a, b) => combinedScore(b, b.rerankScore, w) - combinedScore(a, a.rerankScore, w));
  return { results: pool, reranked: scoredCount > 0 };
}

module.exports = {
  rerankResults,
  RERANKER_SYSTEM,
  INTERNAL: { parseJson, formatBatch, validateScores, combinedScore },
};
