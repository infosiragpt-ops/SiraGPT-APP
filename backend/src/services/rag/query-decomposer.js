'use strict';

/**
 * query-decomposer — least-to-most / DecomposeRAG style query splitting.
 *
 * Why:
 *   Multi-hop questions ("What is the policy on refunds and how does
 *   it interact with our Q2 2025 churn discount?") under-perform on
 *   single-shot RAG retrieval — one query embedding can't surface the
 *   distinct evidence each hop needs. Decomposing the question into
 *   2–5 atomic sub-queries before retrieval lifts multi-hop benchmarks
 *   by +36.7% MRR@10 and +11.6% F1 (https://arxiv.org/abs/2507.00355).
 *
 * What this does (and does NOT):
 *   - Calls an LLM with a strict JSON schema prompt to produce
 *     ordered sub-queries, a short rationale, and a `combine` hint
 *     that tells the caller how to merge the per-sub-query evidence
 *     (concat | intersect | sequence).
 *   - Does NOT execute retrieval — that's the caller's job, intentionally.
 *     Keeping the decomposer pure makes it composable with hybrid /
 *     contextual / reranked retrieval downstream and trivial to unit-test.
 *
 * Public API:
 *   decomposeQuery({ openai, question, options })
 *     → { original, subqueries[], rationale, combine, meta }
 *
 *   normalizeDecomposition(parsed, original, modelUsed)
 *     pure helper for parsing arbitrary LLM output
 *
 * Failure modes (Error.code):
 *   query_decomposer_no_client     missing openai client
 *   query_decomposer_empty         missing / blank question
 *   query_decomposer_llm_failed    upstream SDK threw
 *   query_decomposer_invalid_json  model returned non-JSON
 */

const DEFAULT_MODEL = process.env.SIRAGPT_DECOMPOSER_MODEL || 'gpt-4o-mini';
const DEFAULT_MAX_TOKENS = Number.parseInt(process.env.SIRAGPT_DECOMPOSER_MAX_TOKENS, 10) || 600;
const MAX_SUBQUERIES = 5;

const SYSTEM_PROMPT = `You decompose a single user question into atomic sub-questions for retrieval-augmented generation. Each sub-question retrieves separately; the answer is then synthesised across sub-queries.

OUTPUT FORMAT (STRICT JSON; no prose, no code fences):
{
  "subqueries": ["<atomic question 1>", ...],
  "rationale": "<one sentence on why these splits>",
  "combine": "concat" | "intersect" | "sequence"
}

GUIDELINES:
- 1 to 5 sub-questions. Use 1 when the original is already atomic.
- Each sub-question must be:
  * answerable on its own from a single passage
  * shorter than the original
  * written in the original language
- "combine" hint:
  * concat    — independent facts that should ALL appear in the final answer
  * intersect — looking for a single passage that satisfies all sub-queries (rare)
  * sequence  — the answer to sub-query N depends on sub-query N-1's answer
- Do NOT include answers, citations, or speculation. Only the question splits.
- Return the JSON object DIRECTLY.`;

function clampSubqueries(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const q = item.replace(/\s+/g, ' ').trim();
    if (q.length === 0) continue;
    if (q.length > 280) continue; // hard cap so the LLM can't smuggle a paragraph
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= MAX_SUBQUERIES) break;
  }
  return out;
}

/**
 * Coerce arbitrary LLM output into the strict decomposition shape.
 * Fills sensible defaults so callers never branch on missing keys.
 */
function normalizeDecomposition(parsed, original, modelUsed) {
  const subqueries = clampSubqueries(parsed?.subqueries);
  // If the model emitted zero usable subqueries, keep the original as
  // the single subquery — the caller still gets a valid envelope.
  if (subqueries.length === 0) subqueries.push(original.replace(/\s+/g, ' ').trim());

  const combineRaw = String(parsed?.combine || '').toLowerCase().trim();
  const combine = ['concat', 'intersect', 'sequence'].includes(combineRaw)
    ? combineRaw
    : 'concat';

  const rationale = typeof parsed?.rationale === 'string'
    ? parsed.rationale.replace(/\s+/g, ' ').trim().slice(0, 280)
    : '';

  return {
    original,
    subqueries,
    rationale,
    combine,
    meta: { model: modelUsed, subqueryCount: subqueries.length },
  };
}

/**
 * Decompose `question` into atomic sub-queries.
 *
 * @param {object} args
 * @param {object} args.openai           SDK client (chat.completions.create)
 * @param {string} args.question         the user's multi-hop question
 * @param {object} [args.options]
 * @param {string} [args.options.model]
 * @param {number} [args.options.maxTokens]
 * @param {string} [args.options.languageHint]
 *
 * @returns {Promise<{
 *   original: string,
 *   subqueries: string[],
 *   rationale: string,
 *   combine: 'concat'|'intersect'|'sequence',
 *   meta: { model: string, subqueryCount: number }
 * }>}
 */
async function decomposeQuery({ openai, question, options = {} } = {}) {
  if (!openai || !openai.chat || !openai.chat.completions || typeof openai.chat.completions.create !== 'function') {
    const err = new Error('decomposeQuery: openai client is required');
    err.code = 'query_decomposer_no_client';
    throw err;
  }
  const original = String(question || '').trim();
  if (!original) {
    const err = new Error('decomposeQuery: question is empty');
    err.code = 'query_decomposer_empty';
    throw err;
  }

  const model = options.model || DEFAULT_MODEL;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : DEFAULT_MAX_TOKENS;
  const languageHint = String(options.languageHint || '').trim();

  const userPrompt = [
    languageHint ? `Probable language: ${languageHint}` : null,
    'Question:',
    original,
  ].filter(Boolean).join('\n');

  let resp;
  try {
    resp = await openai.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
  } catch (err) {
    const wrapped = new Error(`decomposeQuery LLM call failed: ${err && err.message}`);
    wrapped.code = 'query_decomposer_llm_failed';
    wrapped.cause = err;
    throw wrapped;
  }

  const raw = resp?.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const wrapped = new Error(`decomposeQuery could not parse JSON: ${err && err.message}`);
    wrapped.code = 'query_decomposer_invalid_json';
    wrapped.cause = err;
    wrapped.rawLength = raw.length;
    throw wrapped;
  }

  return normalizeDecomposition(parsed, original, model);
}

module.exports = {
  decomposeQuery,
  normalizeDecomposition,
  clampSubqueries,
  SYSTEM_PROMPT,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  MAX_SUBQUERIES,
};
