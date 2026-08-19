'use strict';

/**
 * nli-faithfulness — claim ⊨ evidence verifier.
 *
 * Why:
 *   Citations + structured summaries are only as trustworthy as the
 *   alignment between a generated `claim` and its `evidence` passage.
 *   The existing `contradiction-detector.js` does keyword + heuristic
 *   matching; that misses paraphrase, negation, and quantifier scope
 *   ("most" vs "all", "rose" vs "fell"). Fine-tuned NLI models score
 *   each (claim, evidence) pair into entailment / contradiction /
 *   neutral, which RAGAS uses for its faithfulness metric and which
 *   beats LLM prompting on small models.
 *
 * Two backends, same envelope:
 *
 *   1. Hugging Face Inference API (preferred when HUGGINGFACE_API_TOKEN
 *      is set). Hits a hosted NLI model, e.g.
 *      cross-encoder/nli-deberta-v3-base. Cheapest signal, smallest
 *      latency footprint, no token spend on a generative LLM.
 *
 *   2. LLM-as-judge fallback (when no HF token but options.openai is
 *      provided). Uses Structured Outputs strict schema so the JSON
 *      shape is guaranteed.
 *
 *   3. nli_disabled when neither backend is configured. Caller
 *      decides whether to surface or silently degrade.
 *
 * Public API:
 *   verifyClaim({ claim, evidence, options })
 *     → { label, score, reason, backend }
 *     label ∈ {entailment, contradiction, neutral}
 *     score ∈ [0,1]
 *
 *   verifyClaimsBatch({ items, options })
 *     → Array<{ ...verdict, index, claim, evidence }>
 *
 *   normalizeHfResponse(raw, models?) → { label, score }
 *   pickBackend(env) → 'huggingface' | 'llm' | null
 */

const { asyncPool } = require('../../utils/async-pool');

const DEFAULT_HF_MODEL = process.env.SIRAGPT_NLI_HF_MODEL || 'cross-encoder/nli-deberta-v3-base';
const DEFAULT_HF_BASE = process.env.HUGGINGFACE_API_BASE || 'https://api-inference.huggingface.co';
const DEFAULT_LLM_MODEL = process.env.SIRAGPT_NLI_LLM_MODEL || 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.SIRAGPT_NLI_TIMEOUT_MS, 10) || 15_000;
const DEFAULT_BATCH_CONCURRENCY = Math.max(1, Number.parseInt(process.env.SIRAGPT_NLI_CONCURRENCY, 10) || 4);

const LABELS = Object.freeze(['entailment', 'contradiction', 'neutral']);

const LLM_SYSTEM_PROMPT = `You are a fact-checking judge. Given a CLAIM and an EVIDENCE passage from a document, decide whether the evidence supports, contradicts, or is silent about the claim. Be strict: if the evidence does not directly state or imply the claim, answer "neutral".

OUTPUT (STRICT JSON):
{ "label": "entailment" | "contradiction" | "neutral",
  "score": 0.0-1.0,
  "reason": "<one short sentence quoting the evidence span used to decide>" }

Rules:
- "entailment" — the evidence directly says or clearly implies the claim.
- "contradiction" — the evidence asserts the OPPOSITE of the claim.
- "neutral" — the evidence is unrelated or insufficient (default for ambiguity).
- score reflects your confidence in the chosen label, NOT how supportive the evidence is.
- Quote the evidence span verbatim in the reason; truncate at 200 chars.
- Do NOT use external knowledge; rely only on the evidence text.`;

const LLM_STRICT_SCHEMA = Object.freeze({
  name: 'nli_verdict',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      label: { type: 'string', enum: ['entailment', 'contradiction', 'neutral'] },
      score: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['label', 'score', 'reason'],
  },
});

function pickBackend(env = process.env) {
  if ((env.HUGGINGFACE_API_TOKEN || '').trim()) return 'huggingface';
  return null;
}

function clampScore(s) {
  if (typeof s !== 'number' || !Number.isFinite(s)) return 0;
  if (s < 0) return 0;
  if (s > 1) return 1;
  return s;
}

/**
 * Map common HF NLI model label vocabularies to our canonical 3-class
 * set. Different model authors capitalise differently and use slight
 * variants; we lower-case + map a small allowlist.
 */
