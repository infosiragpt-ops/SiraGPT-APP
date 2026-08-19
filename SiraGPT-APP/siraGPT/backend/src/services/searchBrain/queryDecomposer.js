/**
 * queryDecomposer — Phase 1 of WebGLM. Rewrites the user's raw query
 * into 3-5 bilingual (ES + EN) sub-queries so retrieval hits both
 * Latin American and English-dominant academic indexes.
 *
 * Degrades safely: if the LLM is unavailable, malformed, or returns
 * nothing, falls back to [{ text: originalQuery }] so retrieval still
 * runs.
 */

const DECOMPOSER_SYSTEM = `You rewrite a user's academic search query into 3-5 retrieval-friendly sub-queries.

Output format — STRICT JSON:
{
  "subqueries": [
    { "text": "<sub-query in Spanish>", "language": "es", "rationale": "<short>" },
    { "text": "<sub-query in English>", "language": "en", "rationale": "<short>" }
  ]
}

Rules:
- Cover different angles: terminology, broader concept, narrower specialisation, methodology, entities.
- Mix "es" and "en" — at least one of each.
- Each sub-query 4-12 words.
- Keep named entities (people, institutions, drug names, numbers) intact.
- 3 to 5 sub-queries.`;

function parseJson(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function detectLanguage(q, hint) {
  if (hint === "es" || hint === "en") return hint;
  if (/[áéíóúñ¿¡]/i.test(q)) return "es";
  return "en";
}

function validateSubqueries(raw) {
  if (!raw || !Array.isArray(raw.subqueries)) return [];
  const out = [];
  for (const item of raw.subqueries) {
    if (!item || typeof item !== "object") continue;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    const language = item.language === "en" || item.language === "es" ? item.language : null;
    if (!text || !language) continue;
    out.push({
      text,
      language,
      rationale: typeof item.rationale === "string" ? item.rationale.slice(0, 200) : undefined,
    });
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * @param {object} args
 * @param {string} args.query
 * @param {"es"|"en"|"auto"} [args.language]
 * @param {number} [args.maxSubQueries=5]
 * @param {(args:{system:string,user:string,temperature?:number,maxTokens?:number})=>Promise<{content:string}>} [args.callLLM]
 */
async function decomposeQuery({ query, language, maxSubQueries = 5, callLLM }) {
  if (!query || typeof query !== "string" || query.trim().length === 0) return [];
  const fallback = [{ text: query.trim(), language: detectLanguage(query, language) }];
  if (!callLLM) return fallback;
  try {
    const { content } = await callLLM({
      system: DECOMPOSER_SYSTEM,
      user: `ORIGINAL QUERY:\n${query.slice(0, 1500)}\n\nProduce ${maxSubQueries} sub-queries.`,
      temperature: 0.2,
      maxTokens: 500,
    });
    const parsed = parseJson(content || "");
    const subs = validateSubqueries(parsed);
    if (subs.length === 0) return fallback;
    return subs.slice(0, maxSubQueries);
  } catch {
    return fallback;
  }
}

module.exports = {
  decomposeQuery,
  DECOMPOSER_SYSTEM,
  INTERNAL: { parseJson, detectLanguage, validateSubqueries },
};
