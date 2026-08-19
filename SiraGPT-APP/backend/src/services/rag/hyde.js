"use strict";

/**
 * hyde — Hypothetical Document Embedding query expansion.
 *
 * Cosine retrieval suffers when the user query and the relevant chunk
 * live in different "registers" — the user asks "habla del tema X"
 * (vague, conversational), but the chunk is a dense paragraph using
 * domain vocabulary. The two embeddings end up far apart even though
 * the chunk is exactly what the user wants.
 *
 * HyDE (Gao et al. 2022) solves this by asking a cheap LLM to *write*
 * a few hypothetical answers to the query, then embedding those. The
 * hypothetical answer naturally inherits the register of a real
 * answer, so its embedding lands much closer to the relevant chunks.
 *
 * Design notes:
 *   - We average the original-query embedding with the hypothetical
 *     embeddings (configurable weight). Pure-HyDE drops the original,
 *     but a blend is more robust when the LLM hallucinates off-topic.
 *   - We bypass HyDE for long queries (>= 200 chars by default): if the
 *     user already wrote a paragraph, the register problem is gone.
 *   - The LLM call is caller-injected (`generateFn`) and the embedder
 *     is caller-injected (`embedFn`). This module is pure orchestration
 *     so tests can run with deterministic stubs.
 *   - All failures degrade to "return the original embedding" — HyDE
 *     should never make retrieval worse than the baseline.
 */

const DEFAULT_NUM_HYPOTHETICALS = 3;
const DEFAULT_HYDE_WEIGHT = 0.6;       // weight given to averaged hypotheticals
const DEFAULT_BYPASS_CHARS = 200;
const DEFAULT_MAX_TOKENS = 120;        // per hypothetical answer

const HYDE_PROMPT_TEMPLATE = (q, n) => (
  `You are a helpful assistant. Write ${n} short, distinct hypothetical answers ` +
  `(one per line, no numbering, no preface) to the following question. ` +
  `Each answer should be 1-3 sentences in the register of an authoritative ` +
  `passage from a reference document. Do not say you are unsure.\n\n` +
  `Question: ${q}\n\nAnswers:`
);

/**
 * Generate hypothetical answers for a query and return the augmented
 * query embedding plus diagnostic trace.
 *
 * @param {object} args
 * @param {string} args.query
 * @param {number[]} args.queryEmbedding   embedding of the raw query
 * @param {Function} args.generateFn       async (prompt, opts) → string  (LLM call)
 * @param {Function} args.embedFn          async (text) → number[]
 * @param {number} [args.n]
 * @param {number} [args.weight]           0..1 weight for HyDE side
 * @param {number} [args.bypassChars]
 * @param {number} [args.maxTokens]
 * @returns {Promise<{embedding: number[], hypotheticals: string[], trace: object}>}
 */
async function expandQuery({
  query,
  queryEmbedding,
  generateFn,
  embedFn,
  n = DEFAULT_NUM_HYPOTHETICALS,
  weight = DEFAULT_HYDE_WEIGHT,
  bypassChars = DEFAULT_BYPASS_CHARS,
  maxTokens = DEFAULT_MAX_TOKENS,
} = {}) {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("hyde: query required");
  }
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    throw new Error("hyde: queryEmbedding required");
  }

  const trace = {
    bypassed: false,
    reason: null,
    hypothetical_count: 0,
    weight,
    query_length: query.length,
  };

  // Guard: long queries already carry enough register signal.
  if (query.length >= bypassChars) {
    trace.bypassed = true;
    trace.reason = "query_too_long";
    return { embedding: queryEmbedding, hypotheticals: [], trace };
  }

  if (typeof generateFn !== "function" || typeof embedFn !== "function") {
    trace.bypassed = true;
    trace.reason = "missing_fns";
    return { embedding: queryEmbedding, hypotheticals: [], trace };
  }

  let hypotheticals = [];
  try {
    const raw = await generateFn(HYDE_PROMPT_TEMPLATE(query, n), {
      maxTokens: maxTokens * n,
      temperature: 0.7,
    });
    hypotheticals = parseHypotheticals(raw, n);
  } catch (err) {
    trace.bypassed = true;
    trace.reason = `generate_failed:${err && err.message ? err.message : "unknown"}`;
    return { embedding: queryEmbedding, hypotheticals: [], trace };
  }

  if (hypotheticals.length === 0) {
    trace.bypassed = true;
    trace.reason = "no_hypotheticals";
    return { embedding: queryEmbedding, hypotheticals: [], trace };
  }

  let hydeEmbeddings;
  try {
    hydeEmbeddings = await Promise.all(hypotheticals.map(h => embedFn(h)));
  } catch (err) {
    trace.bypassed = true;
    trace.reason = `embed_failed:${err && err.message ? err.message : "unknown"}`;
    return { embedding: queryEmbedding, hypotheticals: [], trace };
  }

  const valid = hydeEmbeddings.filter(
    e => Array.isArray(e) && e.length === queryEmbedding.length,
  );
  if (valid.length === 0) {
    trace.bypassed = true;
    trace.reason = "embed_dim_mismatch";
    return { embedding: queryEmbedding, hypotheticals: [], trace };
  }

  const hydeMean = meanVector(valid);
  const blended = blend(queryEmbedding, hydeMean, weight);
  const normalized = normalize(blended);

  trace.hypothetical_count = valid.length;
  return { embedding: normalized, hypotheticals, trace };
}

function parseHypotheticals(raw, expectedN) {
  if (typeof raw !== "string") return [];
  const lines = raw
    .split(/\r?\n+/)
    .map(s => s.replace(/^\s*[-*\d.)]+\s*/, "").trim())
    .filter(s => s.length >= 8);
  // Cap to expected count to bound embedding cost even if the model
  // overproduced.
  return lines.slice(0, Math.max(expectedN, 1));
}

function meanVector(vectors) {
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

function blend(a, b, weightB) {
  const w = clamp(weightB, 0, 1);
  const wa = 1 - w;
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * wa + b[i] * w;
  return out;
}

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n === 0) return v.slice();
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function isEnabled(env = process.env) {
  const v = String(env.SIRA_HYDE_ENABLED || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

module.exports = {
  expandQuery,
  isEnabled,
  // exposed for tests
  parseHypotheticals,
  meanVector,
  blend,
  normalize,
  HYDE_PROMPT_TEMPLATE,
  DEFAULT_NUM_HYPOTHETICALS,
  DEFAULT_HYDE_WEIGHT,
  DEFAULT_BYPASS_CHARS,
};