function canonicaliseLabel(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (s === 'entailment' || s === 'entail' || s === 'entailment_score') return 'entailment';
  if (s === 'contradiction' || s === 'contradict') return 'contradiction';
  if (s === 'neutral' || s === 'unrelated') return 'neutral';
  return null;
}

/**
 * HF Inference API responses for sequence classification look like:
 *   [{ label: "ENTAILMENT", score: 0.95 }, { label: "NEUTRAL", ... }, ...]
 * Some models nest a level deeper: `[[ { label, score }, ... ]]`. We
 * unwrap defensively, then pick the highest-scoring known label.
 *
 * Returns the canonical envelope `{ label, score }` or null if the
 * payload had no recognisable labels.
 */
function normalizeHfResponse(raw) {
  let arr = raw;
  while (Array.isArray(arr) && arr.length === 1 && Array.isArray(arr[0])) arr = arr[0];
  if (!Array.isArray(arr)) return null;
  let bestLabel = null;
  let bestScore = -Infinity;
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const label = canonicaliseLabel(item.label);
    if (!label) continue;
    const score = typeof item.score === 'number' ? item.score : NaN;
    if (!Number.isFinite(score)) continue;
    if (score > bestScore) {
      bestScore = score;
      bestLabel = label;
    }
  }
  if (!bestLabel) return null;
  return { label: bestLabel, score: clampScore(bestScore) };
}

async function verifyViaHuggingface({ claim, evidence, options }) {
  const apiKey = options.huggingfaceToken || process.env.HUGGINGFACE_API_TOKEN;
  if (!apiKey) {
    const err = new Error('nli-faithfulness HF: HUGGINGFACE_API_TOKEN missing');
    err.code = 'nli_huggingface_disabled';
    throw err;
  }
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const err = new Error('nli-faithfulness HF: no fetch implementation available');
    err.code = 'nli_huggingface_disabled';
    throw err;
  }
  const model = options.hfModel || DEFAULT_HF_MODEL;
  const apiBase = (options.hfApiBase || DEFAULT_HF_BASE).replace(/\/+$/, '');
  // For NLI, premise = evidence, hypothesis = claim. The cross-encoder
  // input convention is "premise [SEP] hypothesis"; the HF inference
  // pipeline accepts a single string and inserts the [SEP] for us.
  const inputs = `${evidence} [SEP] ${claim}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('nli HF timeout')), Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let response;
  try {
    response = await fetchImpl(`${apiBase}/models/${encodeURIComponent(model)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ inputs, options: { wait_for_model: true } }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const wrapped = new Error(`nli-faithfulness HF network error: ${err && err.message}`);
    wrapped.code = 'nli_huggingface_failed';
    wrapped.cause = err;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  if (!response || !response.ok) {
    const status = response?.status ?? 0;
    const err = new Error(`nli-faithfulness HF HTTP ${status}`);
    err.code = 'nli_huggingface_failed';
    err.status = status;
    throw err;
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch (err) {
    const wrapped = new Error('nli-faithfulness HF: response was not valid JSON');
    wrapped.code = 'nli_huggingface_invalid_response';
    wrapped.cause = err;
    throw wrapped;
  }
  const verdict = normalizeHfResponse(parsed);
  if (!verdict) {
    const err = new Error('nli-faithfulness HF: response had no recognisable labels');
    err.code = 'nli_huggingface_invalid_response';
    throw err;
  }
  return { ...verdict, reason: '', backend: 'huggingface' };
}

