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
  return (
    weights.rerank * rerank +
    deterministicQuality * (hasRerank ? 0.8 : 1.2) +
    corroboration * 0.15 +
    weights.providerRank * providerRankScore +
    weights.citations * citationScore +
    weights.openAccessBoost * oaBoost
  );
}

/**
 * @param {object} args
 * @param {string} args.query
 * @param {import("./types").NormalisedResult[]} args.results
 * @param {Partial<import("./types").SearchBrainWeights>} [args.weights]
 * @param {number} [args.batchSize=10]
 * @param {(args:{system:string,user:string,temperature?:number,maxTokens?:number})=>Promise<{content:string}>} [args.callLLM]
 * @returns {Promise<{results: import("./types").NormalisedResult[], reranked: boolean}>}
 */
async function rerankResults({ query, results, weights, batchSize = 10, callLLM }) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const pool = Array.isArray(results) ? [...results] : [];
  if (pool.length === 0) return { results: [], reranked: false };

  if (!callLLM) {
    pool.sort((a, b) => combinedScore(b, undefined, w) - combinedScore(a, undefined, w));
    return { results: pool, reranked: false };
  }

  let scoredCount = 0;
  for (let start = 0; start < pool.length; start += batchSize) {
    const batch = pool.slice(start, start + batchSize);
    try {
      const { content } = await callLLM({
        system: RERANKER_SYSTEM,
        user: `QUERY:\n${query}\n\nCANDIDATES:\n${formatBatch(batch)}`,
        temperature: 0,
        maxTokens: 700,
      });
      const parsed = parseJson(content || "");
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

  pool.sort((a, b) => combinedScore(b, b.rerankScore, w) - combinedScore(a, a.rerankScore, w));
  return { results: pool, reranked: scoredCount > 0 };
}

module.exports = {
  rerankResults,
  RERANKER_SYSTEM,
  INTERNAL: { parseJson, formatBatch, validateScores, combinedScore },
};
