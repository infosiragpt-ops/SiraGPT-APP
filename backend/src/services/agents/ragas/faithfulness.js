/**
 * ragas/faithfulness — the "answer is grounded in the retrieved
 * context" metric from Es et al. 2024 (RAGAS: Automated Evaluation
 * of Retrieval Augmented Generation).
 *
 * NOT the same as our truthfulness.js despite the overlap:
 *   - truthfulness.js verifies claims against ANY ground-truth context
 *     (curated source passages in closed-domain benchmarks, etc.).
 *   - faithfulness is the RAG-specific metric: given (question, answer,
 *     retrieved_chunks), what FRACTION of claims in the answer are
 *     actually supported by the RETRIEVED chunks?
 *
 * If the retrieval step surfaced the right docs but the LLM hallucinated
 * an extra fact not in them, faithfulness drops even though truthfulness
 * (vs ground truth) might still be fine. It's the metric that isolates
 * "did the generator stay faithful to what retrieval found".
 *
 * Algorithm (paper §3.2):
 *   1. LLM extracts atomic claims from the answer.
 *   2. For each claim, LLM judges whether the retrieved context entails
 *      it (yes/no).
 *   3. Faithfulness = yes_count / total_claims.
 *
 * Score in [0, 1]. 1 = every claim in the answer is supported by some
 * retrieved chunk; 0 = all claims are hallucinated relative to retrieval.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';

const CLAIM_EXTRACT_SYSTEM = `Extract atomic factual CLAIMS from the given ANSWER. Each claim should be a self-contained factual statement — specific, checkable, no hedges. Opinions and filler sentences are not claims.

Reply with STRICT JSON:
{"claims": ["<claim 1>", "<claim 2>", ...]}

Rules:
- At most 12 claims.
- If the answer has no factual claims (pure opinion, meta-commentary), return {"claims": []}.`;

const VERIFY_SYSTEM = `For each STATEMENT, decide whether it is supported by the CONTEXT. A statement is SUPPORTED when the context directly states or clearly implies it. Paraphrase is fine; invention is not.

Reply with STRICT JSON:
{"verdicts": [{"statement": "<repeat the statement>", "supported": true|false, "evidence": "<short quote from context or empty>"}]}

Rules:
- One entry per input statement, IN ORDER.
- "supported" = false if the context is silent or contradicts.
- evidence ≤ 200 chars.`;

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, n));
}

async function extractClaims({ openai, answer, model = DEFAULT_MODEL }) {
  if (!openai || !answer) return [];
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0, max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: CLAIM_EXTRACT_SYSTEM },
        { role: 'user', content: text.slice(0, 6000) },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.claims)
      ? parsed.claims.map(c => String(c).slice(0, 300)).filter(Boolean).slice(0, 12)
      : [];
  } catch (err) {
    console.warn('[ragas/faithfulness] claim extraction failed:', err.message);
    return [];
  }
}

async function verifyClaims({ openai, claims, retrievedContexts, model = DEFAULT_MODEL }) {
  if (!openai || claims.length === 0) return [];
  const context = Array.isArray(retrievedContexts)
    ? retrievedContexts.map((c, i) => `[${i + 1}${c.source ? ' ' + c.source : ''}] ${String(c.text || c || '').slice(0, 600)}`).join('\n\n')
    : String(retrievedContexts || '');
  try {
    const resp = await openai.chat.completions.create({
      model, temperature: 0, max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: VERIFY_SYSTEM },
        { role: 'user', content: `CONTEXT:\n${context.slice(0, 10000)}\n\nSTATEMENTS:\n${claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}` },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.verdicts)) return claims.map(() => ({ supported: false, evidence: '' }));
    // Map verdicts back to claims by index. Be robust to missing entries.
    return claims.map((c, i) => {
      const v = parsed.verdicts[i];
      return {
        supported: !!v?.supported,
        evidence: String(v?.evidence || '').slice(0, 200),
      };
    });
  } catch (err) {
    console.warn('[ragas/faithfulness] verification failed:', err.message);
    return claims.map(() => ({ supported: false, evidence: '' }));
  }
}

/**
 * Compute faithfulness for a (question, answer, retrieved_contexts) triple.
 *
 * @returns {Promise<{
 *   score: number,         // faithfulness ∈ [0, 1]
 *   n_claims: number,
 *   supported_claims: number,
 *   claim_verdicts: [{ claim, supported, evidence }],
 * }>}
 */
async function compute({ openai, question, answer, retrievedContexts, model = DEFAULT_MODEL }) {
  const claims = await extractClaims({ openai, answer, model });
  if (claims.length === 0) {
    // No claims → nothing to verify. RAGAS paper treats this as 1
    // (vacuously faithful). Could flag as "insufficient" for dashboards.
    return {
      score: 1,
      n_claims: 0,
      supported_claims: 0,
      claim_verdicts: [],
      note: 'no factual claims extracted',
    };
  }
  const verdicts = await verifyClaims({ openai, claims, retrievedContexts, model });
  const supported = verdicts.filter(v => v.supported).length;
  return {
    score: supported / claims.length,
    n_claims: claims.length,
    supported_claims: supported,
    claim_verdicts: claims.map((c, i) => ({
      claim: c,
      supported: verdicts[i].supported,
      evidence: verdicts[i].evidence,
    })),
  };
}

module.exports = {
  compute,
  extractClaims,
  verifyClaims,
  CLAIM_EXTRACT_SYSTEM,
  VERIFY_SYSTEM,
};