async function verifyViaLlm({ claim, evidence, options }) {
  const openai = options.openai;
  if (!openai || !openai.chat || !openai.chat.completions || typeof openai.chat.completions.create !== 'function') {
    const err = new Error('nli-faithfulness LLM: options.openai is required');
    err.code = 'nli_llm_no_client';
    throw err;
  }
  const useStrictSchema = options.useStrictSchema !== false;
  const responseFormat = useStrictSchema
    ? { type: 'json_schema', json_schema: LLM_STRICT_SCHEMA }
    : { type: 'json_object' };

  const userPrompt = [
    'CLAIM:', claim,
    '',
    'EVIDENCE:', evidence,
  ].join('\n');

  let resp;
  try {
    resp = await openai.chat.completions.create({
      model: options.llmModel || DEFAULT_LLM_MODEL,
      temperature: 0.0,
      max_tokens: 300,
      response_format: responseFormat,
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
  } catch (err) {
    const wrapped = new Error(`nli-faithfulness LLM call failed: ${err && err.message}`);
    wrapped.code = 'nli_llm_failed';
    wrapped.cause = err;
    throw wrapped;
  }

  const raw = resp?.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const wrapped = new Error('nli-faithfulness LLM: response was not valid JSON');
    wrapped.code = 'nli_llm_invalid_response';
    wrapped.cause = err;
    throw wrapped;
  }

  const label = canonicaliseLabel(parsed?.label) || 'neutral';
  const score = clampScore(parsed?.score);
  const reason = String(parsed?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  return { label, score, reason, backend: 'llm' };
}

/**
 * Single-pair verification.
 *
 * @param {object} args
 * @param {string} args.claim
 * @param {string} args.evidence
 * @param {object} [args.options]
 * @param {'huggingface'|'llm'|'auto'} [args.options.backend='auto']
 * @param {object} [args.options.openai]            required for backend 'llm'
 * @param {string} [args.options.huggingfaceToken]  override env
 * @param {string} [args.options.hfModel]
 * @param {string} [args.options.llmModel]
 * @param {Function} [args.options.fetchImpl]
 * @param {AbortSignal} [args.options.signal]
 * @param {number} [args.options.timeoutMs]
 * @param {boolean} [args.options.useStrictSchema=true]
 *
 * @returns {Promise<{ label, score, reason, backend }>}
 */
async function verifyClaim({ claim, evidence, options = {} } = {}) {
  if (typeof claim !== 'string' || claim.trim().length === 0) {
    const err = new Error('verifyClaim: claim is required');
    err.code = 'nli_bad_args';
    throw err;
  }
  if (typeof evidence !== 'string' || evidence.trim().length === 0) {
    const err = new Error('verifyClaim: evidence is required');
    err.code = 'nli_bad_args';
    throw err;
  }

  const backendChoice = options.backend || 'auto';
  let backend = backendChoice;
  if (backend === 'auto') backend = pickBackend(process.env) || (options.openai ? 'llm' : null);
  if (!backend) {
    const err = new Error('nli-faithfulness disabled: set HUGGINGFACE_API_TOKEN or pass options.openai');
    err.code = 'nli_disabled';
    throw err;
  }

  if (backend === 'huggingface') return verifyViaHuggingface({ claim, evidence, options });
  if (backend === 'llm') return verifyViaLlm({ claim, evidence, options });
  const err = new Error(`verifyClaim: unknown backend "${backend}"`);
  err.code = 'nli_bad_args';
  throw err;
}

/**
 * Bounded-concurrency batch verification. Each item is
 * `{ claim, evidence }`. Returns one verdict per input, in input
 * order. Failed items get `{ label: 'neutral', score: 0, reason: '',
 * backend: 'error', error: '<message>' }` so the caller can render
 * partial results without branching on rejected promises.
 */
async function verifyClaimsBatch({ items, options = {} } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : DEFAULT_BATCH_CONCURRENCY;

  const results = await asyncPool({
    items,
    concurrency,
    signal: options.signal,
    mode: 'settle',
    worker: async (item, index) => {
      try {
        const verdict = await verifyClaim({
          claim: item?.claim,
          evidence: item?.evidence,
          options,
        });
        return { ...verdict, index, claim: item?.claim, evidence: item?.evidence };
      } catch (err) {
        return {
          label: 'neutral',
          score: 0,
          reason: '',
          backend: 'error',
          error: err && err.message,
          index,
          claim: item?.claim,
          evidence: item?.evidence,
        };
      }
    },
  });

  return results.map((r) => (r && r.status === 'fulfilled' ? r.value : {
    label: 'neutral', score: 0, reason: '', backend: 'error',
    error: r && r.reason && r.reason.message,
  }));
}

module.exports = {
  verifyClaim,
  verifyClaimsBatch,
  normalizeHfResponse,
  canonicaliseLabel,
  pickBackend,
  LABELS,
  LLM_STRICT_SCHEMA,
  LLM_SYSTEM_PROMPT,
  DEFAULT_HF_MODEL,
  DEFAULT_LLM_MODEL,
};
